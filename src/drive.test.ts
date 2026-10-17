import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { DEMO_TODO, loadCase, preflight, prepareApp, withApp, type Repo, type RunningApp } from "./app.ts";
import { lookAtApp, rehearseCheck, runCheck } from "./drive.ts";
import { ScenarioSchema, checksOf, freeze, type FrozenScenario } from "./scenario.ts";
import { decide, type CheckRun, type Evidence, type Outcome, type Verdict } from "./verdict.ts";

const APP_DIR = fileURLToPath(new URL("../practice/demo-todo", import.meta.url));
const PR_TEXT = readFileSync(join(APP_DIR, "prs/delete-correct/pr.md"), "utf8");
const CASES = ["delete-correct", "delete-bug"] as const;
type CaseName = (typeof CASES)[number];

let tmp = "";
let browser: Browser;
const repos = {} as Record<CaseName, { old: Repo; new: Repo }>;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "umbreon-drive-test-"));
  await preflight(DEMO_TODO);
  browser = await chromium.launch();
  for (const name of CASES) {
    const prepared = await prepareApp(await loadCase(join(APP_DIR, "prs", name)), join(tmp, name));
    assert.ok(prepared.ok, `${name} prepares`);
    repos[name] = prepared;
  }
});
after(async () => {
  await browser?.close();
  await rm(tmp, { recursive: true, force: true });
});

function fixture(name: string): FrozenScenario {
  const path = `scripts/fixtures/demo-todo-${name}.json`;
  return freeze(ScenarioSchema.parse(JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))), { kind: "file", path });
}

const never = new AbortController().signal;

