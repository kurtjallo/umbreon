import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, suite, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import { parseEvents, type RunEvent } from "./events.ts";
import { renderSortInput, systemPrompt } from "./planner.ts";
import { lineOf } from "./report.ts";
import { checksOf, sentencesOf, stepsOf } from "./scenario.ts";
import type { Evidence, RunRecord } from "./verdict.ts";
import { verify } from "./verify.ts";

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const caseDir = (name: string) => join(REPO, "practice/demo-todo/prs", name);
const fixture = (name: string) => join(REPO, `scripts/fixtures/demo-todo-${name}.json`);
const CLEAR_PLAN = join(REPO, "scripts/fixtures/clear-completed-good.json");
const CLEAR_SORT = { notTestable: [{ sentence: 1, reason: "History: how the app behaved before this change." }] };

let runsDir = "";
before(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "umbreon-verify-test-"));
});
after(() => rm(runsDir, { recursive: true, force: true }));

const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
  warnings: [],
});

const nonEmpty = (path: string) => stat(path).then((s) => s.size > 0, () => false);
const fromFile = (name: string, caseName: string) => verify(caseDir(caseName), { plan: { kind: "file", path: fixture(name) }, runsDir });

async function assertEvidence(record: RunRecord): Promise<void> {
  for (const file of ["run.json", "scenario.json", "report.txt"]) assert.ok(await nonEmpty(join(record.dir, file)), `${file} written`);
  assert.ok(record.scenario, "the plan was frozen");
  for (const check of checksOf(record.scenario)) {
    const run = record.runs.find((r) => r.checkId === check.id);
    assert.ok(run, `${check.id} ran`);
    const shots = run.steps.flatMap((step): Evidence[] => (step.status === "skipped" ? [] : [step.screenshot]));
    for (const evidence of [run.video, run.trace, ...shots]) {
      assert.equal(evidence.state, "captured", `${check.id} evidence`);
      assert.ok(evidence.file.startsWith(join(record.dir, check.id)), `${evidence.file} is in the check's folder`);
      assert.ok(await nonEmpty(evidence.file), `${evidence.file} is on disk`);
    }
  }
}

const eventsOf = async (record: RunRecord) => parseEvents(await readFile(join(record.dir, "events.jsonl"), "utf8"));

/** Each rehearsal of one check, in order: which app it ran on, whether the check was ready there, and what stopped it. */
function rehearsed(events: readonly RunEvent[], checkId: string): { side: string; ready: boolean; problem: string | null }[] {
  return events.flatMap((event) => (event.type === "check_finished" && event.phase === "rehearse" && event.checkId === checkId
    ? [{ side: event.side, ready: event.ready, problem: event.problem }]
    : []));
}

/** The checks whose last rehearsal left them not ready on either app, so they would go to repair. */
function notReady(events: readonly RunEvent[]): string[] {
  const last = new Map<string, boolean>();
  for (const event of events) if (event.type === "check_finished" && event.phase === "rehearse") last.set(event.checkId, event.ready);
  return [...last].filter(([, ready]) => !ready).map(([checkId]) => checkId);
}

/** The purpose of each model call, in order, after checking that each one was announced by a model_call_started just before it. */
function callsOf(events: readonly RunEvent[]): string[] {
  const purposes: string[] = [];
  let pending: string | null = null;
  for (const event of events) {
    if (event.type === "model_call_started") {
      assert.equal(pending, null, `a ${event.purpose} call started while a ${pending} call was in flight`);
      pending = event.purpose;
    } else if (event.type === "model_call") {
      assert.equal(event.purpose, pending, `a ${event.purpose} call finished without starting`);
      pending = null;
      purposes.push(event.purpose);
    }
  }
  assert.equal(pending, null, `a ${pending} call started and never finished`);
  return purposes;
}

