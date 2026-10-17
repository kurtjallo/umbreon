import { checksOf, stepsOf, type FrozenScenario, type NumberedCheck } from "./scenario.ts";

export type Evidence = { state: "captured"; file: string } | { state: "missing"; reason: string } | { state: "not_requested" };
export type Cause = "no_match" | "ambiguous" | "not_actionable" | "setup_failed" | "gone_rule" | "effect_rule" | "app_down" | "browser_error";

type At = { index: number; atMs: number; screenshot: Evidence };
export type FailedStep = At & { status: "failed"; expected: string; observed: string; aria: Evidence };
export type CouldNotRunStep = At & { status: "could_not_run"; cause: Cause; detail: string; aria: Evidence };
export type StepResult =
  | (At & { status: "passed" })
  | FailedStep
  | CouldNotRunStep
  | { status: "skipped"; index: number };

export type CheckRun = { checkId: string; steps: StepResult[]; video: Evidence; trace: Evidence; appLog: Evidence };

export type Stage = "repo" | "look" | "plan" | "rehearse" | "drive";
export type Halt =
  | { stage: "repo"; reason: "diff_does_not_apply"; detail: string }
  | { stage: "look"; reason: "app_never_ready"; detail: string }
  | { stage: "plan"; reason: "no_valid_plan"; problems: string[] }
  | { stage: Stage; reason: "interrupted" | "time_cap" };

type OutcomeBase = { checkId: string; claimId: string; it: string };
export type PassedOutcome = OutcomeBase & { result: "passed" };
export type Outcome =
  | PassedOutcome
  | (OutcomeBase & { result: "failed"; at: FailedStep })
  | (OutcomeBase & { result: "could_not_run"; at: CouldNotRunStep })
  | (OutcomeBase & { result: "could_not_run"; at: null; detail: string })
  | (OutcomeBase & { result: "evidence_missing"; missing: string[] });

export type Verdict =
  | { kind: "PROVEN"; commit: string; checks: PassedOutcome[] }
  | { kind: "NOT PROVEN"; commit: string | null; halt: Halt | null; checks: Outcome[] };

export type RunRecord = {
  runId: string;
  dir: string;
  caseDir: string;
  base: string | null;
  commit: string | null;
  imageId: string;
  scenario: FrozenScenario | null;
  uncovered: string[];
  runs: CheckRun[];
  verdict: Verdict;
  startedAt: string;
  finishedAt: string;
};

function outcomeOf(check: NumberedCheck, run: CheckRun | undefined): Outcome {
  const base = { checkId: check.id, claimId: check.claimId, it: check.it };
  if (!run) return { ...base, result: "could_not_run", at: null, detail: "no run was recorded for this check" };
  const missing: string[] = [];
  for (let index = 0; index < stepsOf(check).length; index++) {
    const at = run.steps.find((step) => step.index === index);
    if (!at) return { ...base, result: "could_not_run", at: null, detail: `no result was recorded for step ${index + 1}` };
    switch (at.status) {
      case "passed":
        if (at.screenshot.state !== "captured") missing.push(`screenshot of step ${index + 1}`);
        break;
      case "failed":
        return { ...base, result: "failed", at };
      case "could_not_run":
        return { ...base, result: "could_not_run", at };
      case "skipped":
        return { ...base, result: "could_not_run", at: null, detail: `step ${index + 1} was skipped before any step failed` };
    }
  }
  if (run.video.state !== "captured") missing.push("video");
  if (run.trace.state !== "captured") missing.push("trace");
  return missing.length > 0 ? { ...base, result: "evidence_missing", missing } : { ...base, result: "passed" };
}

const isPassed = (outcome: Outcome): outcome is PassedOutcome => outcome.result === "passed";

export function decide(input: {
  commit: string | null;
  halt: Halt | null;
  scenario: FrozenScenario | null;
  runs: readonly CheckRun[];
}): Verdict {
  const { commit, halt, scenario, runs } = input;
  const checks = scenario ? checksOf(scenario).map((check) => outcomeOf(check, runs.find((run) => run.checkId === check.id))) : [];
  const everyClaimHasACheck = scenario !== null && scenario.claims.length > 0 && scenario.claims.every((claim) => claim.checks.length > 0);
  if (halt === null && commit !== null && everyClaimHasACheck && checks.every(isPassed)) return { kind: "PROVEN", commit, checks };
  return { kind: "NOT PROVEN", commit, halt, checks };
}
