import { readFileSync } from "node:fs";
import { generateText, NoObjectGeneratedError, Output, TypeValidationError, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { CheckSchema, ScenarioSchema, planProblems, replaceChecks, type PlanSource, type Scenario, type UiReference } from "./scenario.ts";

export type PlannerInput = { prText: string; diff: string; ui: UiReference };
export type Usage = Extract<PlanSource, { kind: "model" }>["usage"];
export type PlanResult =
  | { ok: true; scenario: Scenario; calls: number; usage: Usage }
  | { ok: false; problems: string[]; calls: number; usage: Usage };
export type FailingCheck = { claimIndex: number; checkIndex: number; id: string; problem: string };
export type RepairResult = { ok: true; scenario: Scenario; usage: Usage } | { ok: false; problems: string[]; usage: Usage };

type Reply<T> = { ok: true; output: T; usage: Usage } | { ok: false; problems: string[]; usage: Usage };

const CALL_TIMEOUT_MS = 180_000;
const SKILL = new URL("../agent/skills/prove-change.md", import.meta.url);
const RepairSchema = z.strictObject({ checks: z.array(CheckSchema).min(1).max(24) });

export function systemPrompt(): string {
  return readFileSync(SKILL, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function renderPlannerInput({ prText, diff, ui }: PlannerInput): string {
  return [
    `# PR text\n${prText}`,
    `# Diff\n${diff}`,
    `# Accessibility snapshot of the start page\n${ui.ariaSnapshot}`,
    ...ui.files.map((file) => `# ${file.url}\n${file.text}`),
    ...(ui.truncated ? ["Some files the page loaded were cut short or left out to fit."] : []),
  ].join("\n\n");
}

const bullets = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join("\n");
const tokensOf = (usage?: LanguageModelUsage): Usage => ({ inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 });
const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

function replyProblems(error: NoObjectGeneratedError): string[] {
  const cause = TypeValidationError.isInstance(error.cause) ? error.cause.cause : undefined;
  if (!(cause instanceof z.core.$ZodError)) return [error.message];
  return cause.issues.map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`);
}

/** Throws only when the caller's signal aborts; every other failure comes back as problems the retry can show the model. */
async function ask<T>(model: LanguageModel, schema: z.ZodType<T>, prompt: string, signal: AbortSignal): Promise<Reply<T>> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  try {
    const result = await generateText({
      model,
      instructions: systemPrompt(),
      prompt,
      output: Output.object({ schema }),
      temperature: 0,
      abortSignal: AbortSignal.any([signal, timeout]),
    });
    return { ok: true, output: result.output, usage: tokensOf(result.usage) };
  } catch (error) {
    if (signal.aborted) throw error;
    if (timeout.aborted) return { ok: false, problems: [`the call took over ${CALL_TIMEOUT_MS / 1000} s and was cut off`], usage: tokensOf() };
    if (NoObjectGeneratedError.isInstance(error)) return { ok: false, problems: replyProblems(error), usage: tokensOf(error.usage) };
    return { ok: false, problems: [String(error instanceof Error ? error.message : error).split("\n")[0].slice(0, 300)], usage: tokensOf() };
  }
}

export async function planScenario(input: PlannerInput, model: LanguageModel, signal: AbortSignal): Promise<PlanResult> {
  const prompt = renderPlannerInput(input);
  let usage = tokensOf();
  let problems: string[] = [];
  for (let calls = 1; calls <= 2; calls++) {
    const feedback = problems.length ? `\n\nYour last answer was rejected:\n${bullets(problems)}` : "";
    const reply = await ask(model, ScenarioSchema, prompt + feedback, signal);
    usage = add(usage, reply.usage);
    problems = reply.ok ? planProblems(reply.output, input.prText) : reply.problems;
    if (reply.ok && problems.length === 0) return { ok: true, scenario: reply.output, calls, usage };
  }
  return { ok: false, problems, calls: 2, usage };
}

export async function repairChecks(
  input: PlannerInput,
  model: LanguageModel,
  scenario: Scenario,
  failing: readonly FailingCheck[],
  signal: AbortSignal,
): Promise<RepairResult> {
  const prompt = [
    renderPlannerInput(input),
    `# Your plan\n${JSON.stringify(scenario, null, 2)}`,
    `# These checks failed when rehearsed on the app as it was before this change, up to just before each "when" action\n${
      bullets(failing.map((f) => `${f.id} (claim ${f.claimIndex + 1}, check ${f.checkIndex + 1}): ${f.problem}`))}`,
    `Return exactly ${failing.length} replacement checks, in the order listed. Each one replaces only the check it is listed for. `
      + `Every other check stays as it is. Fix the setup steps that failed. Never delete setup a check needs. `
      + `Each check needs at least one "then" assertion that is false right before its "when" action. `
      + `A step that uses something this PR adds can fail on the old app, so keep it. `
      + `Expected values in "then" still come from the PR text only.`,
  ].join("\n\n");
  const reply = await ask(model, RepairSchema, prompt, signal);
  if (!reply.ok) return reply;
  const { checks } = reply.output;
  if (checks.length !== failing.length) {
    return { ok: false, problems: [`returned ${checks.length} checks, expected ${failing.length}`], usage: reply.usage };
  }
  const repaired = replaceChecks(scenario, failing, checks);
  const problems = planProblems(repaired, input.prText);
  return problems.length ? { ok: false, problems, usage: reply.usage } : { ok: true, scenario: repaired, usage: reply.usage };
}
