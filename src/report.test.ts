import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PlanSummary, RunEvent, RunEventBody } from "./events.ts";
import { lineOf, renderReport } from "./report.ts";
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

const at = <T extends RunEventBody>(seq: number, body: T): RunEvent => ({ ...body, seq, at: "2026-10-18T10:00:00Z" });
const summary: PlanSummary = {
  claims: [
    { id: "c1", quote: "q1", it: "i1", checks: [{ id: "c1.1", it: "x", steps: [] }, { id: "c1.2", it: "y", steps: [] }] },
    { id: "c2", quote: "q2", it: "i2", checks: [{ id: "c2.1", it: "z", steps: [] }] },
  ],
  notTestable: [{ quote: "History.", reason: "History: how it was." }],
  uncovered: [],
};

test("lineOf prints the lines verify used to log, one per event, and nothing for the events only the dashboard shows", () => {
  const lines = [
    at(1, { type: "run_started", runId: "20261018-100000-delete-bug-ab12", caseName: "delete-bug", pid: 7, capMs: 480_000 }),
    at(2, { type: "stage_started", stage: "repo" }),
    at(3, { type: "repo_ready", base: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", commit: COMMIT }),
    at(4, { type: "look_ready", files: 3, truncated: true }),
    at(5, { type: "model_call_started", purpose: "sort" }),
    at(6, { type: "model_call", purpose: "sort", ok: true, ms: 12_340, inputTokens: 1234, outputTokens: 56, problems: [] }),
    at(7, { type: "model_call", purpose: "plan", ok: false, ms: 90_000, inputTokens: 20_000, outputTokens: 900, problems: ["claim 1: bad quote", "claim 2: bad quote"] }),
    at(8, { type: "plan", frozen: false, sha256: null, plan: summary }),
    at(9, { type: "plan", frozen: false, sha256: null, plan: { ...summary, notTestable: [] } }),
    at(10, { type: "plan", frozen: true, sha256: "abc", plan: summary }),
    at(11, { type: "check_started", phase: "rehearse", side: "old", checkId: "c1.1" }),
    at(12, { type: "check_finished", phase: "rehearse", side: "old", checkId: "c1.1", ready: true, problem: null }),
    at(13, { type: "check_finished", phase: "rehearse", side: "old", checkId: "c1.2", ready: false, problem: 'no match: when step 1 click button "Clear completed": nothing matched' }),
    at(14, { type: "check_finished", phase: "rehearse", side: "new", checkId: "c1.2", ready: true, problem: null }),
    at(15, { type: "check_finished", phase: "rehearse", side: "new", checkId: "c2.1", ready: false, problem: "the start page did not load: boom" }),
    at(16, { type: "model_call", purpose: "repair", ok: false, ms: 5000, inputTokens: 100, outputTokens: 10, problems: ["returned 1 checks, expected 2"] }),
    at(17, { type: "check_started", phase: "drive", checkId: "c1.1" }),
    at(18, { type: "step", phase: "drive", checkId: "c1.1", index: 0, status: "passed", atMs: 100, detail: null, screenshot: "c1.1/01.png" }),
    at(19, { type: "check_finished", phase: "drive", checkId: "c1.1", result: "failed", problem: 'then step 2 expect_focus button "Delete Alpha": expected focus on button "Delete Alpha", saw focus on button "Delete Beta"', video: "c1.1/video.webm" }),
    at(20, { type: "check_finished", phase: "baseline", checkId: "c1.1", result: "passed", problem: null, video: "baseline/c1.1/video.webm" }),
    at(21, { type: "check_finished", phase: "drive", checkId: "c2.1", result: "could_not_run", problem: "the app never answered", video: null }),
    at(22, { type: "verdict", kind: "NOT PROVEN", commit: COMMIT, checks: [], halt: { stage: "look", reason: "app_never_ready" }, reasons: ["Stopped: the app never answered."] }),
    at(23, { type: "verdict", kind: "PROVEN", commit: COMMIT, checks: [{ checkId: "c1.1", result: "passed" }], halt: null, reasons: [] }),
  ].map(lineOf);
  assert.deepEqual(lines, [
    "run 20261018-100000-delete-bug-ab12",
    null,
    "repo: old 0f1e2d3, changed 8e41c07",
    "look: 3 files, cut short",
    "sort: asking the model",
    "sort: answered in 12.3 s, 1.2k in / 56 out",
    "plan: answer rejected after 90.0 s, 20.0k in / 900 out (claim 1: bad quote)",
    "plan: 2 claims, 3 checks, 1 sentence not testable",
    "plan: 2 claims, 3 checks",
    null,
    null,
    "rehearse c1.1: ready",
    'rehearse c1.2: not ready on the app before this change (no match: when step 1 click button "Clear completed": nothing matched)',
    "rehearse c1.2: needs something this change adds; kept",
    "rehearse c2.1: not ready on the app with this change (the start page did not load: boom)",
    "repair: answer rejected after 5.0 s, 100 in / 10 out (returned 1 checks, expected 2); keeping the plan as it is",
    null,
    null,
    'drive c1.1: failed, then step 2 expect_focus button "Delete Alpha": expected focus on button "Delete Alpha", saw focus on button "Delete Beta"',
    "baseline c1.1: passed",
    "drive c2.1: could not run, the app never answered",
    "decide: NOT PROVEN (look: app_never_ready)",
    "decide: PROVEN",
  ]);
});
