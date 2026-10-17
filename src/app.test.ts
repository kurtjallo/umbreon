import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AppNeverReady, DEMO_TODO, loadCase, preflight, prepareApp, sweepOrphans, withApp } from "./app.ts";

const exec = promisify(execFile);
const APP_DIR = fileURLToPath(new URL("../practice/demo-todo", import.meta.url));
const CASE_DIR = join(APP_DIR, "prs", "delete-correct");

let tmp = "";
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "umbreon-app-test-"));
  await preflight(DEMO_TODO);
});
after(() => rm(tmp, { recursive: true, force: true }));

const exists = (path: string) => stat(path).then(() => true, () => false);
const runId = (check: string) => `test-${process.pid}-${check}`;

async function containersOfRun(id: string): Promise<string[]> {
  const { stdout } = await exec("docker", ["ps", "-a", "--filter", `label=umbreon.run=${id}`, "--format", "{{.Names}}"]);
  return stdout.split("\n").filter(Boolean).sort();
}

async function titles(origin: string): Promise<string[]> {
  const res = await fetch(`${origin}/api/tasks`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tasks: { title: string }[] };
  return body.tasks.map((t) => t.title);
}

test("loadCase reads pr.md and change.diff and never expected.json", async () => {
  const c = await loadCase(CASE_DIR);
  assert.deepEqual(c, {
    name: "delete-correct",
    caseDir: CASE_DIR,
    appDir: APP_DIR,
    prText: await readFile(join(CASE_DIR, "pr.md"), "utf8"),
    diffFile: join(CASE_DIR, "change.diff"),
  });

  const copy = join(tmp, "locked-app", "prs", "delete-correct");
  await cp(CASE_DIR, copy, { recursive: true });
  await writeFile(join(tmp, "locked-app", "package.json"), "{}");
  await chmod(join(copy, "expected.json"), 0o000);
  assert.equal((await loadCase(copy)).prText, c.prText, "loads with expected.json unreadable");
});

test("prepareApp gives the same commits every time and leaves prs/ out", async () => {
  const c = await loadCase(CASE_DIR);
  const a = await prepareApp(c, join(tmp, "prepare-a"));
  const b = await prepareApp(c, join(tmp, "prepare-b"));
  assert.ok(a.ok && b.ok);
  assert.equal(a.old.commit, b.old.commit);
  assert.equal(a.new.commit, b.new.commit);
  assert.notEqual(a.old.commit, a.new.commit);
  assert.equal(a.title, "Keep focus in the task list after deleting");
  for (const dir of [a.old.dir, a.new.dir]) assert.equal(await exists(join(dir, "prs")), false, `${dir} has no prs/`);

  const changed = [...a.diff.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]);
  assert.deepEqual(changed, ["public/app.js"]);
  const line = "const index = removeTask(confirming.id);";
  assert.equal((await readFile(join(a.old.dir, "public/app.js"), "utf8")).includes(line), false);
  assert.equal((await readFile(join(a.new.dir, "public/app.js"), "utf8")).includes(line), true);
});

test("prepareApp reports a diff that does not apply", async () => {
  const diffFile = join(tmp, "stale.diff");
  await writeFile(
    diffFile,
    "diff --git a/public/app.js b/public/app.js\n--- a/public/app.js\n+++ b/public/app.js\n" +
      "@@ -1,1 +1,1 @@\n-this line is not in app.js\n+replacement\n",
  );
  const result = await prepareApp({ ...(await loadCase(CASE_DIR)), diffFile }, join(tmp, "stale"));
  assert.ok(!result.ok, "the stale diff does not apply");
  assert.match(result.base, /^[0-9a-f]{40}$/);
  assert.match(result.detail, /patch failed/);
});

