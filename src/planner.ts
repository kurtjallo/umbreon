import { readFileSync } from "node:fs";
import { generateText, NoObjectGeneratedError, Output, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import {
  CheckSchema, NotTestableSchema, ScenarioSchema, planProblems, replaceChecks, sentencesOf,
  type NotTestable, type PlanSource, type Scenario, type UiReference,
} from "./scenario.ts";

export type PlannerInput = { prText: string; diff: string; ui: UiReference };
export type Usage = Extract<PlanSource, { kind: "model" }>["usage"];
/** What a model's answer came to after at most two calls, and what both calls spent. */
export type Attempt<T> =
  | { ok: true; value: T; calls: number; usage: Usage }
  | { ok: false; problems: string[]; calls: number; usage: Usage };
export type FailingCheck = { claimIndex: number; checkIndex: number; id: string; problem: string };
export type RepairResult = { ok: true; scenario: Scenario; usage: Usage } | { ok: false; problems: string[]; usage: Usage };

/** A file in agent/skills that becomes a call's instructions. */
export type Skill = "prove-change" | "sort-sentences";

type Reply<T> = { ok: true; output: T; usage: Usage } | { ok: false; problems: string[]; usage: Usage };
type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const CALL_TIMEOUT_MS = 180_000;
const RepairSchema = z.strictObject({ checks: z.array(CheckSchema).min(1).max(24) });
const PlanReplySchema = z.strictObject({ claims: ScenarioSchema.shape.claims });
const SortReplySchema = z.strictObject({
  notTestable: z.array(z.strictObject({ sentence: z.int().min(1), reason: NotTestableSchema.shape.reason })).max(40),
});
export type SortReply = z.infer<typeof SortReplySchema>;

export function systemPrompt(skill: Skill): string {
  return readFileSync(new URL(`../agent/skills/${skill}.md`, import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

const numbered = (sentences: readonly { n: number; text: string }[]) => sentences.map(({ n, text }) => `${n}. ${text}`).join("\n");

/** The sentences only. The sorter never sees the code, so it cannot excuse the promise a change breaks. */
export function renderSortInput(prText: string): string {
  return numbered(sentencesOf(prText).map((text, i) => ({ n: i + 1, text })));
}

export function renderPlannerInput({ prText, diff, ui }: PlannerInput, notTestable: readonly NotTestable[]): string {
  const reasons = new Map(notTestable.map((note) => [note.quote, note.reason]));
  const sentences = sentencesOf(prText).map((text, i) => ({ n: i + 1, text, reason: reasons.get(text) }));
  const toClaim = sentences.filter((sentence) => sentence.reason === undefined);
  const marked = sentences.filter((sentence) => sentence.reason !== undefined);
  return [
    `# PR text\n${prText}`,
    `# Sentences you must claim\n${toClaim.length ? numbered(toClaim) : "None."}`,
    `# Sentences marked not testable\n${marked.length ? marked.map(({ n, text, reason }) => `${n}. ${text}\n   Reason: ${reason}`).join("\n") : "None."}`,
    `# Diff\n${diff}`,
    `# Accessibility snapshot of the start page\n${ui.ariaSnapshot}`,
    ...ui.files.map((file) => `# ${file.url}\n${file.text}`),
    ...(ui.truncated ? ["Some files the page loaded were cut short or left out to fit."] : []),
  ].join("\n\n");
}

const bullets = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join("\n");
const tokensOf = (usage?: LanguageModelUsage): Usage => ({ inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

const issuesOf = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`);

/**
 * The schema goes in the instructions and zod checks the reply here. OpenRouter spreads a model over many servers,
 * and each enforces a response schema its own way: one turned setup actions into assertions, one rejected our regex.
 */
function instructionsFor(skill: Skill, schema: z.ZodType): string {
  return `${systemPrompt(skill)}\n\nReply with only one JSON object that matches this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema, { reused: "ref" }))}`;
}

/** Throws only when the caller's signal aborts; every other failure comes back as problems the retry can show the model. */
async function ask<T>(model: LanguageModel, skill: Skill, schema: z.ZodType<T>, prompt: string, signal: AbortSignal): Promise<Reply<T>> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  try {
    const result = await generateText({
      model,
      instructions: instructionsFor(skill, schema),
      prompt,
      output: Output.json(),
      temperature: 0,
      // At its default level DeepSeek sometimes thought for over 26,000 tokens, then answered with nothing.
      providerOptions: { openrouter: { reasoning: { effort: "medium" } } },
      abortSignal: AbortSignal.any([signal, timeout]),
    });
    const usage = tokensOf(result.usage);
    const parsed = schema.safeParse(result.output);
    return parsed.success ? { ok: true, output: parsed.data, usage } : { ok: false, problems: issuesOf(parsed.error), usage };
  } catch (error) {
    if (signal.aborted) throw error;
    if (timeout.aborted) return { ok: false, problems: [`the call took over ${CALL_TIMEOUT_MS / 1000} s and was cut off`], usage: tokensOf() };
    if (NoObjectGeneratedError.isInstance(error)) return { ok: false, problems: ["the reply was not one complete JSON object"], usage: tokensOf(error.usage) };
    return { ok: false, problems: [String(error instanceof Error ? error.message : error).split("\n")[0].slice(0, 300)], usage: tokensOf() };
  }
}

/** Asks at most twice. The second call shows the model why its first answer was rejected. */
async function askTwice<T, R>(
  model: LanguageModel,
  skill: Skill,
  schema: z.ZodType<T>,
  prompt: string,
  accept: (output: T) => Checked<R>,
  signal: AbortSignal,
): Promise<Attempt<R>> {
  let usage = tokensOf();
  let problems: string[] = [];
  for (let calls = 1; calls <= 2; calls++) {
    const feedback = problems.length ? `\n\nYour last answer was rejected:\n${bullets(problems)}` : "";
    const reply = await ask(model, skill, schema, prompt + feedback, signal);
    usage = addUsage(usage, reply.usage);
    const checked = reply.ok ? accept(reply.output) : reply;
    if (checked.ok) return { ok: true, value: checked.value, calls, usage };
    problems = checked.problems;
  }
  return { ok: false, problems, calls: 2, usage };
}

export function sortProblems(reply: SortReply, count: number): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  reply.notTestable.forEach(({ sentence }, i) => {
    if (sentence > count) problems.push(`notTestable ${i + 1}: there is no sentence ${sentence}; the sentences are numbered 1 to ${count}`);
    else if (seen.has(sentence)) problems.push(`notTestable ${i + 1}: sentence ${sentence} is listed more than once; list each sentence once`);
    seen.add(sentence);
  });
  return problems;
}

/** Picks the PR sentences that state nothing a user can see, from the sentences alone. Each comes back as its exact text. */
export async function sortSentences(prText: string, model: LanguageModel, signal: AbortSignal): Promise<Attempt<NotTestable[]>> {
  const sentences = sentencesOf(prText);
  return askTwice(model, "sort-sentences", SortReplySchema, renderSortInput(prText), (reply): Checked<NotTestable[]> => {
    const problems = sortProblems(reply, sentences.length);
    if (problems.length) return { ok: false, problems };
    const inOrder = [...reply.notTestable].sort((a, b) => a.sentence - b.sentence);
    return { ok: true, value: inOrder.map(({ sentence, reason }) => ({ quote: sentences[sentence - 1], reason })) };
  }, signal);
}

/** The model writes only claims. The not-testable sentences come from sortSentences, so the planner cannot excuse itself. */
export async function planScenario(
  input: PlannerInput,
  notTestable: readonly NotTestable[],
  model: LanguageModel,
  signal: AbortSignal,
): Promise<Attempt<Scenario>> {
  return askTwice(model, "prove-change", PlanReplySchema, renderPlannerInput(input, notTestable), ({ claims }): Checked<Scenario> => {
    const scenario: Scenario = { claims, notTestable };
    const problems = planProblems(scenario, input.prText, "model");
    return problems.length ? { ok: false, problems } : { ok: true, value: scenario };
  }, signal);
}

export async function repairChecks(
  input: PlannerInput,
  model: LanguageModel,
  scenario: Scenario,
  failing: readonly FailingCheck[],
  signal: AbortSignal,
): Promise<RepairResult> {
  const prompt = [
    renderPlannerInput(input, scenario.notTestable),
    `# Your plan\n${JSON.stringify(scenario, null, 2)}`,
    `# These checks failed when rehearsed on the app as it was before this change, up to just before each "when" action\n${
      bullets(failing.map((f) => `${f.id} (claim ${f.claimIndex + 1}, check ${f.checkIndex + 1}): ${f.problem}`))}`,
    `Return exactly ${failing.length} replacement checks, in the order listed. Each one replaces only the check it is listed for. `
      + `Every other check stays as it is. Fix the setup steps that failed. Never delete setup a check needs. `
      + `Each check needs at least one "then" assertion that is false right before its "when" action. `
      + `A missing target is not proof. Do not move a step onto a name this PR adds. If a step uses a control this PR renames, use the name from before the change. An assertion about a new control belongs in "then". `
      + `Expected values in "then" still come from the PR text only.`,
  ].join("\n\n");
  const reply = await ask(model, "prove-change", RepairSchema, prompt, signal);
  if (!reply.ok) return reply;
  const { checks } = reply.output;
  if (checks.length !== failing.length) {
    return { ok: false, problems: [`returned ${checks.length} checks, expected ${failing.length}`], usage: reply.usage };
  }
  const repaired = replaceChecks(scenario, failing, checks);
  const problems = planProblems(repaired, input.prText, "model");
  return problems.length ? { ok: false, problems, usage: reply.usage } : { ok: true, scenario: repaired, usage: reply.usage };
}
