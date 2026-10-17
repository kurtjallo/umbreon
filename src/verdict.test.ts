import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ScenarioSchema, checksOf, freeze, sentencesOf, stepsOf, type NumberedCheck } from "./scenario.ts";
import { decide, type Cause, type CheckRun, type Evidence, type Halt, type StepResult, type Verdict } from "./verdict.ts";

const good = freeze(
  ScenarioSchema.parse(JSON.parse(readFileSync(new URL("../scripts/fixtures/demo-todo-good.json", import.meta.url), "utf8"))),
  { kind: "file", path: "scripts/fixtures/demo-todo-good.json" },
);
const prText = readFileSync(new URL("../practice/demo-todo/prs/delete-correct/pr.md", import.meta.url), "utf8");
const commit = "8e41c07";
const captured = (file: string): Evidence => ({ state: "captured", file });
const lastIndex = (check: NumberedCheck) => stepsOf(check).length - 1;
const [c1, c2] = checksOf(good);

function passingRun(check: NumberedCheck): CheckRun {
  return {
    checkId: check.id,
    steps: stepsOf(check).map((_, index) => ({ status: "passed", index, atMs: index * 100, screenshot: captured(`${check.id}/${index}.png`) })),
    video: captured(`${check.id}/video.webm`),
    trace: captured(`${check.id}/trace.zip`),
    appLog: captured(`${check.id}/app.log`),
  };
}
const allPassing = () => checksOf(good).map(passingRun);

const failed = (index: number): StepResult => ({
  status: "failed", index, atMs: 0, screenshot: captured("step.png"), expected: '"Buy milk"', observed: '"Walk dog"', aria: captured("step.aria.yml"),
});
const couldNotRun = (index: number, cause: Cause = "no_match"): StepResult => ({
  status: "could_not_run", index, atMs: 0, screenshot: captured("step.png"), cause, detail: "no visible match", aria: captured("step.aria.yml"),
});
function stopAt(run: CheckRun, stop: StepResult): CheckRun {
  return {
    ...run,
    steps: run.steps.map((step) => (step.index < stop.index ? step : step.index === stop.index ? stop : { status: "skipped", index: step.index })),
  };
}
const results = (verdict: Verdict) => Object.fromEntries(verdict.checks.map((outcome) => [outcome.checkId, outcome.result]));
const blockersOf = (verdict: Verdict) => (verdict.kind === "NOT PROVEN" ? verdict.blockers : []);

/** c1.1 passes on the app before the change too, and c2.1 fails there at its focus assertion. */
const differs = () => [passingRun(c1), stopAt(passingRun(c2), failed(lastIndex(c2)))];
const verdictOf = (input: Partial<Parameters<typeof decide>[0]>) =>
  decide({ commit, halt: null, scenario: good, prText, runs: allPassing(), baseline: differs(), ...input });

test("PROVEN when every check passed with its evidence and one check fails on the app before the change", () => {
  const verdict = verdictOf({});
  assert.ok(verdict.kind === "PROVEN");
  assert.deepEqual(results(verdict), { "c1.1": "passed", "c2.1": "passed", "c3.1": "passed", "c4.1": "passed" });
  assert.deepEqual(verdict.failsBefore, { checkId: "c2.1", at: failed(lastIndex(c2)) });
});

test("PROVEN when a when step has nothing to act on before the change, because the change adds it", () => {
  const verdict = verdictOf({ baseline: [stopAt(passingRun(c1), couldNotRun(c1.given.length))] });
  assert.ok(verdict.kind === "PROVEN");
  assert.equal(verdict.failsBefore.checkId, "c1.1");
});

test("NOT PROVEN when nothing fails before the change: passing there too, setup failures, code rules, or a dead app or browser", () => {
  const whenAt = c2.given.length;
  const variants: [string, CheckRun][] = [
    ["passes there too", passingRun(c2)],
    ["a setup assertion did not hold", stopAt(passingRun(c2), couldNotRun(4, "setup_failed"))],
    ["a setup step had nothing to act on", stopAt(passingRun(c2), couldNotRun(1, "no_match"))],
    ["the gone rule", stopAt(passingRun(c2), couldNotRun(whenAt, "gone_rule"))],
    ["the effect rule", stopAt(passingRun(c2), couldNotRun(whenAt, "effect_rule"))],
    ["the app stopped", stopAt(passingRun(c2), couldNotRun(lastIndex(c2), "app_down"))],
    ["the browser died", stopAt(passingRun(c2), couldNotRun(lastIndex(c2), "browser_error"))],
  ];
  for (const [what, run] of variants) {
    const verdict = verdictOf({ baseline: [passingRun(c1), run] });
    assert.equal(verdict.kind, "NOT PROVEN", what);
    assert.deepEqual(blockersOf(verdict), [{ reason: "no_check_fails_before" }], what);
  }
  assert.deepEqual(blockersOf(verdictOf({ baseline: [] })), [{ reason: "no_check_fails_before" }], "no baseline run");
});

