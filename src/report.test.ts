import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderReport } from "./report.ts";
import { ScenarioSchema, checksOf, freeze, stepsOf, type FrozenScenario, type NumberedCheck, type PlanSource } from "./scenario.ts";
import { decide, type CheckRun, type Evidence, type Halt, type RunRecord, type StepResult } from "./verdict.ts";

const CWD = "/work";
const RUN_DIR = "/work/runs/r1";
const COMMIT = "8e41c07d2b9a4f0e8c1d3b5a7f9e2c4d6b8a0f1e";
const DEEPSEEK: PlanSource = { kind: "model", modelId: "deepseek/deepseek-v4.1-flash", calls: 1, usage: { inputTokens: 4200, outputTokens: 9800 } };
const PR_TEXT = readFileSync(new URL("../practice/demo-todo/prs/delete-correct/pr.md", import.meta.url), "utf8");
const NOT_TESTABLE = [
  "Not testable:",
  '   - "After you delete a task, focus used to jump to the task list box, so keyboard users had to tab back to where they were."',
  "     History: how focus moved before this change, not what the changed app does.",
];

const plan = (name: string) => freeze(
  ScenarioSchema.parse(JSON.parse(readFileSync(new URL(`../scripts/fixtures/demo-todo-${name}.json`, import.meta.url), "utf8"))),
  DEEPSEEK,
);
const file = (check: NumberedCheck, name: string, dir = RUN_DIR): Evidence => ({ state: "captured", file: `${dir}/${check.id}/${name}` });
const png = (index: number) => `${String(index + 1).padStart(2, "0")}.png`;

function passingRun(check: NumberedCheck, dir = RUN_DIR): CheckRun {
  return {
    checkId: check.id,
    steps: stepsOf(check).map((_, index) => ({ status: "passed", index, atMs: index * 800, screenshot: file(check, png(index), dir) })),
    video: file(check, "video.webm", dir),
    trace: file(check, "trace.zip", dir),
    appLog: file(check, "app.log", dir),
  };
}

function stopAt(run: CheckRun, stop: StepResult): CheckRun {
  return {
    ...run,
    steps: run.steps.map((step) => (step.index < stop.index ? step : step.index === stop.index ? stop : { status: "skipped", index: step.index })),
  };
}

const BASELINE_DIR = `${RUN_DIR}/baseline`;

/** The good plan's c2.1 on the app before the change: focus stays on the task list box. */
function focusFailsBefore(good: FrozenScenario): CheckRun {
  const c2 = checksOf(good)[1];
  return stopAt(passingRun(c2, BASELINE_DIR), {
    status: "failed", index: 7, atMs: 4800, screenshot: file(c2, "08.png", BASELINE_DIR), aria: file(c2, "08.aria.yml", BASELINE_DIR),
    expected: 'focus on button "Delete Buy milk"', observed: 'focus on group "Tasks"',
  });
}

function recordOf(
  scenario: FrozenScenario | null, runs: CheckRun[], halt: Halt | null = null, commit: string | null = COMMIT, baseline: CheckRun[] = [],
): RunRecord {
  return {
    runId: "r1", dir: RUN_DIR, caseDir: "/work/practice/demo-todo/prs/delete-bug", base: "0f1e2d3", commit, imageId: "sha256:abc",
    scenario, runs, baseline, verdict: decide({ commit, halt, scenario, prText: PR_TEXT, runs, baseline }),
    startedAt: "2026-10-16T19:04:11Z", finishedAt: "2026-10-16T19:05:02Z",
  };
}

test("PROVEN: one line per check, each not-testable sentence with its reason, and the check that fails before the change", () => {
  const good = plan("good");
  assert.equal(renderReport(recordOf(good, checksOf(good).map((check) => passingRun(check)), null, COMMIT, [focusFailsBefore(good)]), CWD), [
    "Commit 8e41c07 · plan 6c35462 (deepseek/deepseek-v4.1-flash, 4.2k in / 9.8k out)",
    "✅ It should remove only Walk dog when you delete it.               [c1.1]",
    "✅ It should focus Delete Buy milk after deleting Walk dog.         [c2.1]",
    "✅ It should focus Delete Walk dog after deleting Buy milk.         [c3.1]",
    "✅ It should focus the task list box after deleting the only task.  [c4.1]",
    ...NOT_TESTABLE,
    "c2.1 fails on the app before this change, so the change makes a difference.",
    '   then step 1 expect_focus button "Delete Buy milk": expected focus on button "Delete Buy milk", saw focus on group "Tasks"',
    "   evidence in runs/r1/baseline/c2.1: 08.png · 08.aria.yml · video.webm at 0:04 · trace.zip · app.log",
    "PROVEN for 8e41c07: 4 of 4 checks passed",
  ].join("\n"));
});

test("NOT PROVEN for what decide refused: a PR sentence unaccounted for, and no check failing before the change", () => {
  const good = plan("good");
  const lazy = freeze({ claims: good.claims.slice(0, 1), notTestable: [] }, DEEPSEEK);
  const [c1] = checksOf(lazy);
  assert.equal(renderReport(recordOf(lazy, [passingRun(c1)], null, COMMIT, [passingRun(c1, BASELINE_DIR)]), CWD), [
    `Commit 8e41c07 · plan ${lazy.sha256.slice(0, 7)} (deepseek/deepseek-v4.1-flash, 4.2k in / 9.8k out)`,
    "✅ It should remove only Walk dog when you delete it.  [c1.1]",
    "Not proven: these PR sentences are neither checked nor marked not testable.",
    "   - After you delete a task, focus used to jump to the task list box, so keyboard users had to tab back to where they were.",
    "   - Now focus moves to the Delete button of the next task.",
    "   - If you deleted the last task in the list, it moves to the previous task instead.",
    "   - If the list is now empty, focus goes to the task list box as before.",
    "Not proven: no check fails on the app before this change, so nothing shows the change makes a difference.",
    "   on the app before this change: c1.1 passed",
    "NOT PROVEN for 8e41c07: 1 of 1 passed, 0 failed, 0 could not run",
  ].join("\n"));
});