/** Runs a case with a fake model that answers the sort call, the planning call and then any repair calls, in order. */
async function fromModel(caseName: string, ...replies: unknown[]) {
  const model = new MockLanguageModelV4({ doGenerate: replies.map(reply) });
  const events: RunEvent[] = [];
  const record = await verify(caseDir(caseName), { plan: { kind: "model", model }, runsDir, onEvent: (event) => events.push(event) });
  const userText = (call: number) => model.doGenerateCalls[call].prompt
    .flatMap((message) => (message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []))
    .join("\n");
  const plans = events.flatMap((event) => (event.type === "plan" ? [event.frozen] : []));
  return { record, calls: model.doGenerateCalls.length, events, plans, log: events.map(lineOf).filter((line) => line !== null).join("\n"), userText };
}

type Cli = { code: number | null; stdout: string; stderr: string; pid: number; record: RunRecord | null };

/**
 * Runs the CLI, reads its run.json, and removes the run folder it made under runs/. `interrupt` sends one signal once
 * the run has started, after closing our end of the child's stderr if asked, the way a closed terminal leaves it.
 */
async function cli(args: string[], interrupt?: { signal: NodeJS.Signals; afterMs: number; closeStderr?: boolean }): Promise<Cli> {
  const child = spawn(process.execPath, ["src/cli.ts", ...args], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit");
  if (interrupt) {
    const started = new Promise<void>((done) => child.stderr.on("data", () => /^run /m.test(stderr) && done()));
    await Promise.all([sleep(interrupt.afterMs), started]);
    if (interrupt.closeStderr) child.stderr.destroy();
    child.kill(interrupt.signal);
  }
  const [code] = (await exited) as [number | null];
  const runId = /^run (\S+)$/m.exec(stderr)?.[1];
  const runDir = runId ? join(REPO, "runs", runId) : null;
  const record = runDir ? await readFile(join(runDir, "run.json"), "utf8").then((text): RunRecord => JSON.parse(text), () => null) : null;
  if (runDir) await rm(runDir, { recursive: true, force: true });
  return { code, stdout, stderr, pid: child.pid!, record };
}

suite("verify", { concurrency: 3 }, () => {
  test("the good plan proves delete-correct, because c2.1 fails on the app before it, and keeps every check's evidence", async () => {
    const record = await fromFile("good", "delete-correct");
    assert.ok(record.verdict.kind === "PROVEN", JSON.stringify(record.verdict));
    assert.equal(record.verdict.failsBefore.checkId, "c2.1");
    assert.equal(record.verdict.failsBefore.at.status, "failed");
    assert.deepEqual(record.baseline.map((run) => run.checkId), ["c1.1", "c2.1"], "c1.1 passes before the change too, and the baseline stops at c2.1");
    const video = record.baseline[1].video;
    assert.ok(video.state === "captured" && video.file.startsWith(join(record.dir, "baseline", "c2.1")) && (await nonEmpty(video.file)));
    await assertEvidence(record);
  });

  test("the good plan catches delete-bug with failed checks, and its event log runs in order from run_started to the verdict", async () => {
    const record = await fromFile("good", "delete-bug");
    assert.ok(record.verdict.kind === "NOT PROVEN");
    assert.deepEqual(record.verdict.blockers, [{ reason: "check_did_not_pass" }]);
    assert.ok(record.verdict.checks.some((outcome) => outcome.result === "failed"), "some check failed");
    assert.deepEqual(record.baseline, [], "the old app is not run once a check fails");
    await assertEvidence(record);

    const events = await eventsOf(record);
    assert.deepEqual(events.map((event) => event.seq), events.map((_, i) => i + 1), "seq runs 1..n");
    assert.equal(events[0].type, "run_started");
    assert.deepEqual(events.flatMap((event) => (event.type === "stage_started" ? [event.stage] : [])), ["repo", "look", "plan", "rehearse", "drive"]);
    assert.deepEqual(events.flatMap((event) => (event.type === "plan" ? [[event.frozen, event.sha256]] : [])), [[false, null], [true, record.scenario?.sha256]]);
    assert.deepEqual(callsOf(events), [], "a plan from a file makes no model calls");
    for (const check of checksOf(record.scenario!)) {
      const own = events.filter((event) => "checkId" in event && event.checkId === check.id && "phase" in event && event.phase === "drive");
      assert.equal(own[0].type, "check_started", check.id);
      assert.equal(own.at(-1)?.type, "check_finished", check.id);
      const steps = own.slice(1, -1).flatMap((event) => (event.type === "step" ? [event.index] : []));
      assert.deepEqual(steps, stepsOf(check).map((_, index) => index), `${check.id}: one step event per step, between check_started and check_finished`);
    }
    const finished = events.flatMap((event) => (event.type === "check_finished" && event.phase === "drive" ? [[event.checkId, event.result, event.problem !== null]] : []));
    assert.deepEqual(finished, record.verdict.checks.map((outcome) => [outcome.checkId, outcome.result, outcome.result !== "passed"]));
    const verdict = events.at(-1);
    assert.ok(verdict?.type === "verdict", JSON.stringify(verdict));
    assert.deepEqual(
      { kind: verdict.kind, commit: verdict.commit, halt: verdict.halt, checks: verdict.checks },
      { kind: "NOT PROVEN", commit: record.commit, halt: null, checks: record.verdict.checks.map(({ checkId, result }) => ({ checkId, result })) },
    );
  });

  test("a renamed field in a later action is not proof, even when the check passes on the changed app", async () => {
    const record = await verify(caseDir("rename-only"), { plan: { kind: "file", path: join(REPO, "scripts/fixtures/rename-trap.json") }, runsDir });
    assert.equal(record.verdict.kind, "NOT PROVEN");
    assert.deepEqual(record.verdict.blockers, [{ reason: "no_check_fails_before" }]);
    assert.ok(record.verdict.checks.every((outcome) => outcome.result === "passed"), JSON.stringify(record.verdict.checks));
  });

  test("the clear-completed plan catches clear-completed-bug with failed checks", async () => {
    const record = await verify(caseDir("clear-completed-bug"), { plan: { kind: "file", path: CLEAR_PLAN }, runsDir });
    assert.ok(record.verdict.kind === "NOT PROVEN");
    assert.deepEqual(record.verdict.blockers, [{ reason: "check_did_not_pass" }]);
    assert.ok(record.verdict.checks.some((outcome) => outcome.result === "failed"), "some check failed");
  });

  test("a model plan whose \"when\" uses the button the PR adds is kept with no repair, but a setup that asserts the button goes to repair", async () => {
    const good = JSON.parse(await readFile(CLEAR_PLAN, "utf8"));
    const hides = { checks: [good.claims[2].checks[1]] };
    const { record, calls, events, plans, log, userText } = await fromModel("clear-completed-correct", CLEAR_SORT, { claims: good.claims }, hides, hides);
    for (const id of ["c1.2", "c2.1", "c3.1"]) {
      const seen = rehearsed(events, id);
      assert.deepEqual(seen.map(({ side, ready }) => [side, ready]), [["old", false], ["new", true]], `${id} is kept\n${log}`);
      assert.match(seen[0].problem ?? "", /^no match: when step 1 click button "Clear completed"/, log);
    }
    assert.deepEqual(rehearsed(events, "c3.2").map(({ side, ready }) => [side, ready]), [["old", false], ["old", false], ["old", false]], `c3.2 fails on the old app before and after each repair\n${log}`);
    assert.deepEqual(notReady(events), ["c3.2"], log);
    assert.deepEqual(callsOf(events), ["sort", "plan", "repair", "repair"], log);
    assert.deepEqual(plans, [false, false, false, true], "a plan after planning, one after each accepted repair, then the frozen one");
    assert.equal(calls, 4, log);
    const setupFailed = '- c3.2 (claim 3, check 2): given step 4 expect_visible button "Clear completed": expected at least 1 visible match, saw 0 visible matches';
    assert.ok(userText(2).includes(setupFailed), userText(2));
    assert.ok(!/^- c(1\.2|2\.1|3\.1) /m.test(userText(2)), userText(2));
    assert.ok(record.verdict.kind === "PROVEN", JSON.stringify(record.verdict));
    const { checkId, at } = record.verdict.failsBefore;
    assert.ok(checkId === "c1.1" && at.status === "failed", JSON.stringify(record.verdict.failsBefore));
    assert.equal(at.index, 3, "then expects Clear completed after completing a task, which both apps can do");
  });

  test("a model plan whose check expects the button the PR adds to go away is kept with no repair, and never counts before the change", async () => {
    const good = JSON.parse(await readFile(CLEAR_PLAN, "utf8"));
    const claims = structuredClone(good.claims);
    claims[2].checks[1].given.pop();
    const { record, calls, events, plans, log } = await fromModel("clear-completed-correct", CLEAR_SORT, { claims });
    const seen = rehearsed(events, "c3.2");
    assert.deepEqual(seen.map(({ side, ready }) => [side, ready]), [["old", false], ["new", true]], log);
    assert.match(seen[0].problem ?? "", /^gone rule: /, log);
    assert.deepEqual(notReady(events), [], `every check is ready on one app or the other\n${log}`);
    assert.deepEqual(callsOf(events), ["sort", "plan"], log);
    assert.deepEqual(plans, [false, true], log);
    assert.equal(calls, 2, log);
    assert.ok(record.verdict.kind === "PROVEN", JSON.stringify(record.verdict));
    assert.equal(record.verdict.failsBefore.checkId, "c1.1");
  });

  test("a check the app stops running under during rehearsal is not sent to repair, and the drive stage decides it", async () => {
    const dir = await mkdtemp(join(REPO, "practice/demo-todo/prs/dies-on-add-"));
    try {
      // The changed app answers the look stage, then exits on the first POST, which every check's setup sends.
      const diff = (await readFile(join(caseDir("clear-completed-correct"), "change.diff"), "utf8"))
        .replace("@@ -50,6 +50,7 @@", "@@ -50,6 +50,8 @@")
        .replace("+const deleteCompleted", '+setImmediate(() => server.prependListener("request", (req) => req.method === "POST" && process.exit(1)));\n+const deleteCompleted')
        .replace("@@ -148,6 +149,13 @@", "@@ -148,6 +150,13 @@");
      await writeFile(join(dir, "change.diff"), diff);
      await copyFile(join(caseDir("clear-completed-correct"), "pr.md"), join(dir, "pr.md"));
      const claims = structuredClone(JSON.parse(await readFile(CLEAR_PLAN, "utf8")).claims);
      claims[2].checks[1].given.pop();
      const model = new MockLanguageModelV4({ doGenerate: [reply(CLEAR_SORT), reply({ claims })] });
      const events: RunEvent[] = [];
      const record = await verify(dir, { plan: { kind: "model", model }, runsDir, onEvent: (event) => events.push(event) });
      const log = events.map(lineOf).filter((line) => line !== null).join("\n");
      for (const id of ["c1.2", "c2.1", "c3.1", "c3.2"]) {
        const seen = rehearsed(events, id);
        assert.deepEqual(seen.map(({ side, ready }) => [side, ready]), [["old", false], ["new", false]], `${id}\n${log}`);
        assert.match(seen[1].problem ?? "", /^app down: /, `${id}\n${log}`);
      }
      assert.deepEqual(callsOf(events), ["sort", "plan"], log);
      assert.ok(record.verdict.kind === "NOT PROVEN", JSON.stringify(record.verdict));
      assert.deepEqual(record.verdict.blockers, [{ reason: "check_did_not_pass" }]);
      assert.deepEqual(record.runs.map((run) => run.checkId), checksOf(record.scenario!).map((check) => check.id), "every check was driven");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a model plan whose check forgot its setup still gets a repair call, with only that check and the old app's problem", async () => {
    const good = JSON.parse(await readFile(CLEAR_PLAN, "utf8"));
    const forgot = { claims: structuredClone(good.claims) };
    forgot.claims[1].checks[0].given = [];
    forgot.claims[2].checks.pop();
    const { record, calls, events, plans, log, userText } = await fromModel("clear-completed-correct", CLEAR_SORT, forgot, { checks: good.claims[1].checks });
    assert.equal(calls, 3, log);
    assert.deepEqual(callsOf(events), ["sort", "plan", "repair"], log);
    assert.deepEqual(
      rehearsed(events, "c2.1").map(({ side, ready }) => [side, ready]),
      [["old", false], ["new", false], ["old", false], ["new", true]],
      `with no setup c2.1 fails on both apps; repaired, it fails on the old app and is kept because the new one passes\n${log}`,
    );
    assert.ok(userText(2).includes('when step 1 click button "Clear completed": nothing matched its target before the "when" steps'), userText(2));
    assert.deepEqual(notReady(events), [], `after the repair every check is ready\n${log}`);
    assert.deepEqual(plans, [false, false, true], log);
    assert.ok(record.verdict.kind === "PROVEN", JSON.stringify(record.verdict));
  });

  test("the vacuous plan never proves delete-bug", async () => {
    const record = await fromFile("vacuous", "delete-bug");
    assert.equal(record.verdict.kind, "NOT PROVEN");
    assert.deepEqual(record.verdict.checks.map((outcome) => outcome.result), ["could_not_run"]);
  });

  test("a change that only adds a comment is never PROVEN, whether the plan skips the focus promises or calls them not testable", async () => {
    const dir = await mkdtemp(join(REPO, "practice/demo-todo/prs/do-nothing-"));
    try {
      const firstLine = (await readFile(join(REPO, "practice/demo-todo/public/app.js"), "utf8")).split("\n")[0];
      await writeFile(join(dir, "change.diff"), `--- a/public/app.js\n+++ b/public/app.js\n@@ -1 +1,2 @@\n+// The add form is found once, at start.\n ${firstLine}\n`);
      await copyFile(join(caseDir("delete-correct"), "pr.md"), join(dir, "pr.md"));
      const focusPromises = sentencesOf(await readFile(join(dir, "pr.md"), "utf8")).slice(0, 4);
      const removal = JSON.parse(await readFile(fixture("good"), "utf8")).claims
        .find((claim: { quote: string }) => claim.quote === "Delete still removes only the task you clicked.");
      const plans = {
        skips: { claims: [removal], notTestable: [] },
        excuses: { claims: [removal], notTestable: focusPromises.map((quote) => ({ quote, reason: "Focus is not something a user can see." })) },
      };
      for (const [name, plan] of Object.entries(plans)) await writeFile(join(dir, `${name}.json`), JSON.stringify(plan));
      const [skips, excuses] = await Promise.all(Object.keys(plans).map((name) =>
        verify(dir, { plan: { kind: "file", path: join(dir, `${name}.json`) }, runsDir })));

      assert.ok(skips.verdict.kind === "NOT PROVEN");
      const [halted] = skips.verdict.blockers;
      assert.ok(halted.reason === "halted" && halted.halt.reason === "no_valid_plan", JSON.stringify(halted));
      assert.equal(halted.halt.problems.length, 4);
      assert.match(halted.halt.problems[1], /^sentence 2 of the PR text, "Now focus moves to the Delete button of the next task\.", is neither quoted by a claim nor marked not testable/);

      assert.ok(excuses.verdict.kind === "NOT PROVEN");
      assert.deepEqual(excuses.verdict.checks.map((outcome) => outcome.result), ["passed"]);
      assert.deepEqual(excuses.verdict.blockers, [{ reason: "no_check_fails_before" }]);
      assert.deepEqual(excuses.baseline.map((run) => [run.checkId, run.steps.every((step) => step.status === "passed")]), [["c1.1", true]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a model plan is sorted before it is planned, and the sorter's call counts in the plan's totals", async () => {
    const prText = await readFile(join(caseDir("delete-correct"), "pr.md"), "utf8");
    const history = "History: how focus moved before this change.";
    const { claims } = JSON.parse(await readFile(fixture("good"), "utf8"));
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt: [system] }) => reply(system.role === "system" && system.content.startsWith(systemPrompt("sort-sentences"))
        ? { notTestable: [{ sentence: 1, reason: history }] }
        : { claims }),
    });
    const record = await verify(caseDir("delete-correct"), { plan: { kind: "model", model }, runsDir });
    assert.ok(record.verdict.kind === "PROVEN", JSON.stringify(record.verdict));
    assert.deepEqual(record.scenario?.source, { kind: "model", modelId: "mock-model-id", calls: 2, usage: { inputTokens: 200, outputTokens: 20 } });
    assert.deepEqual(record.scenario.notTestable, [{ quote: sentencesOf(prText)[0], reason: history }]);
    assert.equal(await readFile(join(record.dir, "sort-input.md"), "utf8"), renderSortInput(prText));
    assert.match(await readFile(join(record.dir, "planner-input.md"), "utf8"), /# Sentences marked not testable\n1\. After you delete a task/);
  });

  test("a sorter that fails twice stops the run as NOT PROVEN before any plan is written", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [reply({ notTestable: [{ sentence: 9, reason: "Link: an issue." }] }), reply({ notTestable: [{ sentence: 9, reason: "Link: an issue." }] })],
    });
    const record = await verify(caseDir("delete-bug"), { plan: { kind: "model", model }, runsDir });
    assert.ok(record.verdict.kind === "NOT PROVEN");
    assert.deepEqual(record.verdict.blockers, [{
      reason: "halted",
      halt: { stage: "sort", reason: "no_valid_sort", problems: ["notTestable 1: there is no sentence 9; the sentences are numbered 1 to 5"] },
    }]);
    assert.equal(model.doGenerateCalls.length, 2);
    assert.equal(record.scenario, null);
    assert.match(await readFile(join(record.dir, "report.txt"), "utf8"), /^Stopped: the PR's sentences could not be sorted into testable and not testable\.$/m);
  });

  test("the CLI exits 0 for PROVEN and 1 for NOT PROVEN", async () => {
    const [proven, notProven] = await Promise.all([
      cli(["verify", caseDir("delete-correct"), "--scenario", fixture("good")]),
      cli(["verify", caseDir("delete-bug"), "--scenario", fixture("good")]),
    ]);
    assert.equal(proven.code, 0, proven.stderr);
    assert.match(proven.stdout, /^PROVEN for /m);
    assert.equal(notProven.code, 1, notProven.stderr);
    assert.match(notProven.stdout, /^NOT PROVEN for /m);
  });

  test("the CLI exits 2 for a path that is not a case", async () => {
    const result = await cli(["verify", join(REPO, "practice/demo-todo/prs/no-such-case"), "--scenario", fixture("good")]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is not a case folder/);
  });

  const stops = [
    { signal: "SIGINT", closeStderr: false, says: "Stopping after cleanup (SIGINT). Press Ctrl-C again to quit at once." },
    { signal: "SIGTERM", closeStderr: false, says: "Stopping after cleanup (SIGTERM). Send it again to quit at once." },
    { signal: "SIGHUP", closeStderr: false, says: "Stopping after cleanup (SIGHUP). Send it again to quit at once." },
    { signal: "SIGHUP", closeStderr: true, says: null },
  ] as const;
  for (const { signal, closeStderr, says } of stops) {
    const name = `${signal}${closeStderr ? ", with the terminal's end of stderr already closed," : ""}`;
    test(`${name} stops the CLI with 130, records the run as interrupted, and leaves no container or network behind`, async () => {
      const result = await cli(["verify", caseDir("delete-correct"), "--scenario", fixture("good")], { signal, afterMs: 3_000, closeStderr });
      assert.equal(result.code, 130, result.stderr);
      if (says) assert.ok(result.stderr.includes(`${says}\n`), result.stderr);
      assert.match(result.stdout, /Stopped: interrupted\./);
      const verdict = result.record?.verdict;
      assert.ok(verdict?.kind === "NOT PROVEN", JSON.stringify(verdict));
      const [blocker] = verdict.blockers;
      assert.ok(blocker.reason === "halted" && blocker.halt.reason === "interrupted", JSON.stringify(blocker));
      for (const list of [["ps", "-a"], ["network", "ls"]]) {
        const { stdout } = await exec("docker", [...list, "--quiet", "--filter", `label=umbreon.owner=${result.pid}`]);
        assert.equal(stdout.trim(), "", `docker ${list.join(" ")}`);
      }
    });
  }
});
