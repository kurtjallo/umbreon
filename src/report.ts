import { dirname, relative } from "node:path";
import type { RunEvent } from "./events.ts";
import { checksOf, describeLocator, stepsOf, type Check, type Step } from "./scenario.ts";
import type { Blocker, CheckRun, CouldNotRunStep, Evidence, FailedStep, FailsBefore, Halt, Outcome, RunRecord, Verdict } from "./verdict.ts";

export type Phase = "given" | "when" | "then";

export function phaseOf(check: Check, index: number): Phase {
  if (index < check.given.length) return "given";
  return index < check.given.length + check.when.length ? "when" : "then";
}

/** Names a step without its expected value, because the step's result carries that. */
export function describeStep(step: Step): string {
  switch (step.do) {
    case "goto": return `goto ${step.path}`;
    case "click": return `click ${describeLocator(step.target)}`;
    case "fill": return `fill ${describeLocator(step.target)} with ${JSON.stringify(step.value)}`;
    case "press": return step.target ? `press ${step.key} on ${describeLocator(step.target)}` : `press ${step.key}`;
    case "expect_visible":
    case "expect_absent":
    case "expect_count":
    case "expect_focus":
    case "expect_texts":
      return `${step.do} ${describeLocator(step.target)}`;
  }
}

/** Numbers a step within its phase, the way the plan lists it: `then step 1 expect_focus button "Delete Buy milk"`. */
export function stepName(check: Check, index: number): string {
  const phase = phaseOf(check, index);
  const first = phase === "given" ? 0 : phase === "when" ? check.given.length : check.given.length + check.when.length;
  return `${phase} step ${index - first + 1} ${describeStep(stepsOf(check)[index])}`;
}

export const firstLine = (error: unknown) => String(error instanceof Error ? error.message : error).split("\n")[0];

const MARK: Record<Outcome["result"], string> = { passed: "✅", failed: "❌", could_not_run: "⊘", evidence_missing: "⊘" };

const short = (sha: string) => sha.slice(0, 7);
export const tokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function header(record: RunRecord): string {
  const commit = record.commit ? `Commit ${short(record.commit)}` : "No commit";
  const scenario = record.scenario;
  if (!scenario) return `${commit} · no plan`;
  const source = scenario.source.kind === "model"
    ? `${scenario.source.modelId}, ${tokens(scenario.source.usage.inputTokens)} in / ${tokens(scenario.source.usage.outputTokens)} out`
    : `from ${scenario.source.path}`;
  return `${commit} · plan ${short(scenario.sha256)} (${source})`;
}

type Shown = { label: string; evidence: Evidence; suffix?: string };

/** Names the check's folder once, then each file in it: `evidence in runs/r/c1.1: 08.png · video.webm at 0:07 · ...`. */
function evidenceLine(run: CheckRun | undefined, at: FailedStep | CouldNotRunStep | null, cwd: string): string[] {
  const items: Shown[] = [
    ...(at ? [{ label: "screenshot", evidence: at.screenshot }, { label: "ARIA snapshot", evidence: at.aria }] : []),
    ...(run ? [
      { label: "video", evidence: run.video, suffix: at ? ` at ${clock(at.atMs)}` : "" },
      { label: "trace", evidence: run.trace },
      { label: "app log", evidence: run.appLog },
    ] : []),
  ];
  const files = items.flatMap(({ evidence }) => (evidence.state === "captured" ? [evidence.file] : []));
  const dir = files.length ? dirname(files[0]) : cwd;
  const shown = items.flatMap(({ label, evidence, suffix = "" }) => {
    switch (evidence.state) {
      case "captured": return [relative(dir, evidence.file) + suffix];
      case "missing": return [`no ${label} (${evidence.reason})`];
      case "not_requested": return [];
    }
  });
  if (!shown.length) return [];
  return [`   ${files.length ? `evidence in ${relative(cwd, dir)}: ` : ""}${shown.join(" · ")}`];
}