test("NOT PROVEN when a PR sentence is neither claimed nor marked not testable, even with a check that fails before", () => {
  const verdict = verdictOf({ scenario: freeze({ claims: good.claims, notTestable: [] }, good.source) });
  assert.deepEqual(blockersOf(verdict), [{ reason: "unaccounted_sentences", sentences: [sentencesOf(prText)[0]] }]);
});

test("NOT PROVEN when a frozen check has no run, even though every run that exists passed", () => {
  const verdict = verdictOf({ runs: allPassing().slice(1) });
  assert.ok(verdict.kind === "NOT PROVEN");
  assert.deepEqual(verdict.blockers, [{ reason: "check_did_not_pass" }]);
  assert.deepEqual(verdict.checks[0], {
    checkId: "c1.1", claimId: "c1", it: good.claims[0].checks[0].it, result: "could_not_run", at: null, detail: "no run was recorded for this check",
  });
});

test("NOT PROVEN when a run has no result for one of the frozen steps", () => {
  const runs = allPassing();
  runs[2].steps.pop();
  assert.equal(results(verdictOf({ runs }))["c3.1"], "could_not_run");
});

test("NOT PROVEN when a screenshot, the video or the trace was not captured", () => {
  const missing: [string, (run: CheckRun) => void][] = [
    ["screenshot of step 2", (run) => { run.steps[1] = { status: "passed", index: 1, atMs: 100, screenshot: { state: "missing", reason: "page closed" } }; }],
    ["video", (run) => { run.video = { state: "missing", reason: "ffmpeg failed" }; }],
    ["trace", (run) => { run.trace = { state: "not_requested" }; }],
  ];
  for (const [what, breakEvidence] of missing) {
    const runs = allPassing();
    breakEvidence(runs[0]);
    const verdict = verdictOf({ runs });
    assert.ok(verdict.kind === "NOT PROVEN", what);
    assert.deepEqual(verdict.checks[0], { checkId: "c1.1", claimId: "c1", it: good.claims[0].checks[0].it, result: "evidence_missing", missing: [what] });
  }
});

test("NOT PROVEN when the run halted, even if every check passed and one fails before the change", () => {
  const halt = { stage: "baseline", reason: "interrupted" } as const;
  assert.deepEqual(blockersOf(verdictOf({ halt })), [{ reason: "halted", halt }]);
  const noPlan: Halt = { stage: "plan", reason: "no_valid_plan", problems: ["claim 1: bad quote"] };
  assert.deepEqual(verdictOf({ halt: noPlan, scenario: null, runs: [], baseline: [] }), {
    kind: "NOT PROVEN", commit, checks: [], blockers: [{ reason: "halted", halt: noPlan }],
  });
});

test("NOT PROVEN for a plan with no checks, so checking nothing never passes", () => {
  const source = { kind: "file", path: "empty.json" } as const;
  const empty = verdictOf({ scenario: freeze({ claims: [], notTestable: [] }, source), runs: [], baseline: [] });
  assert.deepEqual(blockersOf(empty), [{ reason: "unaccounted_sentences", sentences: sentencesOf(prText) }, { reason: "no_check_fails_before" }]);
  const claimWithoutChecks = { quote: "Delete still removes only the task you clicked.", it: "It should remove only one task.", checks: [] };
  const notTestable = sentencesOf(prText).slice(0, 4).map((quote) => ({ quote, reason: "Not about deleting." }));
  const hollow = verdictOf({ scenario: freeze({ claims: [claimWithoutChecks], notTestable }, source), runs: [], baseline: [] });
  assert.deepEqual(blockersOf(hollow), [
    { reason: "unaccounted_sentences", sentences: ["Delete still removes only the task you clicked."] },
    { reason: "no_check_fails_before" },
  ]);
});

test("the first step that did not pass decides between failed and could not run", () => {
  const [, , c3] = checksOf(good);
  const runs = allPassing();
  runs[0] = stopAt(runs[0], failed(lastIndex(c1)));
  runs[1] = stopAt(runs[1], couldNotRun(0));
  runs[2] = { ...runs[2], steps: runs[2].steps.map((step) => (step.index === 1 ? couldNotRun(1) : step.index === lastIndex(c3) ? failed(step.index) : step)) };
  runs[3] = { ...runs[3], steps: runs[3].steps.map((step) => (step.index === 1 ? { status: "skipped", index: 1 } : step)) };
  const verdict = verdictOf({ runs });
  assert.ok(verdict.kind === "NOT PROVEN");
  assert.deepEqual(results(verdict), { "c1.1": "failed", "c2.1": "could_not_run", "c3.1": "could_not_run", "c4.1": "could_not_run" });
  assert.deepEqual(verdict.blockers, [{ reason: "check_did_not_pass" }]);
  const setupFailure = verdict.checks[1];
  assert.ok(setupFailure.result === "could_not_run" && setupFailure.at !== null);
  assert.equal(setupFailure.at.cause, "no_match");
});
