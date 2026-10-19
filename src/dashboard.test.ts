import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, suite, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { byteRange, serveDashboard, viewOf, type Dashboard, type DashboardPayload, type HaltView, type RunView } from "./dashboard.ts";
import { EVENTS_FILE, type CallPurpose, type PlanSummary, type RunEvent, type RunEventBody, type Side } from "./events.ts";
import type { Outcome, Stage, Verdict } from "./verdict.ts";

const T0 = Date.parse("2026-10-17T12:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);
const timelineFrom = (t0: number, entries: [number, RunEventBody][]): RunEvent[] =>
  entries.map(([sec, body], i) => ({ ...body, seq: i + 1, at: new Date(t0 + sec * 1000).toISOString() }));
const timeline = (...entries: [number, RunEventBody][]) => timelineFrom(T0, entries);

const started: RunEventBody = { type: "run_started", runId: "r1", caseName: "delete-bug", pid: 42, capMs: 480_000 };
const steps = (...texts: string[]) => texts.map((text, i) => ({ phase: i === 0 ? "given" as const : i === 1 ? "when" as const : "then" as const, text }));
const PLAN: PlanSummary = {
  claims: [
    { id: "c1", quote: "Focus moves to the next task.", it: "Focus moves on.", checks: [{ id: "c1.1", it: "It should focus the next Delete button.", steps: steps('fill textbox "Title" with "Alpha"', 'click button "Delete Alpha"', 'expect_focus button "Delete Beta"') }] },
    { id: "c2", quote: "Delete removes only the clicked task.", it: "Only one goes.", checks: [{ id: "c2.1", it: "It should keep the other tasks.", steps: steps('fill textbox "Title" with "Gamma"', 'click button "Delete Gamma"', 'expect_texts css ".task-title"') }] },
  ],
  notTestable: [{ quote: "This was reported by a keyboard user.", reason: "history, not a promise" }],
  uncovered: ["Focus used to jump to the list."],
};
const REPAIRED: PlanSummary = {
  ...PLAN,
  claims: [PLAN.claims[0], { ...PLAN.claims[1], checks: [{ ...PLAN.claims[1].checks[0], steps: steps('fill textbox "Title" with "Gamma"', 'click button "Delete Gamma"', 'expect_count css ".task-title"') }] }],
};

const call = (purpose: CallPurpose, ms: number, ok = true, problems: string[] = []): RunEventBody =>
  ({ type: "model_call", purpose, ok, ms, inputTokens: 100, outputTokens: 50, problems });
const asking = (purpose: CallPurpose): RunEventBody => ({ type: "model_call_started", purpose });
const startRehearsal = (checkId: string, side: Side = "old"): RunEventBody => ({ type: "check_started", phase: "rehearse", side, checkId });
const endRehearsal = (checkId: string, side: Side, ready: boolean, problem: string | null = null): RunEventBody => ({ type: "check_finished", phase: "rehearse", side, checkId, ready, problem });
const verdictOf = (kind: Verdict["kind"], checks: { checkId: string; result: Outcome["result"] }[], halt: HaltView | null = null, reasons: string[] = []): RunEventBody =>
  ({ type: "verdict", kind, commit: "405a283bbbb", checks, halt, reasons });

const looked: [number, RunEventBody][] = [
  [0, started],
  [0, { type: "stage_started", stage: "repo" }],
  [2, { type: "repo_ready", base: "3deb814aaaa", commit: "405a283bbbb" }],
  [2, { type: "stage_started", stage: "look" }],
  [5, { type: "look_ready", files: 12, truncated: false }],
];
const planned: [number, RunEventBody][] = [
  ...looked,
  [5, { type: "stage_started", stage: "sort" }],
  [5, asking("sort")],
  [10, call("sort", 5000)],
  [10, { type: "stage_started", stage: "plan" }],
  [10, asking("plan")],
  [40, call("plan", 30_000)],
  [44, { type: "plan", frozen: false, sha256: null, plan: PLAN }],
  [44, { type: "stage_started", stage: "rehearse" }],
];
/** `planned` up to and including the `stage_started plan`, before any plan call starts. */
const PLAN_STAGE_STARTED = 9;
const driving: [number, RunEventBody][] = [
  ...planned,
  [45, startRehearsal("c1.1")],
  [48, endRehearsal("c1.1", "old", true)],
  [48, startRehearsal("c2.1")],
  [51, endRehearsal("c2.1", "old", true)],
  [51, { type: "plan", frozen: true, sha256: "6acd9bf0000", plan: PLAN }],
  [51, { type: "stage_started", stage: "drive" }],
];
const step = (checkId: string, index: number, status: "passed" | "failed", atMs: number, phase: "drive" | "baseline" = "drive"): RunEventBody => ({
  type: "step", phase, checkId, index, status, atMs,
  detail: status === "failed" ? 'expected focus on button "Delete Beta", saw focus on button "Delete Alpha"' : null,
  screenshot: `${phase === "drive" ? "" : "baseline/"}${checkId}/${String(index + 1).padStart(2, "0")}.png`,
});

const checkOf = (view: RunView, id: string) => view.plan!.claims.flatMap((claim) => claim.checks).find((check) => check.id === id)!;
const stageOf = (view: RunView, stage: string) => view.stages.find((s) => s.stage === stage);

test("viewOf times each stage, counts the model calls made in it, and keeps what the look found", () => {
  const view = viewOf(timeline(...planned), at(50), true);
  assert.deepEqual(view.stages.map((s) => [s.stage, s.state, s.ms, s.calls]), [
    ["repo", "done", 2000, 0],
    ["look", "done", 3000, 0],
    ["sort", "done", 5000, 1],
    ["plan", "done", 34_000, 1],
    ["rehearse", "now", 6000, 0],
    ["drive", "todo", 0, 0],
  ]);
  assert.equal(view.stage, "rehearse");
  assert.equal(view.elapsedMs, 50_000);
  assert.equal(view.commit, "405a283bbbb");
  assert.deepEqual(view.look, { files: 12, truncated: false });
  assert.deepEqual(view.plan!.uncovered, ["Focus used to jump to the list."]);
  assert.deepEqual(view.plan!.notTestable, PLAN.notTestable);
});

test("totals add every call's tokens", () => {
  const totals = (...calls: [number, RunEventBody][]) => viewOf(timeline([0, started], ...calls), at(20), true).totals;
  assert.deepEqual(totals([10, call("plan", 1000, false, ["claim 1: quote is not in the PR"])], [15, call("plan", 1000)]), { inputTokens: 200, outputTokens: 100 });
  assert.deepEqual(totals(), { inputTokens: 0, outputTokens: 0 });
});

test("a sort stage with two calls shows the rejected first call and the accepted second", () => {
  const view = viewOf(timeline(
    ...planned.slice(0, 7),
    [20, call("sort", 15_000, false, ["the reply was not JSON"])],
    [20, asking("sort")],
    [30, call("sort", 10_000)],
    [30, { type: "stage_started", stage: "plan" }],
  ), at(31), true);
  assert.deepEqual(view.calls.map((c) => [c.n, c.purpose, c.ok, c.ms, c.problems]), [
    [1, "sort", false, 15_000, ["the reply was not JSON"]],
    [2, "sort", true, 10_000, []],
  ]);
  assert.deepEqual(stageOf(view, "sort"), { stage: "sort", state: "done", ms: 25_000, calls: 2 });
  assert.equal(view.pendingCall, null);
  assert.deepEqual(view.totals, { inputTokens: 200, outputTokens: 100 });
});

test("a model call in flight shows as pending and gets the call's own quiet limit, counted from its start", () => {
  const planning = timeline(...planned.slice(0, PLAN_STAGE_STARTED + 1));
  const soon = viewOf(planning, at(10 + 209), true);
  assert.equal(soon.status, "running");
  assert.equal(soon.quietLimitMs, 210_000);
  assert.deepEqual(soon.pendingCall, { n: 2, purpose: "plan", ms: 209_000 });
  const late = viewOf(planning, at(10 + 211), true);
  assert.equal(late.status, "stuck");
  assert.equal(stageOf(late, "plan")!.state, "stuck");

  const answered = viewOf([...planning, ...timeline([40, call("plan", 30_000)])], at(41), true);
  assert.equal(answered.pendingCall, null);
  assert.equal(answered.quietLimitMs, 30_000);

  const repairing = viewOf(timeline(
    ...planned,
    [45, startRehearsal("c1.1")],
    [48, endRehearsal("c1.1", "old", false, "the action changed nothing on the old app")],
    [48, asking("repair")],
  ), at(60), true);
  assert.equal(repairing.stage, "rehearse");
  assert.deepEqual(repairing.pendingCall, { n: 3, purpose: "repair", ms: 12_000 });
  assert.equal(repairing.quietLimitMs, 210_000);

  assert.equal(viewOf(planning, at(60), false).pendingCall, null);
});

test("a check goes from waiting through its rehearsal to a failed drive, with its evidence", () => {
  const events: [number, RunEventBody][] = [];
  const after = (...more: [number, RunEventBody][]) => {
    events.push(...more);
    return checkOf(viewOf(timeline(...events), at(more.at(-1)![0]), true), "c1.1");
  };
  assert.equal(after(...planned).state, "waiting");
  assert.equal(after(...planned).rehearsedOn, null);
  const rehearsing = after([45, startRehearsal("c1.1")]);
  assert.equal(rehearsing.state, "rehearsing");
  assert.equal(rehearsing.rehearsedOn, "old");
  assert.equal(after([48, endRehearsal("c1.1", "old", true)]).state, "ready");
  let check = after([51, { type: "stage_started", stage: "drive" }], [51, { type: "check_started", phase: "drive", checkId: "c1.1" }]);
  assert.equal(check.state, "running");
  assert.deepEqual(check.steps.map((s) => s.status), ["now", "todo", "todo"]);
  check = after([52, step("c1.1", 0, "passed", 700)]);
  assert.deepEqual(check.steps.map((s) => s.status), ["passed", "now", "todo"]);
  assert.deepEqual(check.latestScreenshot, { path: "c1.1/01.png", step: 1 });
  assert.equal(check.evidence, null);
  check = after(
    [53, step("c1.1", 1, "passed", 1100)],
    [58, step("c1.1", 2, "failed", 8683)],
    [59, { type: "check_finished", phase: "drive", checkId: "c1.1", result: "failed", problem: null, video: "c1.1/video.webm" }],
  );
  assert.equal(check.state, "failed");
  assert.deepEqual(check.steps.map((s) => s.status), ["passed", "passed", "failed"]);
  assert.match(check.steps[2].detail!, /saw focus on button "Delete Alpha"/);
  assert.deepEqual(check.latestScreenshot, { path: "c1.1/03.png", step: 3 });
  assert.deepEqual(check.evidence, {
    video: "c1.1/video.webm", videoAtMs: 8683, trace: "c1.1/trace.zip", appLog: "c1.1/app.log", pageSnapshot: "c1.1/03.aria.yml",
  });
});

test("a check that fails on the app before the change rehearses again on the changed app, and is kept if it works there", () => {
  const events: [number, RunEventBody][] = [
    ...planned,
    [45, startRehearsal("c1.1")],
    [48, endRehearsal("c1.1", "old", false, 'no visible match for button "Delete Beta"')],
    [48, startRehearsal("c1.1", "new")],
  ];
  const onNew = checkOf(viewOf(timeline(...events), at(49), true), "c1.1");
  assert.equal(onNew.state, "rehearsing");
  assert.equal(onNew.rehearsedOn, "new");
  const kept = checkOf(viewOf(timeline(...events, [51, endRehearsal("c1.1", "new", true)]), at(52), true), "c1.1");
  assert.equal(kept.state, "kept");
  assert.equal(kept.rehearsedOn, "new");
  assert.equal(kept.problem, null);
  const notReady = checkOf(viewOf(timeline(...events, [51, endRehearsal("c1.1", "new", false, "the app with this change never answered")]), at(52), true), "c1.1");
  assert.equal(notReady.state, "not_ready");
  assert.equal(notReady.problem, "the app with this change never answered");
});

test("a later step with the same index replaces the earlier one", () => {
  const view = viewOf(timeline(
    ...driving,
    [52, { type: "check_started", phase: "drive", checkId: "c1.1" }],
    [53, step("c1.1", 0, "passed", 700)],
    [53, step("c1.1", 1, "passed", 1100)],
    [54, step("c1.1", 2, "passed", 1500)],
    [55, { type: "step", phase: "drive", checkId: "c1.1", index: 2, status: "could_not_run", atMs: 1500, detail: "app down: the app's container exited", screenshot: "c1.1/03.png" }],
    [55, { type: "check_finished", phase: "drive", checkId: "c1.1", result: "could_not_run", problem: null, video: null }],
  ), at(56), true);
  const check = checkOf(view, "c1.1");
  assert.equal(check.state, "could_not_run");
  assert.deepEqual(check.steps.map((s) => s.status), ["passed", "passed", "could_not_run"]);
  assert.equal(check.steps[2].detail, "app down: the app's container exited");
});

test("the verdict's result for a check wins over the check's own result", () => {
  const view = viewOf(timeline(
    ...driving,
    [52, { type: "check_started", phase: "drive", checkId: "c1.1" }],
    [53, { type: "check_finished", phase: "drive", checkId: "c1.1", result: "passed", problem: null, video: null }],
    [54, verdictOf("NOT PROVEN", [{ checkId: "c1.1", result: "evidence_missing" }, { checkId: "c2.1", result: "could_not_run" }])],
  ), at(60), false);
  assert.equal(view.status, "NOT PROVEN");
  assert.equal(checkOf(view, "c1.1").state, "evidence_missing");
  assert.equal(checkOf(view, "c2.1").state, "could_not_run");
  assert.deepEqual(view.verdict, {
    kind: "NOT PROVEN", commit: "405a283bbbb", halt: null, reasons: [], total: 2, counts: { passed: 0, failed: 0, could_not_run: 1, evidence_missing: 1 },
  });
  assert.equal(stageOf(view, "drive")!.state, "done");
  assert.equal(view.elapsedMs, 54_000);
});

test("an interrupted run keeps the stage it stopped in and says why", () => {
  const view = viewOf(timeline(
    ...driving,
    [52, { type: "check_started", phase: "drive", checkId: "c1.1" }],
    [53, step("c1.1", 0, "passed", 700)],
    [55, verdictOf("NOT PROVEN", [{ checkId: "c1.1", result: "could_not_run" }, { checkId: "c2.1", result: "could_not_run" }], { stage: "drive", reason: "interrupted" }, ["Stopped: interrupted."])],
  ), at(60), false);
  assert.equal(view.status, "NOT PROVEN");
  assert.deepEqual(view.verdict!.halt, { stage: "drive", reason: "interrupted" });
  assert.deepEqual(view.verdict!.reasons, ["Stopped: interrupted."]);
  assert.equal(stageOf(view, "drive")!.state, "halted");
  assert.equal(checkOf(view, "c1.1").state, "could_not_run");
  assert.equal(view.elapsedMs, 55_000);
});

test("the status reads running, stuck, stopped or the verdict, and each stage has its own quiet limit", () => {
  const planning = timeline(...planned.slice(0, PLAN_STAGE_STARTED));
  assert.equal(viewOf(planning, at(10 + 29), true).status, "running");
  const stuck = viewOf(planning, at(10 + 31), true);
  assert.equal(stuck.status, "stuck");
  assert.equal(stuck.quietLimitMs, 30_000);
  assert.equal(stageOf(stuck, "plan")!.state, "stuck");
  assert.equal(stuck.pendingCall, null);

  const rehearsing = timeline(...planned, [45, startRehearsal("c1.1")]);
  assert.equal(viewOf(rehearsing, at(45 + 119), true).status, "running");
  assert.equal(viewOf(rehearsing, at(45 + 121), true).status, "stuck");

  const stopped = viewOf(rehearsing, at(300), false);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.elapsedMs, 45_000);
  assert.equal(stageOf(stopped, "rehearse")!.state, "halted");
  assert.equal(checkOf(stopped, "c1.1").state, "interrupted");

  const reasons = ["Stopped: no valid plan.", "   - claim 1: quote is not in the PR"];
  const halted = timeline(...planned.slice(0, PLAN_STAGE_STARTED), [400, verdictOf("NOT PROVEN", [], { stage: "plan", reason: "no_valid_plan" }, reasons)]);
  for (const alive of [true, false]) {
    const view = viewOf(halted, at(500), alive);
    assert.equal(view.status, "NOT PROVEN");
    assert.deepEqual(view.verdict!.halt, { stage: "plan", reason: "no_valid_plan" });
    assert.deepEqual(view.verdict!.reasons, reasons);
    assert.equal(stageOf(view, "plan")!.state, "halted");
    assert.equal(stageOf(view, "rehearse")!.state, "todo");
  }
});

