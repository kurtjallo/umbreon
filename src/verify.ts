import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { chromium } from "playwright";
import { AppNeverReady, DEMO_TODO, SetupError, loadCase, preflight, prepareApp, sweepOrphans, withApp } from "./app.ts";
import { lookAtApp, rehearseCheck, runCheck, type RehearsalProblem } from "./drive.ts";
import { openEventLog, relativeEvidence, stepEvent, summarizePlan, type CallPurpose, type RunEvent, type RunPhase, type Side } from "./events.ts";
import {
  planScenario, renderPlannerInput, renderSortInput, repairChecks, sortSentences, type CallObserver, type CallRecord, type FailingCheck, type PlannerInput,
} from "./planner.ts";
import { blockerLines, firstLine, renderReport, stepProblem } from "./report.ts";
import {
  ScenarioSchema, checksOf, freeze, planProblems, uncoveredSentences, type FrozenScenario, type NumberedCheck, type Scenario,
} from "./scenario.ts";
import {
  decide, failureBefore, outcomesOf, type CheckRun, type CouldNotRunStep, type FailedStep, type Halt, type RunRecord, type Stage,
} from "./verdict.ts";

export type PlanChoice = { kind: "model"; model: LanguageModel } | { kind: "file"; path: string };
export type VerifyOptions = { plan: PlanChoice; signal?: AbortSignal; runsDir?: string; onEvent?: (event: RunEvent) => void };

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** Where runs go unless `runsDir` says otherwise, so the dashboard reads the folder verify writes. */
export const RUNS_DIR = join(REPO, "runs");
const RUN_CAP_MS = 480_000;
const REPAIR_ROUNDS = 2;

const stopped = (step: CheckRun["steps"][number]): step is FailedStep | CouldNotRunStep => step.status === "failed" || step.status === "could_not_run";

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
  const problems = planProblems(parsed.data, prText, "file");
  return problems.length ? { ok: false, problems } : { ok: true, scenario: parsed.data };
}

/**
 * Runs one case from start to verdict. The order of the steps lives here, in code, and every step of it is written
 * to the run's event log as it happens. Throws only SetupError; every other outcome, an interrupt included, is a
 * RunRecord written to the run folder.
 */