/** Names the step that stopped a check and what happened: `then step 2 expect_focus button "Delete Alpha": expected ..., saw ...`. */
export function stepProblem(check: Check, at: FailedStep | CouldNotRunStep): string {
  return at.status === "failed"
    ? `${stepName(check, at.index)}: expected ${at.expected}, saw ${at.observed}`
    : `${stepName(check, at.index)} could not run (${at.cause.replace("_", " ")}): ${at.detail}`;
}

const stepLine = (check: Check, at: FailedStep | CouldNotRunStep) => `   ${stepProblem(check, at)}`;

function outcomeLines(outcome: Outcome, check: Check, run: CheckRun | undefined, width: number, cwd: string): string[] {
  const head = `${MARK[outcome.result]} ${outcome.it.padEnd(width)}  [${outcome.checkId}]`;
  switch (outcome.result) {
    case "passed":
      return [head];
    case "failed":
      return [head, stepLine(check, outcome.at), ...evidenceLine(run, outcome.at, cwd)];
    case "could_not_run": {
      if (!outcome.at) return [head, `   could not run: ${outcome.detail}`, ...evidenceLine(run, null, cwd)];
      return [head, stepLine(check, outcome.at), ...evidenceLine(run, outcome.at, cwd)];
    }
    case "evidence_missing":
      return [head, `   passed, but evidence is missing: ${outcome.missing.join(", ")}`, ...evidenceLine(run, null, cwd)];
  }
}

function haltLines(halt: Halt): string[] {
  const indented = (text: string) => text.trimEnd().split("\n").map((line) => `   ${line}`);
  switch (halt.reason) {
    case "diff_does_not_apply": return ["Stopped: the change does not apply to the app.", ...indented(halt.detail)];
    case "app_never_ready": return ["Stopped: the app never answered.", ...indented(halt.detail)];
    case "no_valid_sort": return ["Stopped: the PR's sentences could not be sorted into testable and not testable.", ...halt.problems.map((problem) => `   - ${problem}`)];
    case "no_valid_plan": return ["Stopped: no valid plan.", ...halt.problems.map((problem) => `   - ${problem}`)];
    case "interrupted": return ["Stopped: interrupted."];
    case "time_cap": return ["Stopped: the run hit its time cap."];
  }
}

export function resultOf(run: CheckRun): string {
  const at = run.steps.find((step) => step.status !== "passed");
  return !at ? "passed" : at.status === "could_not_run" ? `could not run (${at.cause.replace("_", " ")})` : at.status;
}

/** Why a run is not proven, as the report shows it: the halt or blocker on one line, details indented under it. */
export function blockerLines(blocker: Blocker, baseline: readonly CheckRun[]): string[] {
  switch (blocker.reason) {
    case "halted":
      return haltLines(blocker.halt);
    case "check_did_not_pass":
      // The lines for each check and the final count already say which checks did not pass.
      return [];
    case "unaccounted_sentences":
      return [
        "Not proven: these PR sentences are neither checked nor marked not testable.",
        ...blocker.sentences.map((sentence) => `   - ${sentence}`),
      ];
    case "no_check_fails_before":
      return [
        "Not proven: no check fails on the app before this change, so nothing shows the change makes a difference.",
        `   on the app before this change: ${baseline.length ? baseline.map((run) => `${run.checkId} ${resultOf(run)}`).join(", ") : "no check ran"}`,
      ];
  }
}

function failsBeforeLines(failsBefore: FailsBefore, check: Check, run: CheckRun | undefined, cwd: string): string[] {
  return [
    `${failsBefore.checkId} fails on the app before this change, so the change makes a difference.`,
    stepLine(check, failsBefore.at),
    ...evidenceLine(run, failsBefore.at, cwd),
  ];
}