test("a file plan skips the sort stage and makes no model calls", () => {
  const filePlan = timeline(
    ...looked,
    [5, { type: "stage_started", stage: "plan" }],
    [5, { type: "plan", frozen: false, sha256: null, plan: PLAN }],
    [5, { type: "stage_started", stage: "rehearse" }],
  );
  const view = viewOf(filePlan, at(6), true);
  assert.deepEqual(view.stages.map((s) => s.stage), ["repo", "look", "plan", "rehearse", "drive"]);
  assert.deepEqual(view.calls, []);
  assert.equal(view.pendingCall, null);
  assert.equal(view.status, "running");
  assert.equal(viewOf(filePlan, at(5 + 121), true).status, "stuck");
});

test("a stage this version does not know keeps the run on the page", () => {
  const view = viewOf(timeline(...planned.slice(0, PLAN_STAGE_STARTED), [12, { type: "stage_started", stage: "repair" as Stage }]), at(20), true);
  assert.equal(view.stage, "repair");
  assert.equal(view.status, "running");
  assert.equal(view.quietLimitMs, 60_000);
  assert.deepEqual(view.stages.at(-1), { stage: "repair", state: "now", ms: 8000, calls: 0 });
});

test("a repair round replaces the plan and starts over only the checks it changed", () => {
  const events = timeline(
    ...planned,
    [45, startRehearsal("c1.1")],
    [48, endRehearsal("c1.1", "old", true)],
    [48, startRehearsal("c2.1")],
    [51, endRehearsal("c2.1", "old", false, "the action changed nothing on the old app")],
    [51, asking("repair")],
    [80, call("repair", 29_000)],
    [80, { type: "plan", frozen: false, sha256: null, plan: REPAIRED }],
  );
  const repaired = viewOf(events, at(81), true);
  assert.equal(checkOf(repaired, "c1.1").state, "ready");
  assert.equal(checkOf(repaired, "c2.1").state, "waiting");
  assert.equal(checkOf(repaired, "c2.1").problem, null);
  assert.equal(checkOf(repaired, "c2.1").steps[2].text, 'expect_count css ".task-title"');
  assert.deepEqual(stageOf(repaired, "rehearse"), { stage: "rehearse", state: "now", ms: 37_000, calls: 1 });
  assert.equal(repaired.pendingCall, null);

  const frozen = viewOf([...events, ...timeline(
    [82, startRehearsal("c2.1")],
    [85, endRehearsal("c2.1", "old", true)],
    [85, { type: "plan", frozen: true, sha256: "77aa000", plan: REPAIRED }],
  )], at(86), true);
  assert.deepEqual(frozen.plan!.claims.flatMap((claim) => claim.checks.map((check) => check.state)), ["ready", "ready"]);
  assert.equal(frozen.plan!.sha256, "77aa000");
  assert.equal(frozen.plan!.frozen, true);
  assert.equal(frozen.calls.length, 3);
});

