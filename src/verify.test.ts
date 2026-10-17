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
import { checksOf, sentencesOf } from "./scenario.ts";
import type { Evidence, RunRecord } from "./verdict.ts";
import { verify } from "./verify.ts";

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const caseDir = (name: string) => join(REPO, "practice/demo-todo/prs", name);
const fixture = (name: string) => join(REPO, `scripts/fixtures/demo-todo-${name}.json`);

let runsDir = "";
before(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "umbreon-verify-test-"));
});
after(() => rm(runsDir, { recursive: true, force: true }));

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

type Cli = { code: number | null; stdout: string; stderr: string };

/** Runs the CLI and removes the run folder it made under runs/. `interruptAfterMs` sends one SIGINT once the run has started. */
async function cli(args: string[], interruptAfterMs?: number): Promise<Cli & { pid: number }> {
  const child = spawn(process.execPath, ["src/cli.ts", ...args], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit");
  if (interruptAfterMs !== undefined) {
    const started = new Promise<void>((done) => child.stderr.on("data", () => /^run /m.test(stderr) && done()));
    await Promise.all([sleep(interruptAfterMs), started]);
    child.kill("SIGINT");
  }
  const [code] = (await exited) as [number | null];
  const runId = /^run (\S+)$/m.exec(stderr)?.[1];
  if (runId) await rm(join(REPO, "runs", runId), { recursive: true, force: true });
  return { code, stdout, stderr, pid: child.pid! };
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

  test("the good plan catches delete-bug with failed checks", async () => {
    const record = await fromFile("good", "delete-bug");
    assert.ok(record.verdict.kind === "NOT PROVEN");
    assert.deepEqual(record.verdict.blockers, [{ reason: "check_did_not_pass" }]);
    assert.ok(record.verdict.checks.some((outcome) => outcome.result === "failed"), "some check failed");
    assert.deepEqual(record.baseline, [], "the old app is not run once a check fails");
    await assertEvidence(record);
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

  test("Ctrl-C stops the CLI with 130 and leaves no container behind", async () => {
    const result = await cli(["verify", caseDir("delete-correct"), "--scenario", fixture("good")], 3_000);
    assert.equal(result.code, 130, result.stderr);
    assert.match(result.stdout, /Stopped: interrupted\./);
    const { stdout } = await exec("docker", ["ps", "-a", "--filter", `label=umbreon.owner=${result.pid}`, "--format", "{{.Names}}"]);
    assert.equal(stdout.trim(), "");
  });
});