test("NOT PROVEN with a failure: the step, expected against observed, and evidence paths with the video offset", () => {
  const good = plan("good");
  const [c1] = checksOf(good);
  const runs = checksOf(good).map((check) => passingRun(check));
  runs[0] = stopAt(runs[0], {
    status: "failed", index: 7, atMs: 6400, screenshot: file(c1, "08.png"), aria: file(c1, "08.aria.yml"),
    expected: '"Buy milk"', observed: '"Walk dog"',
  });
  assert.equal(renderReport(recordOf(good, runs), CWD), [
    "Commit 8e41c07 · plan 6c35462 (deepseek/deepseek-v4.1-flash, 4.2k in / 9.8k out)",
    "❌ It should remove only Walk dog when you delete it.               [c1.1]",
    '   then step 1 expect_texts css ".task-title": expected "Buy milk", saw "Walk dog"',
    "   evidence in runs/r1/c1.1: 08.png · 08.aria.yml · video.webm at 0:06 · trace.zip · app.log",
    "✅ It should focus Delete Buy milk after deleting Walk dog.         [c2.1]",
    "✅ It should focus Delete Walk dog after deleting Buy milk.         [c3.1]",
    "✅ It should focus the task list box after deleting the only task.  [c4.1]",
    ...NOT_TESTABLE,
    "NOT PROVEN for 8e41c07: 3 of 4 passed, 1 failed, 0 could not run",
  ].join("\n"));
});

test("could not run: the cause and detail, a check with no run, and a passed check whose video is missing", () => {
  const typo = plan("typo");
  const [c1] = checksOf(typo);
  const runs = checksOf(typo).map((check) => passingRun(check));
  runs[0] = stopAt(runs[0], {
    status: "could_not_run", index: 5, atMs: 61_200, screenshot: file(c1, "06.png"), aria: { state: "missing", reason: "page crashed" },
    cause: "gone_rule",
    detail: 'then step 1 expect_absent text "Walk Dog" expects something gone, but nothing matched it before the "when" steps, so its absence would prove nothing',
  });
  runs[1] = { ...runs[1], video: { state: "missing", reason: "ffmpeg failed" } };
  runs.splice(2, 1);
  assert.equal(renderReport(recordOf(typo, runs), CWD), [
    `Commit 8e41c07 · plan ${typo.sha256.slice(0, 7)} (deepseek/deepseek-v4.1-flash, 4.2k in / 9.8k out)`,
    "⊘ It should remove only Walk dog when you delete it.               [c1.1]",
    '   when step 1 click button "Delete Walk dog" could not run (gone rule): then step 1 expect_absent text "Walk Dog" expects something gone, but nothing matched it before the "when" steps, so its absence would prove nothing',
    "   evidence in runs/r1/c1.1: 06.png · no ARIA snapshot (page crashed) · video.webm at 1:01 · trace.zip · app.log",
    "⊘ It should focus Delete Buy milk after deleting Walk dog.         [c2.1]",
    "   passed, but evidence is missing: video",
    "   evidence in runs/r1/c2.1: no video (ffmpeg failed) · trace.zip · app.log",
    "⊘ It should focus Delete Walk dog after deleting Buy milk.         [c3.1]",
    "   could not run: no run was recorded for this check",
    "✅ It should focus the task list box after deleting the only task.  [c4.1]",
    ...NOT_TESTABLE,
    "NOT PROVEN for 8e41c07: 1 of 4 passed, 0 failed, 2 could not run, 1 missing evidence",
  ].join("\n"));
});

test("halt: the reason the run stopped, with no plan and no commit", () => {
  const noPlan: Halt = { stage: "plan", reason: "no_valid_plan", problems: ['claim 1: "quote" is not in any sentence of the PR text; copy it exactly from one sentence'] };
  assert.equal(renderReport(recordOf(null, [], noPlan), CWD), [
    "Commit 8e41c07 · no plan",
    "Stopped: no valid plan.",
    '   - claim 1: "quote" is not in any sentence of the PR text; copy it exactly from one sentence',
    "NOT PROVEN for 8e41c07: 0 of 0 passed, 0 failed, 0 could not run",
  ].join("\n"));

  const unsorted: Halt = { stage: "sort", reason: "no_valid_sort", problems: ["notTestable 1: there is no sentence 9; the sentences are numbered 1 to 5"] };
  assert.equal(renderReport(recordOf(null, [], unsorted), CWD), [
    "Commit 8e41c07 · no plan",
    "Stopped: the PR's sentences could not be sorted into testable and not testable.",
    "   - notTestable 1: there is no sentence 9; the sentences are numbered 1 to 5",
    "NOT PROVEN for 8e41c07: 0 of 0 passed, 0 failed, 0 could not run",
  ].join("\n"));

  const stale: Halt = { stage: "repo", reason: "diff_does_not_apply", detail: "error: patch failed: public/app.js:1\nerror: public/app.js: patch does not apply\n" };
  assert.equal(renderReport(recordOf(null, [], stale, null), CWD), [
    "No commit · no plan",
    "Stopped: the change does not apply to the app.",
    "   error: patch failed: public/app.js:1",
    "   error: public/app.js: patch does not apply",
    "NOT PROVEN: 0 of 0 passed, 0 failed, 0 could not run",
  ].join("\n"));
});