test("a baseline rerun is shown beside the drive and never overwrites its steps", () => {
  const view = viewOf(timeline(
    ...driving,
    [52, { type: "check_started", phase: "drive", checkId: "c1.1" }],
    [53, step("c1.1", 0, "passed", 700)],
    [53, step("c1.1", 1, "passed", 1100)],
    [54, step("c1.1", 2, "passed", 1500)],
    [55, { type: "check_finished", phase: "drive", checkId: "c1.1", result: "passed", problem: null, video: "c1.1/video.webm" }],
    [56, { type: "stage_started", stage: "baseline" }],
    [56, { type: "check_started", phase: "baseline", checkId: "c1.1" }],
    [57, step("c1.1", 0, "passed", 700, "baseline")],
    [57, step("c1.1", 1, "passed", 1100, "baseline")],
    [59, step("c1.1", 2, "failed", 6000, "baseline")],
    [59, { type: "check_finished", phase: "baseline", checkId: "c1.1", result: "failed", problem: null, video: "baseline/c1.1/video.webm" }],
    [60, { type: "check_started", phase: "baseline", checkId: "c2.1" }],
  ), at(61), true);
  const c1 = checkOf(view, "c1.1");
  assert.equal(c1.state, "passed");
  assert.deepEqual(c1.steps.map((s) => s.status), ["passed", "passed", "passed"]);
  assert.equal(c1.latestScreenshot!.path, "c1.1/03.png");
  assert.deepEqual(c1.baseline, {
    state: "failed",
    step: { n: 3, text: 'expect_focus button "Delete Beta"', detail: 'expected focus on button "Delete Beta", saw focus on button "Delete Alpha"', screenshot: "baseline/c1.1/03.png" },
    video: "baseline/c1.1/video.webm",
  });
  assert.deepEqual(checkOf(view, "c2.1").baseline, { state: "running", step: { n: 1, text: 'fill textbox "Title" with "Gamma"', detail: null, screenshot: null }, video: null });
  assert.equal(stageOf(view, "baseline")!.state, "now");
});

