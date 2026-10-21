import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { answers200, AppNeverReady, DEMO_TODO, loadCase, preflight, prepareApp, SetupError, sweepOrphans, withApp } from "./app.ts";

const exec = promisify(execFile);
const APP_DIR = fileURLToPath(new URL("../practice/demo-todo", import.meta.url));
const CASE_DIR = join(APP_DIR, "prs", "delete-correct");

let tmp = "";
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "umbreon-app-test-"));
  await preflight(DEMO_TODO);
});
after(() => rm(tmp, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@localhost",
};
const commitRepo = async (dir: string) => {
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "app"]]) await exec("git", ["-C", dir, ...args], { env: GIT_ENV });
};
const exists = (path: string) => stat(path).then(() => true, () => false);
const listen = (server: http.Server) => new Promise<string>((done) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    done(`http://127.0.0.1:${address.port}`);
  });
});

test("a redirect off the app is not a ready answer, and a redirect on the app is", async () => {
  let elsewhere = 0;
  const other = http.createServer((_req, res) => { elsewhere++; res.writeHead(200); res.end("elsewhere"); });
  const otherOrigin = await listen(other);
  const app = http.createServer((req, res) => {
    if (req.url === "/ready") { res.writeHead(200); res.end("ok"); return; }
    if (req.url === "/same") { res.writeHead(302, { Location: "/ready" }); res.end(); return; }
    res.writeHead(302, { Location: `${otherOrigin}/stolen` });
    res.end();
  });
  const origin = await listen(app);
  try {
    assert.equal(await answers200(`${origin}/ready`, AbortSignal.timeout(2_000)), true);
    assert.equal(await answers200(`${origin}/same`, AbortSignal.timeout(2_000)), true);
    assert.equal(await answers200(`${origin}/away`, AbortSignal.timeout(2_000)), false);
    assert.equal(elsewhere, 0);
  } finally {
    other.close();
    app.close();
  }
});
const runId = (check: string) => `test-${process.pid}-${check}`;

async function containersOfRun(id: string): Promise<string[]> {
  const { stdout } = await exec("docker", ["ps", "-a", "--filter", `label=umbreon.run=${id}`, "--format", "{{.Names}}"]);
  return stdout.split("\n").filter(Boolean).sort();
}

async function networksOfRun(id: string): Promise<string[]> {
  const { stdout } = await exec("docker", ["network", "ls", "--filter", `label=umbreon.run=${id}`, "--format", "{{.Name}}"]);
  return stdout.split("\n").filter(Boolean).sort();
}

async function inspect(name: string) {
  return JSON.parse((await exec("docker", ["inspect", name])).stdout)[0];
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  assert.ok(child.pid);
  return child.pid;
}

/** A running container on its own internal network, both labeled as owned by `pid`, the way withApp leaves them. */
async function plant(name: string, pid: number, id: string): Promise<void> {
  const owner = ["--label", `umbreon.owner=${pid}`, "--label", `umbreon.run=${id}`];
  await exec("docker", ["network", "create", "--internal", ...owner, `${name}-net`]);
  await exec("docker", ["run", "-d", "--name", name, ...owner, "--network", `${name}-net`, DEMO_TODO.image, "node", "-e", "setInterval(() => {}, 1e9)"]);
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
    title: "Keep focus in the task list after deleting",
    diffFile: join(CASE_DIR, "change.diff"),
  });

  const copy = join(tmp, "locked-app", "prs", "delete-correct");
  await cp(CASE_DIR, copy, { recursive: true });
  await writeFile(join(tmp, "locked-app", "package.json"), "{}");
  await commitRepo(join(tmp, "locked-app"));
  await chmod(join(copy, "expected.json"), 0o000);
  assert.equal((await loadCase(copy)).prText, c.prText, "loads with expected.json unreadable");
});

test("loadCase rejects a pr.md whose first line has no title, naming the file", async () => {
  for (const [name, firstLine] of [["empty", ""], ["hash", "#"], ["hash-space", "#   "]]) {
    const dir = join(tmp, "untitled-app", "prs", name);
    await cp(CASE_DIR, dir, { recursive: true });
    await writeFile(join(tmp, "untitled-app", "package.json"), "{}");
    await writeFile(join(dir, "pr.md"), `${firstLine}\nDelete keeps focus in the list.\n`);
    await assert.rejects(loadCase(dir), (e) => e instanceof SetupError && e.message.includes(join(dir, "pr.md")), name);
  }
});

test("loadCase rejects an app with uncommitted changes outside prs/, because the run tests the committed app", async () => {
  const app = join(tmp, "dirty-app");
  const dir = join(app, "prs", "delete-correct");
  await cp(CASE_DIR, dir, { recursive: true });
  await writeFile(join(app, "package.json"), "{}");
  await writeFile(join(app, "server.js"), "// v1\n");
  await commitRepo(app);
  await writeFile(join(dir, "notes.txt"), "a change to a case is not a change to the app\n");
  assert.equal((await loadCase(dir)).name, "delete-correct", "a change under prs/ is allowed");

  const rejects = (file: string) =>
    assert.rejects(loadCase(dir), (e) => e instanceof SetupError && /commit or stash/.test(e.message) && e.message.includes(file), file);
  await writeFile(join(app, "server.js"), "// v2\n");
  await rejects("server.js");
  await writeFile(join(app, "server.js"), "// v1\n");
  await writeFile(join(app, "extra.js"), "// not yet added\n");
  await rejects("extra.js");
});

