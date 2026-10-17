import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { chromium } from "playwright";
import { AppNeverReady, DEMO_TODO, SetupError, loadCase, preflight, prepareApp, sweepOrphans, withApp } from "./app.ts";
import { lookAtApp, rehearseCheck, runCheck } from "./drive.ts";
import { planScenario, renderPlannerInput, repairChecks, type FailingCheck, type PlannerInput, type Usage } from "./planner.ts";
import { renderReport } from "./report.ts";
import { ScenarioSchema, checksOf, freeze, planProblems, uncoveredSentences, type FrozenScenario, type NumberedCheck, type Scenario } from "./scenario.ts";
import { decide, type CheckRun, type Halt, type RunRecord, type Stage } from "./verdict.ts";

export type PlanChoice = { kind: "model"; model: LanguageModel } | { kind: "file"; path: string };
export type VerifyOptions = { plan: PlanChoice; signal?: AbortSignal; runsDir?: string; log?: (line: string) => void };

const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN_CAP_MS = 480_000;
const REPAIR_ROUNDS = 2;

const firstLine = (error: unknown) => String(error instanceof Error ? error.message : error).split("\n")[0];
const short = (sha: string) => sha.slice(0, 7);

/** The model from agent/agent.ts, so the model id has one source. Reads .env.local first, because the key lives there. */
export async function plannerModel(): Promise<LanguageModel> {
  const envFile = join(REPO, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.OPENROUTER_API_KEY) throw new SetupError("OPENROUTER_API_KEY is not set. Add it to .env.local, or pass --scenario <file>.");
  return (await import("../agent/agent.ts")).default.model;
}

function newRunId(caseName: string, at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  // The random part keeps parallel runs of one case apart; the run id also names Docker containers.
  return `${stamp}-${caseName.replace(/[^\w.-]/g, "_")}-${randomBytes(2).toString("hex")}`;
}

async function readPlanFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new SetupError(`could not read the plan ${path}: ${firstLine(error)}`);
  }
}