test("byteRange reads one range and turns down the rest", () => {
  assert.deepEqual(byteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(byteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=500-5000", 1000), { start: 500, end: 999 });
  assert.equal(byteRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(byteRange(undefined, 1000), null);
  assert.equal(byteRange("bytes=0-1,5-9", 1000), null);
});

const RAW_HOST = "127.0.0.1";

/** Sends the path as written: fetch would normalize `..` before the server saw it. */
function rawGet(port: number, path: string, host = `${RAW_HOST}:${port}`): Promise<{ status: number; type: string | undefined }> {
  return new Promise((done, fail) => {
    request({ host: RAW_HOST, port, path, headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => done({ status: res.statusCode!, type: res.headers["content-type"] }));
    }).on("error", fail).end();
  });
}

async function* payloads(url: string, signal: AbortSignal): AsyncGenerator<DashboardPayload> {
  const res = await fetch(url, { signal });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body ?? []) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const data = buffer.slice(0, end).split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      buffer = buffer.slice(end + 2);
      if (data) yield JSON.parse(data) as DashboardPayload;
    }
  }
}

async function until<T>(source: AsyncIterator<T>, ok: (value: T) => boolean, ms = 2000): Promise<T> {
  const deadline = sleep(ms, null, { ref: false }).then(() => {
    throw new Error(`nothing matched within ${ms} ms`);
  });
  for (;;) {
    const next = await Promise.race([source.next(), deadline]);
    if (next.done) throw new Error("the stream ended");
    if (ok(next.value)) return next.value;
  }
}

