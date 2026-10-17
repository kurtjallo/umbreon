import { dirname, relative } from "node:path";
import { checksOf, describeLocator, stepsOf, type Check, type Step } from "./scenario.ts";
import type { CheckRun, CouldNotRunStep, Evidence, FailedStep, Halt, Outcome, RunRecord, Verdict } from "./verdict.ts";

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

const MARK: Record<Outcome["result"], string> = { passed: "✅", failed: "❌", could_not_run: "⊘", evidence_missing: "⊘" };

const short = (sha: string) => sha.slice(0, 7);
const tokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
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

function outcomeLines(outcome: Outcome, check: Check, run: CheckRun | undefined, width: number, cwd: string): string[] {
  const head = `${MARK[outcome.result]} ${outcome.it.padEnd(width)}  [${outcome.checkId}]`;
  switch (outcome.result) {
    case "passed":
      return [head];
    case "failed": {
      const { at } = outcome;
      return [head, `   ${stepName(check, at.index)}: expected ${at.expected}, saw ${at.observed}`, ...evidenceLine(run, at, cwd)];
    }
    case "could_not_run": {
      if (!outcome.at) return [head, `   could not run: ${outcome.detail}`, ...evidenceLine(run, null, cwd)];
      const { at } = outcome;
      return [head, `   ${stepName(check, at.index)} could not run (${at.cause.replace("_", " ")}): ${at.detail}`, ...evidenceLine(run, at, cwd)];
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
    case "no_valid_plan": return ["Stopped: no valid plan.", ...halt.problems.map((problem) => `   - ${problem}`)];
    case "interrupted": return ["Stopped: interrupted."];
    case "time_cap": return ["Stopped: the run hit its time cap."];
  }
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

/** The text `umbreon verify` prints. Evidence paths are shown relative to `cwd`. */
export function renderReport(record: RunRecord, cwd: string): string {
  const checks = record.scenario ? checksOf(record.scenario) : [];
  const width = Math.max(0, ...record.verdict.checks.map((outcome) => outcome.it.length));
  const lines = [header(record)];
  for (const outcome of record.verdict.checks) {
    const check = checks.find((c) => c.id === outcome.checkId);
    if (!check) throw new Error(`verdict names check ${outcome.checkId}, which is not in the plan`);
    lines.push(...outcomeLines(outcome, check, record.runs.find((run) => run.checkId === outcome.checkId), width, cwd));
  }
  if (record.uncovered.length) lines.push("Not checked:", ...record.uncovered.map((sentence) => `   - ${sentence}`));
  if (record.verdict.kind === "NOT PROVEN" && record.verdict.halt) lines.push(...haltLines(record.verdict.halt));
  lines.push(finalLine(record.verdict));
  return lines.join("\n");
}