/** A copy of the demo app with some files edited, for an app that misbehaves in the browser. */
async function patchedApp(name: string, edits: Record<string, (text: string) => string>): Promise<string> {
  const dir = join(tmp, name);
  await cp(APP_DIR, dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const original = await readFile(join(dir, file), "utf8");
    const edited = edit(original);
    assert.notEqual(edited, original, `${name}: the edit to ${file} applies`);
    await writeFile(join(dir, file), edited);
  }
  return dir;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

async function verify(fixtureName: string, caseName: CaseName): Promise<{ verdict: Verdict; runs: CheckRun[] }> {
  const scenario = fixture(fixtureName);
  const repo = repos[caseName].new;
  const runId = `drive-${process.pid}-${fixtureName}-${caseName}`;
  const runs: CheckRun[] = [];
  for (const check of checksOf(scenario)) {
    runs.push(await withApp(repo.dir, DEMO_TODO, { runId, check: check.id }, never, (app) =>
      runCheck(browser, app, check, join(tmp, "runs", runId, check.id), never)));
  }
  return { verdict: decide({ commit: repo.commit, halt: null, scenario, prText: PR_TEXT, runs, baseline: [] }), runs };
}

const results = (verdict: Verdict) => Object.fromEntries(verdict.checks.map((outcome) => [outcome.checkId, outcome.result]));
const outcome = (verdict: Verdict, checkId: string): Outcome => verdict.checks.find((o) => o.checkId === checkId)!;

async function onDisk(evidence: Evidence): Promise<boolean> {
  return evidence.state === "captured" && (await stat(evidence.file)).size > 0;
}

test("good plan: every check passes on delete-correct, with a screenshot of every step, a video and a trace on disk", async () => {
  const { verdict, runs } = await verify("good", "delete-correct");
  assert.ok(verdict.kind === "NOT PROVEN");
  assert.deepEqual(verdict.blockers, [{ reason: "no_check_fails_before" }], "only the baseline, which verify runs, is missing");
  for (const run of runs) {
    for (const step of run.steps) {
      assert.ok(step.status === "passed" && (await onDisk(step.screenshot)), `${run.checkId} step ${step.index + 1} screenshot`);
      assert.match(step.screenshot.state === "captured" ? step.screenshot.file : "", /\/\d\d\.png$/);
    }
    assert.ok(await onDisk(run.video), `${run.checkId} video`);
    assert.ok(run.video.state === "captured" && run.video.file.endsWith("/video.webm"));
    assert.ok(await onDisk(run.trace), `${run.checkId} trace`);
    assert.ok(run.trace.state === "captured" && run.trace.file.endsWith("/trace.zip"));
    assert.ok(await onDisk(run.appLog), `${run.checkId} app log`);
  }
});

test("good plan: NOT PROVEN on delete-bug because the wrong task disappears", async () => {
  const { verdict, runs } = await verify("good", "delete-bug");
  assert.equal(verdict.kind, "NOT PROVEN");
  const removal = outcome(verdict, "c1.1");
  assert.ok(removal.result === "failed", JSON.stringify(removal));
  assert.equal(removal.at.index, 7);
  assert.equal(removal.at.expected, '"Buy milk"');
  assert.equal(removal.at.observed, '"Walk dog"');
  assert.ok(await onDisk(removal.at.aria), "ARIA snapshot of the failed step");
  assert.ok(await onDisk(removal.at.screenshot), "screenshot of the failed step");
  assert.ok(runs[0].steps.every((step) => step.status !== "skipped"), "the failed step is the last one");
});

test("liar plan: NOT PROVEN on delete-correct because focus is not where the liar expects", async () => {
  const { verdict } = await verify("liar", "delete-correct");
  assert.equal(verdict.kind, "NOT PROVEN");
  assert.deepEqual(results(verdict), { "c1.1": "passed", "c2.1": "failed", "c3.1": "passed", "c4.1": "passed" });
  const focus = outcome(verdict, "c2.1");
  assert.ok(focus.result === "failed");
  assert.deepEqual([focus.at.expected, focus.at.observed], ['focus on button "Delete Walk dog"', 'focus on button "Delete Buy milk": Delete']);
});

test("typo plan: could not run, because the gone rule finds no \"Walk Dog\" on screen before the action", async () => {
  const { verdict, runs } = await verify("typo", "delete-correct");
  assert.equal(verdict.kind, "NOT PROVEN");
  const typo = outcome(verdict, "c1.1");
  assert.ok(typo.result === "could_not_run" && typo.at !== null, JSON.stringify(typo));
  assert.equal(typo.at.cause, "gone_rule");
  assert.equal(typo.at.index, 5, "recorded at the first when step");
  assert.match(typo.at.detail, /then step 1 expect_absent text "Walk Dog"/);
  assert.deepEqual(runs[0].steps.slice(6).map((step) => step.status), ["skipped", "skipped", "skipped"]);
});

test("vacuous plan: could not run on delete-bug, because the effect rule sees nothing left to change", async () => {
  const { verdict } = await verify("vacuous", "delete-bug");
  assert.equal(verdict.kind, "NOT PROVEN");
  const vacuous = outcome(verdict, "c1.1");
  assert.ok(vacuous.result === "could_not_run" && vacuous.at !== null, JSON.stringify(vacuous));
  assert.equal(vacuous.at.cause, "effect_rule");
  assert.equal(vacuous.at.index, 7);
  assert.match(vacuous.at.detail, /then step 1 expect_visible button "Add task" saw 1 visible match/);
});

test("lookAtApp returns the start page's ARIA snapshot and the HTML and JS it loaded", async () => {
  const ui = await withApp(repos["delete-correct"].new.dir, DEMO_TODO, { runId: `look-${process.pid}`, check: "look" }, never, (app) =>
    lookAtApp(browser, app, never));
  assert.match(ui.ariaSnapshot, /button "Add task"/);
  assert.deepEqual(ui.files.map((f) => new URL(f.url).pathname), ["/", "/app.js"]);
  assert.match(ui.files[1].text, /function removeTask/);
  assert.equal(ui.truncated, false);
});

test("an app that stopped answering gives could not run at step 1, with the video and trace still saved", async () => {
  const server = createServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const app = { origin, startUrl: `${origin}/`, alive: async () => false, logs: async () => "exited with code 1" };
  const check = checksOf(fixture("good"))[0];
  const run = await runCheck(browser, app, check, join(tmp, "runs", "dead-app", check.id), never);
  const [first, ...rest] = run.steps;
  assert.ok(first.status === "could_not_run", JSON.stringify(first));
  assert.equal(first.cause, "app_down");
  assert.ok(rest.every((step) => step.status === "skipped"));
  assert.ok(await onDisk(run.video), "video");
  assert.ok(await onDisk(run.trace), "trace");
});

test("rehearsal on the old app passes every good check and stops the check with no setup", async () => {
  const rehearse = (scenario: FrozenScenario, checkId: string) => {
    const check = checksOf(scenario).find((c) => c.id === checkId)!;
    return withApp(repos["delete-correct"].old.dir, DEMO_TODO, { runId: `rehearse-${process.pid}`, check: checkId }, never, (app) =>
      rehearseCheck(browser, app, check, never));
  };
  const good = fixture("good");
  for (const check of checksOf(good)) assert.equal(await rehearse(good, check.id), null, check.id);
  assert.equal(
    await rehearse(fixture("no-setup"), "c2.1"),
    'when step 1 click button "Delete Walk dog": nothing matched its target before the "when" steps',
  );
});

test("a page stuck in a loop ends its step as could not run (page hung) within the deadline, and skips the rest", { timeout: 90_000 }, async (t) => {
  const dir = await patchedApp("loops-on-delete", {
    "public/app.js": (js) => js.replace("function askDelete(task) {", "function askDelete(task) {\n  while (true) {}"),
  });
  const check = checksOf(fixture("good"))[0];
  const started = performance.now();
  const run = await withApp(dir, DEMO_TODO, { runId: `hung-${process.pid}`, check: check.id }, never, (app) =>
    runCheck(browser, app, check, join(tmp, "runs", "hung", check.id), never));
  const elapsed = Math.round(performance.now() - started);
  t.diagnostic(`returned in ${elapsed} ms`);
  assert.ok(elapsed < 40_000, `returned in ${elapsed} ms`);
  assert.deepEqual(run.steps.map((step) => step.status), [...Array(5).fill("passed"), "could_not_run", "skipped", "skipped"]);
  const hung = run.steps[5];
  assert.ok(hung.status === "could_not_run");
  assert.equal(hung.cause, "page_hung");
  assert.equal(hung.detail, "the step did not finish in 20 s; the page may be stuck in a loop");
});

test("stopping the run while the page is stuck makes lookAtApp, rehearseCheck and runCheck reject at once", { timeout: 90_000 }, async (t) => {
  const dir = await patchedApp("loops-on-load", { "public/app.js": (js) => `${js}\nwhile (true) {}\n` });
  const check = checksOf(fixture("good"))[0];
  const drivers: Record<string, (app: RunningApp, signal: AbortSignal) => Promise<unknown>> = {
    lookAtApp: (app, signal) => lookAtApp(browser, app, signal),
    rehearseCheck: (app, signal) => rehearseCheck(browser, app, check, signal),
    runCheck: (app, signal) => runCheck(browser, app, check, join(tmp, "runs", "stopped", check.id), signal),
  };
  for (const [name, drive] of Object.entries(drivers)) {
    const controller = new AbortController();
    let stoppedAt = 0;
    const running = withApp(dir, DEMO_TODO, { runId: `stop-${process.pid}`, check: name }, controller.signal, (app) => {
      setTimeout(() => {
        stoppedAt = performance.now();
        controller.abort();
      }, 3_000);
      return drive(app, controller.signal);
    });
    await assert.rejects(running, { name: "AbortError" }, name);
    const took = Math.round(performance.now() - stoppedAt);
    t.diagnostic(`${name} rejected ${took} ms after the stop`);
    assert.ok(took < 3_000, `${name} rejected ${took} ms after the stop`);
  }
});

test("the app's page reaches only the app's own origin, not another port on this machine", async () => {
  let connections = 0;
  const other = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  const port = await listen(other);
  try {
    const dir = await patchedApp("calls-out", {
      // The demo app's CSP would block these calls on its own, which would hide what the browser allows.
      "server.js": (js) => js.replace(/^.*"Content-Security-Policy".*\n/m, ""),
      "public/app.js": (js) => `${js}\nfetch("http://127.0.0.1:${port}/fetch").catch(() => {});\nnew WebSocket("ws://127.0.0.1:${port}/ws");\n`,
    });
    const ui = await withApp(dir, DEMO_TODO, { runId: `calls-out-${process.pid}`, check: "look" }, never, (app) => lookAtApp(browser, app, never));
    assert.match(ui.ariaSnapshot, /button "Add task"/, "the app's own page, script and API still load");
    assert.equal(connections, 0, "the other port saw no connection");
  } finally {
    other.close();
  }
});