suite("serveDashboard", () => {
  const OLD = "20261017-120000-delete-correct-0001";
  const NEW = "20261017-120500-delete-bug-0002";
  let runsDir = "";
  let dashboard: Dashboard;
  let port = 0;

  const write = (runId: string, events: RunEvent[]) => {
    mkdirSync(join(runsDir, runId, "c1.1"), { recursive: true });
    writeFileSync(join(runsDir, runId, EVENTS_FILE), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  };

  before(async () => {
    runsDir = mkdtempSync(join(tmpdir(), "umbreon-dashboard-"));
    write(OLD, timeline([0, { ...started, runId: OLD, caseName: "delete-correct" }], [5, verdictOf("PROVEN", [])]));
    write(NEW, timelineFrom(Date.now(), [[0, { ...started, runId: NEW }], [0, { type: "stage_started", stage: "repo" }]]));
    writeFileSync(join(runsDir, NEW, "c1.1", "12.png"), "png bytes");
    writeFileSync(join(runsDir, NEW, "notes.sh"), "echo hi");
    writeFileSync(join(runsDir, "secret.png"), "outside every run");
    mkdirSync(join(runsDir, "not-a-run"));
    dashboard = await serveDashboard({ runsDir, port: 0, isAlive: () => true, pollMs: 50 });
    port = Number(new URL(dashboard.url).port);
  });
  after(async () => {
    await dashboard.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("listens on 127.0.0.1 only", async () => {
    assert.equal(new URL(dashboard.url).hostname, "127.0.0.1");
    const outside = Object.values(networkInterfaces()).flat().find((nic) => nic && nic.family === "IPv4" && !nic.internal);
    if (!outside) return;
    const refused = await new Promise<boolean>((done) => {
      const socket = connect({ port, host: outside.address, timeout: 1000 });
      socket.on("connect", () => (socket.destroy(), done(false)));
      socket.on("timeout", () => (socket.destroy(), done(true)));
      socket.on("error", () => done(true));
    });
    assert.ok(refused, `port ${port} is closed on ${outside.address}`);
  });

  test("serves the page at /", async () => {
    const res = await fetch(dashboard.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /^text\/html/);
    assert.match(await res.text(), /EventSource/);
  });

  test("streams the newest run first, then an event appended to its log within 2 s", async () => {
    const stop = new AbortController();
    try {
      const stream = payloads(`${dashboard.url}api/stream`, stop.signal);
      const first = await until(stream, () => true);
      assert.deepEqual(first.runs.map((run) => [run.runId, run.status]), [[NEW, "running"], [OLD, "PROVEN"]]);
      assert.equal(first.view!.runId, NEW);
      assert.equal(first.view!.stage, "repo");
      appendFileSync(join(runsDir, NEW, EVENTS_FILE), `${JSON.stringify({ type: "stage_started", stage: "look", seq: 3, at: new Date().toISOString() })}\n`);
      const next = await until(stream, (p) => p.view?.stage === "look");
      assert.equal(next.view!.runId, NEW);
    } finally {
      stop.abort();
    }
  });

  test("streams the run the page asked for", async () => {
    const stop = new AbortController();
    try {
      const first = await until(payloads(`${dashboard.url}api/stream?run=${OLD}`, stop.signal), () => true);
      assert.equal(first.view!.runId, OLD);
      assert.equal(first.view!.status, "PROVEN");
    } finally {
      stop.abort();
    }
  });

  test("serves evidence inside a run folder and nothing outside it or of another kind", async () => {
    assert.deepEqual(await rawGet(port, `/runs/${NEW}/c1.1/12.png`), { status: 200, type: "image/png" });
    for (const path of [
      `/runs/${NEW}/../../etc/passwd`,
      `/runs/${NEW}/%2e%2e/secret.png`,
      `/runs/${NEW}/..%2fsecret.png`,
      `/runs/${NEW}/%2E%2E%2Fsecret.png`,
      "/runs/..%2f/secret.png",
      "/runs/../secret.png",
      `/runs/${NEW}/notes.sh`,
      `/runs/${NEW}/${EVENTS_FILE}`,
      `/runs/${NEW}/c1.1`,
      `/runs/${NEW}/c1.1/missing.png`,
    ]) {
      assert.equal((await rawGet(port, path)).status, 404, path);
    }
  });

  test("serves a byte range of a file, so a video can open at the moment a check failed", async () => {
    const res = await fetch(`${dashboard.url}runs/${NEW}/c1.1/12.png`, { headers: { range: "bytes=4-" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 4-8/9");
    assert.equal(await res.text(), "bytes");
  });

  test("refuses a request addressed to another host name", async () => {
    assert.equal((await rawGet(port, "/", "evil.example:80")).status, 403);
  });
});