function finalLine(verdict: Verdict): string {
  const n = verdict.checks.length;
  const forCommit = verdict.commit ? ` for ${short(verdict.commit)}` : "";
  if (verdict.kind === "PROVEN") return `PROVEN${forCommit}: ${n} of ${n} checks passed`;
  const count = (result: Outcome["result"]) => verdict.checks.filter((outcome) => outcome.result === result).length;
  const missing = count("evidence_missing");
  return `NOT PROVEN${forCommit}: ${count("passed")} of ${n} passed, ${count("failed")} failed, ${count("could_not_run")} could not run`
    + (missing ? `, ${missing} missing evidence` : "");
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function rehearseLine(event: Extract<RunEvent, { type: "check_finished"; phase: "rehearse" }>): string {
  if (event.ready) return `rehearse ${event.checkId}: ${event.side === "old" ? "ready" : "needs something this change adds; kept"}`;
  return `rehearse ${event.checkId}: not ready on the app ${event.side === "old" ? "before" : "with"} this change (${event.problem})`;
}

/** The one line `umbreon verify` prints for an event while a run goes, or null for events only the dashboard shows. */
export function lineOf(event: RunEvent): string | null {
  switch (event.type) {
    case "run_started": return `run ${event.runId}`;
    case "repo_ready": return `repo: old ${short(event.base)}, changed ${short(event.commit)}`;
    case "look_ready": return `look: ${event.files} files${event.truncated ? ", cut short" : ""}`;
    case "model_call_started": return `${event.purpose}: asking the model`;
    case "model_call": {
      const spent = `${seconds(event.ms)}, ${tokens(event.inputTokens)} in / ${tokens(event.outputTokens)} out`;
      if (event.ok) return `${event.purpose}: answered in ${spent}`;
      const kept = event.purpose === "repair" ? "; keeping the plan as it is" : "";
      return `${event.purpose}: answer rejected after ${spent} (${event.problems[0]})${kept}`;
    }
    case "plan": {
      if (event.frozen) return null;
      const checks = event.plan.claims.reduce((n, claim) => n + claim.checks.length, 0);
      const notTestable = event.plan.notTestable.length;
      return `plan: ${event.plan.claims.length} claims, ${checks} checks${notTestable ? `, ${notTestable} sentence${notTestable === 1 ? "" : "s"} not testable` : ""}`;
    }
    case "check_finished":
      if (event.phase === "rehearse") return rehearseLine(event);
      return `${event.phase} ${event.checkId}: ${event.result.replace(/_/g, " ")}${event.problem ? `, ${event.problem}` : ""}`;
    case "verdict": return `decide: ${event.kind}${event.halt ? ` (${event.halt.stage}: ${event.halt.reason})` : ""}`;
    case "stage_started":
    case "check_started":
    case "step":
      return null;
  }
}

/** The text `umbreon verify` prints. Evidence paths are shown relative to `cwd`. */
export function renderReport(record: RunRecord, cwd: string): string {
  const checks = record.scenario ? checksOf(record.scenario) : [];
  const checkOf = (id: string) => {
    const check = checks.find((c) => c.id === id);
    if (!check) throw new Error(`verdict names check ${id}, which is not in the plan`);
    return check;
  };
  const { verdict } = record;
  const width = Math.max(0, ...verdict.checks.map((outcome) => outcome.it.length));
  const lines = [header(record)];
  for (const outcome of verdict.checks) {
    lines.push(...outcomeLines(outcome, checkOf(outcome.checkId), record.runs.find((run) => run.checkId === outcome.checkId), width, cwd));
  }
  const notTestable = record.scenario?.notTestable ?? [];
  if (notTestable.length) lines.push("Not testable:", ...notTestable.flatMap((note) => [`   - ${JSON.stringify(note.quote)}`, `     ${note.reason}`]));
  if (verdict.kind === "PROVEN") {
    const { failsBefore } = verdict;
    lines.push(...failsBeforeLines(failsBefore, checkOf(failsBefore.checkId), record.baseline.find((run) => run.checkId === failsBefore.checkId), cwd));
  } else {
    lines.push(...verdict.blockers.flatMap((blocker) => blockerLines(blocker, record.baseline)));
  }
  lines.push(finalLine(verdict));
  return lines.join("\n");
}