export async function verify(caseDir: string, options: VerifyOptions): Promise<RunRecord> {
  const cap = AbortSignal.timeout(RUN_CAP_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, cap]) : cap;
  const planner = options.plan.kind === "model" ? options.plan : { ...options.plan, text: await readPlanFile(options.plan.path) };

  const startedAt = new Date();
  // preflight comes first so that Docker being down is a SetupError, not a failed sweep.
  const { imageId } = await preflight(DEMO_TODO);
  await sweepOrphans();
  const c = await loadCase(caseDir);
  const runId = newRunId(c.name, startedAt);
  const runDir = join(resolve(options.runsDir ?? RUNS_DIR), runId);
  await mkdir(runDir, { recursive: true });
  const events = openEventLog(runDir, options.onEvent);
  events.emit({ type: "run_started", runId, caseName: c.name, pid: process.pid, capMs: RUN_CAP_MS });

  let stage: Stage = "repo";
  const enter = (next: Stage) => {
    stage = next;
    events.emit({ type: "stage_started", stage: next });
  };
  let base: string | null = null;
  let commit: string | null = null;
  let scenario: FrozenScenario | null = null;
  const runs: CheckRun[] = [];
  const baseline: CheckRun[] = [];
  const calls: CallRecord[] = [];
  const observe = (purpose: CallPurpose): CallObserver => ({
    started: () => events.emit({ type: "model_call_started", purpose }),
    finished: (call) => {
      calls.push(call);
      events.emit({ type: "model_call", purpose, ...call });
    },
  });
  const emitPlan = (plan: Scenario, sha256: string | null) => events.emit({
    type: "plan", frozen: sha256 !== null, sha256,
    plan: summarizePlan(plan, { notTestable: plan.notTestable, uncovered: uncoveredSentences(plan, c.prText) }),
  });

  const finish = async (halt: Halt | null): Promise<RunRecord> => {
    const verdict = decide({ commit, halt, scenario, prText: c.prText, runs, baseline });
    const record: RunRecord = {
      runId, dir: runDir, caseDir: c.caseDir, base, commit, imageId, scenario,
      runs, baseline, verdict, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    };
    await writeFile(join(runDir, "run.json"), JSON.stringify(record, null, 2));
    await writeFile(join(runDir, "report.txt"), `${renderReport(record, runDir)}\n`);
    events.emit({
      type: "verdict", kind: verdict.kind, commit: verdict.commit,
      checks: verdict.checks.map(({ checkId, result }) => ({ checkId, result })),
      halt: halt && { stage: halt.stage, reason: halt.reason },
      reasons: verdict.kind === "PROVEN" ? [] : verdict.blockers.flatMap((blocker) => blockerLines(blocker, baseline)),
    });
    return record;
  };

  try {
    signal.throwIfAborted();
    enter("repo");
    const prepared = await prepareApp(c, runDir);
    base = prepared.ok ? prepared.old.commit : prepared.base;
    if (!prepared.ok) return await finish({ stage: "repo", reason: "diff_does_not_apply", detail: prepared.detail });
    commit = prepared.new.commit;
    events.emit({ type: "repo_ready", base, commit });

    // Playwright's own signal handlers close the browser mid-run, and its SIGINT handler then exits the process,
    // before the containers are removed and the record is written.
    const browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    try {
      enter("look");
      signal.throwIfAborted();
      let input: PlannerInput;
      try {
        const ui = await withApp(prepared.new.dir, DEMO_TODO, { runId, check: "look" }, signal, (app) => lookAtApp(browser, app, signal));
        input = { prText: c.prText, diff: prepared.diff, ui };
        events.emit({ type: "look_ready", files: ui.files.length, truncated: ui.truncated });
      } catch (error) {
        if (signal.aborted) throw error;
        return await finish({ stage: "look", reason: "app_never_ready", detail: error instanceof AppNeverReady ? error.logs : firstLine(error) });
      }

      let plan: Scenario;
      if (planner.kind === "model") {
        enter("sort");
        await writeFile(join(runDir, "sort-input.md"), renderSortInput(c.prText));
        const sorted = await sortSentences(c.prText, planner.model, signal, observe("sort"));
        if (!sorted.ok) return await finish({ stage: "sort", reason: "no_valid_sort", problems: sorted.problems });

        enter("plan");
        await writeFile(join(runDir, "planner-input.md"), renderPlannerInput(input, sorted.value));
        const planned = await planScenario(input, sorted.value, planner.model, signal, observe("plan"));
        if (!planned.ok) return await finish({ stage: "plan", reason: "no_valid_plan", problems: planned.problems });
        plan = planned.value;
      } else {
        // A plan file is a hand-written test input, so it keeps its own not-testable list and skips the sorter.
        enter("plan");
        const parsed = parsePlan(planner.text, planner.path, c.prText);
        if (!parsed.ok) return await finish({ stage: "plan", reason: "no_valid_plan", problems: parsed.problems });
        plan = parsed.scenario;
      }
      emitPlan(plan, null);

      enter("rehearse");
      const apps: Record<Side, { dir: string; prefix: string; name: string }> = {
        old: { dir: prepared.old.dir, prefix: "rehearse", name: "the app before this change" },
        new: { dir: prepared.new.dir, prefix: "rehearse-new", name: "the app with this change" },
      };
      const rehearseOn = async (side: Side, check: NumberedCheck): Promise<RehearsalProblem | null> => {
        events.emit({ type: "check_started", phase: "rehearse", side, checkId: check.id });
        const problem = await withApp(apps[side].dir, DEMO_TODO, { runId, check: `${apps[side].prefix}-${check.id}` }, signal, (app) => rehearseCheck(browser, app, check, signal))
          .catch((error): RehearsalProblem => {
            if (signal.aborted) throw error;
            const detail = error instanceof AppNeverReady ? `${apps[side].name} never answered` : `${apps[side].name} could not run: ${firstLine(error)}`;
            return { status: "could_not_run", cause: "app_down", detail, index: 0, text: detail };
          });
        const text = problem && (problem.status === "failed" ? problem.text : `${problem.cause.replace(/_/g, " ")}: ${problem.text}`);
        events.emit({ type: "check_finished", phase: "rehearse", side, checkId: check.id, ready: problem === null, problem: text });
        return problem;
      };
      // Repair cannot fix a missing new control or an absence the old app never shows, so those checks are kept. Neither
      // is proof. Proof is a "then" assertion that ran and failed. The new app can only stop a repair, never shape one.
      const addedByChange = (check: NumberedCheck, problem: RehearsalProblem) =>
        problem.status === "could_not_run"
        && (problem.cause === "gone_rule" || (problem.cause === "no_match" && problem.index >= check.given.length));
      // A stopped app says nothing about the check, so repair would rewrite a check that may be right. The drive stage decides it.
      const appDown = (problem: RehearsalProblem) => problem.status === "could_not_run" && problem.cause === "app_down";
      const rehearse = async (checks: readonly NumberedCheck[]): Promise<FailingCheck[]> => {
        const failing: FailingCheck[] = [];
        for (const check of checks) {
          signal.throwIfAborted();
          const problem = await rehearseOn("old", check);
          if (problem === null || appDown(problem)) continue;
          if (addedByChange(check, problem)) {
            const onNew = await rehearseOn("new", check);
            if (onNew === null || appDown(onNew)) continue;
          }
          failing.push({ claimIndex: check.claimIndex, checkIndex: check.checkIndex, id: check.id, problem: problem.text });
        }
        return failing;
      };
      let failing = await rehearse(checksOf(plan));
      for (let round = 1; planner.kind === "model" && failing.length > 0 && round <= REPAIR_ROUNDS; round++) {
        const repaired = await repairChecks(input, planner.model, plan, failing, signal, observe("repair"));
        if (!repaired.ok) break;
        plan = repaired.value;
        emitPlan(plan, null);
        const replaced = new Set(failing.map((f) => f.id));
        failing = await rehearse(checksOf(plan).filter((check) => replaced.has(check.id)));
      }

      const spent = (key: "inputTokens" | "outputTokens") => calls.reduce((total, call) => total + call[key], 0);
      scenario = freeze(plan, planner.kind === "model"
        ? {
          kind: "model", modelId: typeof planner.model === "string" ? planner.model : planner.model.modelId,
          calls: calls.length, usage: { inputTokens: spent("inputTokens"), outputTokens: spent("outputTokens") },
        }
        : { kind: "file", path: planner.path });
      await writeFile(join(runDir, "scenario.json"), JSON.stringify(scenario, null, 2));
      emitPlan(scenario, scenario.sha256);

      const runOn = async (phase: RunPhase, repoDir: string, check: NumberedCheck): Promise<CheckRun | null> => {
        signal.throwIfAborted();
        const name = phase === "drive" ? check.id : `baseline-${check.id}`;
        const out = phase === "drive" ? join(runDir, check.id) : join(runDir, "baseline", check.id);
        events.emit({ type: "check_started", phase, checkId: check.id });
        try {
          const run = await withApp(repoDir, DEMO_TODO, { runId, check: name }, signal, (app) =>
            runCheck(browser, app, check, out, signal, (step) => events.emit(stepEvent(phase, check.id, step, runDir))));
          const at = run.steps.find(stopped);
          events.emit({
            type: "check_finished", phase, checkId: check.id,
            result: at?.status ?? "passed", problem: at ? stepProblem(check, at) : null, video: relativeEvidence(run.video, runDir),
          });
          return run;
        } catch (error) {
          if (signal.aborted) throw error;
          const problem = error instanceof AppNeverReady ? "the app never answered" : firstLine(error);
          events.emit({ type: "check_finished", phase, checkId: check.id, result: "could_not_run", problem, video: null });
          return null;
        }
      };

      enter("drive");
      for (const check of checksOf(scenario)) {
        const run = await runOn("drive", prepared.new.dir, check);
        if (run) runs.push(run);
      }

      if (outcomesOf(scenario, runs).every((outcome) => outcome.result === "passed")) {
        enter("baseline");
        for (const check of checksOf(scenario)) {
          const run = await runOn("baseline", prepared.old.dir, check);
          if (run) baseline.push(run);
          if (run && failureBefore(check, run)) break;
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
