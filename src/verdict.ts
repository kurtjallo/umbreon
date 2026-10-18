import { checksOf, sentencesOf, stepsOf, uncoveredSentences, type Check, type FrozenScenario, type NumberedCheck, type Scenario } from "./scenario.ts";

export type Evidence = { state: "captured"; file: string } | { state: "missing"; reason: string } | { state: "not_requested" };
export type Cause = "no_match" | "ambiguous" | "not_actionable" | "setup_failed" | "gone_rule" | "effect_rule" | "app_down" | "browser_error" | "page_hung";

type At = { index: number; atMs: number; screenshot: Evidence };
export type FailedStep = At & { status: "failed"; expected: string; observed: string; aria: Evidence };
export type CouldNotRunStep = At & { status: "could_not_run"; cause: Cause; detail: string; aria: Evidence };
export type StepResult =
  | (At & { status: "passed" })
  | FailedStep
  | CouldNotRunStep
  | { status: "skipped"; index: number };

export type CheckRun = { checkId: string; steps: StepResult[]; video: Evidence; trace: Evidence; appLog: Evidence };

export type Stage = "repo" | "look" | "sort" | "plan" | "rehearse" | "drive" | "baseline";
export type Halt =
  | { stage: "repo"; reason: "diff_does_not_apply"; detail: string }
  | { stage: "look"; reason: "app_never_ready"; detail: string }
  | { stage: "sort"; reason: "no_valid_sort"; problems: string[] }
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

/** One reason a run is not proven. PROVEN means there is none. */
export type Blocker =
  | { reason: "halted"; halt: Halt }
  | { reason: "check_did_not_pass" }
  | { reason: "unaccounted_sentences"; sentences: string[] }
  | { reason: "no_check_fails_before" };

/** The step where a frozen check fails on the app before the change, which shows the change makes a difference. */
export type FailsBefore = { checkId: string; at: FailedStep | CouldNotRunStep };

export type Verdict =
  | { kind: "PROVEN"; commit: string; checks: PassedOutcome[]; failsBefore: FailsBefore }
  | { kind: "NOT PROVEN"; commit: string | null; checks: Outcome[]; blockers: Blocker[] };

export type RunRecord = {
  runId: string;
  dir: string;
  caseDir: string;
  base: string | null;
  commit: string | null;
  imageId: string;
  scenario: FrozenScenario | null;
  runs: CheckRun[];
  /** The frozen checks run on the app before the change, in order, up to the first that fails there. */
  baseline: CheckRun[];
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

export function outcomesOf(scenario: Scenario, runs: readonly CheckRun[]): Outcome[] {
  return checksOf(scenario).map((check) => outcomeOf(check, runs.find((run) => run.checkId === check.id)));
}

type Stopped = { index: number } & ({ status: "failed" } | { status: "could_not_run"; cause: Cause });

/**
 * Whether a step that stopped a check on the app before the change shows the behavior differed: a "then" assertion
 * that ran and failed. A missing target does not. A new control and a renamed field miss the same way, and crediting
 * the miss let a rename prove a promise the old app already kept.
 */
export function showsChangeAdds(check: Check, step: Stopped): boolean {
  return step.status === "failed" && step.index >= check.given.length + check.when.length;
}

/** The first step that did not pass, when it shows the app before the change lacks what the change adds. */
export function failureBefore(check: Check, run: CheckRun): FailedStep | CouldNotRunStep | null {
  const at = run.steps.find((step) => step.status !== "passed");
  return (at?.status === "failed" || at?.status === "could_not_run") && showsChangeAdds(check, at) ? at : null;
}

function firstFailureBefore(scenario: Scenario, baseline: readonly CheckRun[]): FailsBefore | null {
  for (const check of checksOf(scenario)) {
    const run = baseline.find((r) => r.checkId === check.id);
    const at = run ? failureBefore(check, run) : null;
    if (at) return { checkId: check.id, at };
  }
  return null;
}

export function decide(input: {
  commit: string | null;
  halt: Halt | null;
  scenario: FrozenScenario | null;
  prText: string;
  runs: readonly CheckRun[];
  baseline: readonly CheckRun[];
}): Verdict {
  const { commit, halt, scenario, prText, runs, baseline } = input;
  const checks = scenario ? outcomesOf(scenario, runs) : [];
  // A halted run is unfinished, so whatever else it lacks follows from the halt.
  if (halt) return { kind: "NOT PROVEN", commit, checks, blockers: [{ reason: "halted", halt }] };

  const blockers: Blocker[] = [];
  const unaccounted = scenario ? uncoveredSentences(scenario, prText) : sentencesOf(prText);
  if (unaccounted.length) blockers.push({ reason: "unaccounted_sentences", sentences: unaccounted });
  const passed = checks.filter(isPassed);
  const failsBefore = scenario ? firstFailureBefore(scenario, baseline) : null;
  if (passed.length < checks.length) blockers.push({ reason: "check_did_not_pass" });
  else if (!failsBefore) blockers.push({ reason: "no_check_fails_before" });

  if (blockers.length || !failsBefore || commit === null) return { kind: "NOT PROVEN", commit, checks, blockers };
  return { kind: "PROVEN", commit, checks: passed, failsBefore };
}
