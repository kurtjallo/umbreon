import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ScenarioSchema, checksOf, freeze, stepsOf, type NumberedCheck } from "./scenario.ts";
import { decide, type CheckRun, type Evidence, type StepResult, type Verdict } from "./verdict.ts";

const good = freeze(
  ScenarioSchema.parse(JSON.parse(readFileSync(new URL("../scripts/fixtures/demo-todo-good.json", import.meta.url), "utf8"))),
  { kind: "file", path: "scripts/fixtures/demo-todo-good.json" },
);
const commit = "8e41c07";
const captured = (file: string): Evidence => ({ state: "captured", file });
const lastIndex = (check: NumberedCheck) => stepsOf(check).length - 1;

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
const couldNotRun = (index: number): StepResult => ({
  status: "could_not_run", index, atMs: 0, screenshot: captured("step.png"), cause: "no_match", detail: "no visible match", aria: captured("step.aria.yml"),
});
function stopAt(run: CheckRun, stop: StepResult): CheckRun {
  return {
    ...run,
    steps: run.steps.map((step) => (step.index < stop.index ? step : step.index === stop.index ? stop : { status: "skipped", index: step.index })),
  };
}
const results = (verdict: Verdict) => Object.fromEntries(verdict.checks.map((outcome) => [outcome.checkId, outcome.result]));

test("PROVEN when every frozen check passed with every screenshot, the video and the trace", () => {
  const verdict = decide({ commit, halt: null, scenario: good, runs: allPassing() });
  assert.equal(verdict.kind, "PROVEN");
  assert.deepEqual(results(verdict), { "c1.1": "passed", "c2.1": "passed", "c3.1": "passed", "c4.1": "passed" });
});

test("NOT PROVEN when a frozen check has no run, even though every run that exists passed", () => {
  const verdict = decide({ commit, halt: null, scenario: good, runs: allPassing().slice(1) });
  assert.ok(verdict.kind === "NOT PROVEN");
  assert.deepEqual(verdict.checks[0], {
    checkId: "c1.1", claimId: "c1", it: good.claims[0].checks[0].it, result: "could_not_run", at: null, detail: "no run was recorded for this check",
  });
});

test("NOT PROVEN when a run has no result for one of the frozen steps", () => {
  const runs = allPassing();
  runs[2].steps.pop();
  assert.equal(results(decide({ commit, halt: null, scenario: good, runs }))["c3.1"], "could_not_run");
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
    const verdict = decide({ commit, halt: null, scenario: good, runs });
    assert.ok(verdict.kind === "NOT PROVEN", what);
    assert.deepEqual(verdict.checks[0], { checkId: "c1.1", claimId: "c1", it: good.claims[0].checks[0].it, result: "evidence_missing", missing: [what] });
  }
});

test("NOT PROVEN when the run halted, even if every check passed", () => {
  const verdict = decide({ commit, halt: { stage: "drive", reason: "interrupted" }, scenario: good, runs: allPassing() });
  assert.equal(verdict.kind, "NOT PROVEN");
  const noPlan = decide({ commit, halt: { stage: "plan", reason: "no_valid_plan", problems: ["claim 1: bad quote"] }, scenario: null, runs: [] });
  assert.deepEqual(noPlan, { kind: "NOT PROVEN", commit, halt: { stage: "plan", reason: "no_valid_plan", problems: ["claim 1: bad quote"] }, checks: [] });
});

test("NOT PROVEN for a plan with no checks, so checking nothing never passes", () => {
  const source = { kind: "file", path: "empty.json" } as const;
  assert.equal(decide({ commit, halt: null, scenario: freeze({ claims: [] }, source), runs: [] }).kind, "NOT PROVEN");
  const claimWithoutChecks = { quote: "Delete still removes only the task you clicked.", it: "It should remove only one task.", checks: [] };
  assert.equal(decide({ commit, halt: null, scenario: freeze({ claims: [claimWithoutChecks] }, source), runs: [] }).kind, "NOT PROVEN");
});

test("the first step that did not pass decides between failed and could not run", () => {
  const [c1, , c3] = checksOf(good);
  const runs = allPassing();
  runs[0] = stopAt(runs[0], failed(lastIndex(c1)));
  runs[1] = stopAt(runs[1], couldNotRun(0));
  runs[2] = { ...runs[2], steps: runs[2].steps.map((step) => (step.index === 1 ? couldNotRun(1) : step.index === lastIndex(c3) ? failed(step.index) : step)) };
  runs[3] = { ...runs[3], steps: runs[3].steps.map((step) => (step.index === 1 ? { status: "skipped", index: 1 } : step)) };
  const verdict = decide({ commit, halt: null, scenario: good, runs });
  assert.ok(verdict.kind === "NOT PROVEN");
  assert.deepEqual(results(verdict), { "c1.1": "failed", "c2.1": "could_not_run", "c3.1": "could_not_run", "c4.1": "could_not_run" });
  const setupFailure = verdict.checks[1];
  assert.ok(setupFailure.result === "could_not_run" && setupFailure.at !== null);
  assert.equal(setupFailure.at.cause, "no_match");
});