function parsePlan(text: string, path: string, prText: string): { ok: true; scenario: Scenario } | { ok: false; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [`${path} is not JSON: ${firstLine(error)}`] };
  }
  const parsed = ScenarioSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`) };
  const problems = planProblems(parsed.data, prText);
  return problems.length ? { ok: false, problems } : { ok: true, scenario: parsed.data };
}

function resultOf(run: CheckRun): string {
  return run.steps.find((step) => step.status !== "passed")?.status.replace(/_/g, " ") ?? "passed";
}

/**
 * Runs one case from start to verdict. The order of the steps lives here, in code.
 * Throws only SetupError; every other outcome, an interrupt included, is a RunRecord written to the run folder.
 */
export async function verify(caseDir: string, options: VerifyOptions): Promise<RunRecord> {
  const log = options.log ?? (() => {});
  const cap = AbortSignal.timeout(RUN_CAP_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, cap]) : cap;
  const planner = options.plan.kind === "model" ? options.plan : { ...options.plan, text: await readPlanFile(options.plan.path) };

  const startedAt = new Date();
  // preflight comes first so that Docker being down is a SetupError, not a failed sweep.
  const { imageId } = await preflight(DEMO_TODO);
  await sweepOrphans();
  const c = await loadCase(caseDir);
  const runId = newRunId(c.name, startedAt);
  const runDir = join(resolve(options.runsDir ?? join(REPO, "runs")), runId);
  log(`run ${runId}`);

  let stage: Stage = "repo";
  let base: string | null = null;
  let commit: string | null = null;
  let scenario: FrozenScenario | null = null;
  const runs: CheckRun[] = [];

  const finish = async (halt: Halt | null): Promise<RunRecord> => {
    const verdict = decide({ commit, halt, scenario, runs });
    const record: RunRecord = {
      runId, dir: runDir, caseDir: c.caseDir, base, commit, imageId, scenario,
      uncovered: scenario ? uncoveredSentences(scenario, c.prText) : [],
      runs, verdict, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    };
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), JSON.stringify(record, null, 2));
    await writeFile(join(runDir, "report.txt"), `${renderReport(record, runDir)}\n`);
    log(`decide: ${verdict.kind}${halt ? ` (${halt.stage}: ${halt.reason})` : ""}`);
    return record;
  };

  try {
    signal.throwIfAborted();
    const prepared = await prepareApp(c, runDir);
    base = prepared.ok ? prepared.old.commit : prepared.base;
    if (!prepared.ok) return await finish({ stage: "repo", reason: "diff_does_not_apply", detail: prepared.detail });
    commit = prepared.new.commit;
    log(`repo: old ${short(base)}, changed ${short(commit)}`);

    // Playwright's own SIGINT handler exits the process before the containers are removed and the record is written.
    const browser = await chromium.launch({ handleSIGINT: false });
    try {
      stage = "look";
      signal.throwIfAborted();
      let input: PlannerInput;
      try {
        const ui = await withApp(prepared.new.dir, DEMO_TODO, { runId, check: "look" }, signal, (app) => lookAtApp(browser, app));
        input = { prText: c.prText, diff: prepared.diff, ui };
        log(`look: ${ui.files.length} files${ui.truncated ? ", cut short" : ""}`);
      } catch (error) {
        if (signal.aborted) throw error;
        return await finish({ stage: "look", reason: "app_never_ready", detail: error instanceof AppNeverReady ? error.logs : firstLine(error) });
      }

      stage = "plan";
      let plan: Scenario;
      let calls = 0;
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      if (planner.kind === "model") {
        await writeFile(join(runDir, "planner-input.md"), renderPlannerInput(input));
        const planned = await planScenario(input, planner.model, signal);
        calls = planned.calls;
        usage = planned.usage;
        if (!planned.ok) return await finish({ stage: "plan", reason: "no_valid_plan", problems: planned.problems });
        plan = planned.scenario;
      } else {
        const parsed = parsePlan(planner.text, planner.path, c.prText);
        if (!parsed.ok) return await finish({ stage: "plan", reason: "no_valid_plan", problems: parsed.problems });
        plan = parsed.scenario;
      }
      log(`plan: ${plan.claims.length} claims, ${checksOf(plan).length} checks${planner.kind === "model" ? `, ${calls} calls` : ""}`);

      stage = "rehearse";
      const rehearse = async (checks: readonly NumberedCheck[]): Promise<FailingCheck[]> => {
        const failing: FailingCheck[] = [];
        for (const check of checks) {
          signal.throwIfAborted();
          const problem = await withApp(prepared.old.dir, DEMO_TODO, { runId, check: `rehearse-${check.id}` }, signal,
            (app) => rehearseCheck(browser, app, check)).catch((error) => {
            if (signal.aborted) throw error;
            return error instanceof AppNeverReady ? "the app before this change never answered" : firstLine(error);
          });
          if (problem !== null) failing.push({ claimIndex: check.claimIndex, checkIndex: check.checkIndex, id: check.id, problem });
        }
        return failing;
      };
      let failing = await rehearse(checksOf(plan));
      log(`rehearse: ${failing.length ? `failing ${failing.map((f) => f.id).join(", ")}` : "every check is ready"}`);
      for (let round = 1; planner.kind === "model" && failing.length > 0 && round <= REPAIR_ROUNDS; round++) {
        const repaired = await repairChecks(input, planner.model, plan, failing, signal);
        calls++;
        usage = { inputTokens: usage.inputTokens + repaired.usage.inputTokens, outputTokens: usage.outputTokens + repaired.usage.outputTokens };
        if (!repaired.ok) {
          log(`repair ${round}: rejected, keeping the plan as it is (${repaired.problems[0]})`);
          break;
        }
        plan = repaired.scenario;
        const replaced = new Set(failing.map((f) => f.id));
        failing = await rehearse(checksOf(plan).filter((check) => replaced.has(check.id)));
        log(`repair ${round}: ${failing.length ? `still failing ${failing.map((f) => f.id).join(", ")}` : "every check is ready"}`);
      }

      scenario = freeze(plan, planner.kind === "model"
        ? { kind: "model", modelId: typeof planner.model === "string" ? planner.model : planner.model.modelId, calls, usage }
        : { kind: "file", path: planner.path });
      await writeFile(join(runDir, "scenario.json"), JSON.stringify(scenario, null, 2));

      stage = "drive";
      for (const check of checksOf(scenario)) {
        signal.throwIfAborted();
        try {
          const run = await withApp(prepared.new.dir, DEMO_TODO, { runId, check: check.id }, signal,
            (app) => runCheck(browser, app, check, join(runDir, check.id)));
          runs.push(run);
          log(`drive ${check.id}: ${resultOf(run)}`);
        } catch (error) {
          if (signal.aborted) throw error;
          log(`drive ${check.id}: could not run, ${error instanceof AppNeverReady ? "the app never answered" : firstLine(error)}`);
        }
      }
      return await finish(null);
    } finally {
      await browser.close();
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    return finish({ stage, reason: options.signal?.aborted ? "interrupted" : "time_cap" });
  }
}