test("withApp runs the old app in a locked-down container and removes it", async (t) => {
  const prepared = await prepareApp(await loadCase(CASE_DIR), join(tmp, "serve"));
  assert.ok(prepared.ok);
  const id = runId("serve");
  const started = performance.now();
  await withApp(prepared.old.dir, DEMO_TODO, { runId: id, check: "c1.1" }, AbortSignal.timeout(60_000), async (app) => {
    t.diagnostic(`ready in ${Math.round(performance.now() - started)} ms`);
    assert.match(app.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(app.startUrl, `${app.origin}/`);
    assert.equal(await app.alive(), true);
    assert.deepEqual(await titles(app.origin), []);

    const created = await fetch(`${app.origin}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Alpha" }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await titles(app.origin), ["Alpha"]);
    assert.match(await app.logs(), /Listening on http:\/\/0\.0\.0\.0:3000/);

    const { stdout } = await exec("docker", ["inspect", "-f", "{{json .HostConfig}}", `umbreon-${id}-c1.1`]);
    const host = JSON.parse(stdout);
    assert.deepEqual(
      {
        readOnly: host.ReadonlyRootfs,
        binds: host.Binds,
        capDrop: host.CapDrop,
        securityOpt: host.SecurityOpt,
        memory: host.Memory,
        pids: host.PidsLimit,
        ports: host.PortBindings,
        autoRemove: host.AutoRemove,
      },
      {
        readOnly: true,
        binds: [`${prepared.old.dir}:/app:ro`],
        capDrop: ["ALL"],
        securityOpt: ["no-new-privileges"],
        memory: 512 * 1024 * 1024,
        pids: 256,
        ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        autoRemove: false,
      },
    );
  });
  assert.deepEqual(await containersOfRun(id), []);
});

test("withApp reports a crashed app with the logs from stderr", async (t) => {
  const crash = { ...DEMO_TODO, command: ["node", "-e", "console.error('boom'); process.exit(3)"] };
  const id = runId("crash");
  const started = performance.now();
  await assert.rejects(
    withApp(tmp, crash, { runId: id, check: "c1.1" }, AbortSignal.timeout(60_000), async () => assert.fail("never ready")),
    (e) => e instanceof AppNeverReady && e.logs.includes("boom"),
  );
  const elapsed = Math.round(performance.now() - started);
  t.diagnostic(`crash reported in ${elapsed} ms`);
  assert.ok(elapsed < 2_500, `crash reported in ${elapsed} ms`);
  assert.deepEqual(await containersOfRun(id), []);
});

test("withApp stops waiting on abort and still removes the container", async () => {
  const silent = { ...DEMO_TODO, command: ["node", "-e", "setInterval(() => {}, 1000)"] };
  const id = runId("abort");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_500);
  await assert.rejects(
    withApp(tmp, silent, { runId: id, check: "c1.1" }, controller.signal, async () => assert.fail("never ready")),
    { name: "AbortError" },
  );
  assert.deepEqual(await containersOfRun(id), []);
});

test("sweepOrphans removes containers whose owner died and keeps the rest", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  assert.ok(child.pid);
  const id = runId("sweep");
  const dead = `umbreon-${id}-dead`;
  const live = `umbreon-${id}-live`;
  const root = `umbreon-${id}-root`;
  // pid 1 is launchd, owned by root, so checking it fails with EPERM.
  for (const [name, pid] of [[dead, child.pid], [live, process.pid], [root, 1]] as const) {
    await exec("docker", ["create", "--name", name, "--label", `umbreon.owner=${pid}`, "--label", `umbreon.run=${id}`, DEMO_TODO.image, "true"]);
  }
  try {
    const removed = await sweepOrphans();
    assert.ok(removed.includes(dead), "removes the dead owner's container");
    assert.ok(!removed.includes(live), "keeps the live owner's container");
    assert.ok(!removed.includes(root), "keeps a container whose owner can't be signalled");
    assert.deepEqual(await sweepOrphans(), [], "a second sweep removes nothing");
    assert.deepEqual(await containersOfRun(id), [live, root]);
  } finally {
    await exec("docker", ["rm", "-f", dead, live, root]);
  }
});