test("prepareApp gives the same commits every time and leaves prs/ out", async () => {
  const c = await loadCase(CASE_DIR);
  const a = await prepareApp(c, join(tmp, "prepare-a"));
  const b = await prepareApp(c, join(tmp, "prepare-b"));
  assert.ok(a.ok && b.ok);
  assert.equal(a.old.commit, b.old.commit);
  assert.equal(a.new.commit, b.new.commit);
  assert.notEqual(a.old.commit, a.new.commit);
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

    const name = `umbreon-${id}-c1.1`;
    const shape = (c: any) => ({
      user: c.Config.User,
      readOnly: c.HostConfig.ReadonlyRootfs,
      tmpfs: c.HostConfig.Tmpfs,
      binds: c.HostConfig.Binds,
      capDrop: c.HostConfig.CapDrop,
      securityOpt: c.HostConfig.SecurityOpt,
      memory: c.HostConfig.Memory,
      pids: c.HostConfig.PidsLimit,
      ports: c.HostConfig.PortBindings,
      networks: Object.keys(c.NetworkSettings.Networks).sort(),
      autoRemove: c.HostConfig.AutoRemove,
    });
    const locked = {
      user: "node",
      readOnly: true,
      tmpfs: { "/tmp": "" },
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges"],
      memory: 512 * 1024 * 1024,
      pids: 256,
      autoRemove: false,
    };
    assert.deepEqual(shape(await inspect(name)), {
      ...locked,
      binds: [`${prepared.old.dir}:/app:ro`],
      ports: {},
      networks: [`${name}-net`],
    });
    assert.deepEqual(shape(await inspect(`${name}-proxy`)), {
      ...locked,
      binds: null,
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
      networks: ["bridge", `${name}-net`],
    });
    assert.equal((await inspect(`${name}-net`)).Internal, true);
  });
  assert.deepEqual(await containersOfRun(id), []);
  assert.deepEqual(await networksOfRun(id), []);
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
  assert.deepEqual(await networksOfRun(id), []);
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
  assert.deepEqual(await networksOfRun(id), []);
});

// Other test files sweep at the same time and may take this file's orphan first, so these tests check what is left.
test("sweepOrphans removes containers and networks whose owner died and keeps the rest", async () => {
  const id = runId("sweep");
  const dead = `umbreon-${id}-dead`;
  const live = `umbreon-${id}-live`;
  const root = `umbreon-${id}-root`;
  // pid 1 is launchd, owned by root, so checking it fails with EPERM.
  for (const [name, pid] of [[dead, await deadPid()], [live, process.pid], [root, 1]] as const) await plant(name, pid, id);
  try {
    const removed = (await sweepOrphans()).filter((name) => name.includes(id));
    assert.deepEqual(removed.filter((name) => !name.startsWith(dead)), [], "keeps the live owner's and root's");
    assert.deepEqual(await containersOfRun(id), [live, root]);
    assert.deepEqual(await networksOfRun(id), [`${live}-net`, `${root}-net`]);
    assert.deepEqual((await sweepOrphans()).filter((name) => name.includes(id)), [], "a second sweep removes nothing");
  } finally {
    await exec("docker", ["rm", "-f", dead, live, root]);
    await exec("docker", ["network", "rm", "-f", `${dead}-net`, `${live}-net`, `${root}-net`]);
  }
});

test("sweeps running at once over the same orphan all succeed and remove it", async () => {
  const id = runId("race");
  await plant(`umbreon-${id}-orphan`, await deadPid(), id);
  const sweeps = await Promise.allSettled([sweepOrphans(), sweepOrphans(), sweepOrphans()]);
  assert.deepEqual(sweeps.map((s) => (s.status === "rejected" ? String(s.reason) : "swept")), ["swept", "swept", "swept"]);
  assert.deepEqual(await containersOfRun(id), []);
  assert.deepEqual(await networksOfRun(id), []);
});

const CONNECT = `const s = require("net").connect(Number(process.argv[2]), process.argv[1]);
s.setTimeout(3000, () => { console.log("timeout"); s.destroy(); });
s.on("connect", () => { console.log("connected"); s.destroy(); });
s.on("error", (e) => console.log(e.code));`;

test("the app's container reaches neither the internet nor this machine", async () => {
  let connections = 0;
  const host = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
  const { port } = host.address() as AddressInfo;
  const prepared = await prepareApp(await loadCase(CASE_DIR), join(tmp, "isolated"));
  assert.ok(prepared.ok);
  const id = runId("isolated");
  try {
    await withApp(prepared.old.dir, DEMO_TODO, { runId: id, check: "c1.1" }, AbortSignal.timeout(60_000), async () => {
      // The app can't resolve host.docker.internal, so its address comes from the proxy, which can.
      const { stdout: hosts } = await exec("docker", ["exec", `umbreon-${id}-c1.1-proxy`, "getent", "ahostsv4", "host.docker.internal"]);
      const hostIp = hosts.split(/\s/)[0];
      for (const [address, toPort] of [["1.1.1.1", "80"], ["host.docker.internal", String(port)], [hostIp, String(port)]]) {
        const { stdout } = await exec("docker", ["exec", `umbreon-${id}-c1.1`, "node", "-e", CONNECT, address, toPort]);
        assert.match(stdout.trim(), /^(E[A-Z_]+|timeout)$/, `${address}:${toPort} gave ${stdout.trim()}`);
      }
    });
  } finally {
    host.close();
  }
  assert.equal(connections, 0, "the server on this machine saw no connection");
});
