import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, suite, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { byteRange, serveDashboard, viewOf, type Dashboard, type DashboardPayload, type RunView } from "./dashboard.ts";
import { EVENTS_FILE, type PlanSummary, type RunEvent, type RunEventBody } from "./events.ts";

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

const planned: [number, RunEventBody][] = [
  [0, started],
  [0, { type: "stage_started", stage: "repo" }],
  [2, { type: "repo_ready", base: "3deb814aaaa", commit: "405a283bbbb" }],
  [2, { type: "stage_started", stage: "look" }],
  [6, { type: "stage_started", stage: "plan" }],
  [40, { type: "model_call", purpose: "plan", ok: true, ms: 34_000, inputTokens: 6712, outputTokens: 9859, costUsd: 0.014, problems: [] }],
  [44, { type: "plan", frozen: false, sha256: null, plan: PLAN }],
  [44, { type: "stage_started", stage: "rehearse" }],
];
const rehearsed: [number, RunEventBody][] = [
  ...planned,
  [45, { type: "check_started", phase: "rehearse", checkId: "c1.1" }],
  [48, { type: "check_finished", phase: "rehearse", checkId: "c1.1", ready: true, problem: null }],
  [48, { type: "check_started", phase: "rehearse", checkId: "c2.1" }],
  [51, { type: "check_finished", phase: "rehearse", checkId: "c2.1", ready: true, problem: null }],
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

test("viewOf times each stage and counts the model calls made in it", () => {
  const view = viewOf(timeline(...planned), at(50), true);
  assert.deepEqual(view.stages.map((s) => [s.stage, s.state, s.ms, s.calls]), [
    ["repo", "done", 2000, 0],
    ["look", "done", 4000, 0],
    ["plan", "done", 38_000, 1],
    ["rehearse", "now", 6000, 0],
    ["drive", "todo", 0, 0],
  ]);
  assert.equal(view.stage, "rehearse");
  assert.equal(view.elapsedMs, 50_000);
  assert.equal(view.commit, "405a283bbbb");
  assert.deepEqual(view.plan!.uncovered, ["Focus used to jump to the list."]);
  assert.deepEqual(view.plan!.notTestable, PLAN.notTestable);
});

test("totals add every call's tokens, and the cost is unknown only when no call reported one", () => {
  const call = (costUsd: number | null): [number, RunEventBody] => [10, { type: "model_call", purpose: "plan", ok: false, ms: 1000, inputTokens: 100, outputTokens: 50, costUsd, problems: ["claim 1: quote is not in the PR"] }];
  const totals = (...calls: [number, RunEventBody][]) => viewOf(timeline([0, started], ...calls), at(20), true).totals;
  assert.deepEqual(totals(call(null), call(null)), { inputTokens: 200, outputTokens: 100, costUsd: null });
  assert.deepEqual(totals(call(0.01), call(null)), { inputTokens: 200, outputTokens: 100, costUsd: 0.01 });
  assert.deepEqual(totals(), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
});

test("a check goes from waiting through its rehearsal to a failed drive, with its evidence", () => {
  const events: [number, RunEventBody][] = [];
  const after = (...more: [number, RunEventBody][]) => {
    events.push(...more);
    return checkOf(viewOf(timeline(...events), at(more.at(-1)![0]), true), "c1.1");
  };
  assert.equal(after(...planned).state, "waiting");
  assert.equal(after([45, { type: "check_started", phase: "rehearse", checkId: "c1.1" }]).state, "rehearsing");
  assert.equal(after([48, { type: "check_finished", phase: "rehearse", checkId: "c1.1", ready: true, problem: null }]).state, "ready");
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

test("the verdict's result for a check wins over the check's own result", () => {
  const view = viewOf(timeline(
    ...rehearsed,
    [52, { type: "check_started", phase: "drive", checkId: "c1.1" }],
    [53, { type: "check_finished", phase: "drive", checkId: "c1.1", result: "passed", problem: null, video: null }],
    [54, { type: "verdict", kind: "NOT PROVEN", commit: "405a283bbbb", checks: [{ checkId: "c1.1", result: "evidence_missing" }, { checkId: "c2.1", result: "could_not_run" }], halt: null }],
  ), at(60), false);
  assert.equal(view.status, "NOT PROVEN");
  assert.equal(checkOf(view, "c1.1").state, "evidence_missing");
  assert.equal(checkOf(view, "c2.1").state, "could_not_run");
  assert.deepEqual(view.verdict, {
    kind: "NOT PROVEN", commit: "405a283bbbb", halt: null, total: 2, counts: { passed: 0, failed: 0, could_not_run: 1, evidence_missing: 1 },
  });
  assert.equal(stageOf(view, "drive")!.state, "done");
  assert.equal(view.elapsedMs, 54_000);
});

test("the status reads running, stuck, stopped or the verdict, and each stage has its own quiet limit", () => {
  const planning = timeline(...planned.slice(0, 5));
  assert.equal(viewOf(planning, at(6 + 209), true).status, "running");
  const stuck = viewOf(planning, at(6 + 211), true);
  assert.equal(stuck.status, "stuck");
  assert.equal(stuck.quietLimitMs, 210_000);
  assert.equal(stageOf(stuck, "plan")!.state, "stuck");
  assert.deepEqual(stuck.pendingCall, { n: 1, purpose: "plan", ms: 211_000 });

  const rehearsing = timeline(...planned, [45, { type: "check_started", phase: "rehearse", checkId: "c1.1" }]);
  assert.equal(viewOf(rehearsing, at(45 + 61), true).status, "stuck");

  const stopped = viewOf(rehearsing, at(300), false);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.elapsedMs, 45_000);
  assert.equal(stageOf(stopped, "rehearse")!.state, "halted");
  assert.equal(checkOf(stopped, "c1.1").state, "interrupted");
  assert.equal(stopped.pendingCall, null);

  const halted = timeline(...planned.slice(0, 5), [400, { type: "verdict", kind: "NOT PROVEN", commit: "405a283bbbb", checks: [], halt: "no valid plan" }]);
  for (const alive of [true, false]) {
    const view = viewOf(halted, at(500), alive);
    assert.equal(view.status, "NOT PROVEN");
    assert.equal(view.verdict!.halt, "no valid plan");
    assert.equal(stageOf(view, "plan")!.state, "halted");
    assert.equal(stageOf(view, "rehearse")!.state, "todo");
  }
});

test("a repair round replaces the plan and starts over only the checks it changed", () => {
  const events = timeline(
    ...planned,
    [45, { type: "check_started", phase: "rehearse", checkId: "c1.1" }],
    [48, { type: "check_finished", phase: "rehearse", checkId: "c1.1", ready: true, problem: null }],
    [48, { type: "check_started", phase: "rehearse", checkId: "c2.1" }],
    [51, { type: "check_finished", phase: "rehearse", checkId: "c2.1", ready: false, problem: "the action changed nothing on the old app" }],
    [51, { type: "stage_started", stage: "repair" }],
    [80, { type: "model_call", purpose: "repair", ok: true, ms: 29_000, inputTokens: 900, outputTokens: 400, costUsd: 0.002, problems: [] }],
    [80, { type: "plan", frozen: false, sha256: null, plan: REPAIRED }],
  );
  const repaired = viewOf(events, at(81), true);
  assert.equal(checkOf(repaired, "c1.1").state, "ready");
  assert.equal(checkOf(repaired, "c2.1").state, "waiting");
  assert.equal(checkOf(repaired, "c2.1").problem, null);
  assert.equal(checkOf(repaired, "c2.1").steps[2].text, 'expect_count css ".task-title"');
  assert.deepEqual(stageOf(repaired, "repair"), { stage: "repair", state: "now", ms: 30_000, calls: 1 });
  assert.equal(repaired.pendingCall, null);

  const frozen = viewOf([...events, ...timeline(
    [81, { type: "stage_started", stage: "rehearse" }],
    [82, { type: "check_started", phase: "rehearse", checkId: "c2.1" }],
    [85, { type: "check_finished", phase: "rehearse", checkId: "c2.1", ready: true, problem: null }],
    [85, { type: "plan", frozen: true, sha256: "77aa000", plan: REPAIRED }],
  )], at(86), true);
  assert.deepEqual(frozen.plan!.claims.flatMap((claim) => claim.checks.map((check) => check.state)), ["ready", "ready"]);
  assert.equal(frozen.plan!.sha256, "77aa000");
  assert.equal(frozen.plan!.frozen, true);
  assert.equal(frozen.calls.length, 2);
});

test("a baseline rerun is shown beside the drive and never overwrites its steps", () => {
  const view = viewOf(timeline(
    ...rehearsed,
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
    write(OLD, timeline([0, { ...started, runId: OLD, caseName: "delete-correct" }], [5, { type: "verdict", kind: "PROVEN", commit: "405a283", checks: [], halt: null }]));
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
