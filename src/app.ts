import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type AppProfile = {
  image: string;
  command: string[];
  port: number;
  env: Record<string, string>;
  readyPath: string;
  startPath: string;
};

export const DEMO_TODO: AppProfile = {
  image: "node:24-slim",
  command: ["node", "server.js"],
  port: 3000,
  env: { HOST: "0.0.0.0", PORT: "3000", DB_PATH: "/tmp/app.db" },
  readyPath: "/api/tasks",
  startPath: "/",
};

// No field for expected.json: the answer key must never reach the planner.
export type Case = { name: string; caseDir: string; appDir: string; prText: string; title: string; diffFile: string };
export type Repo = { dir: string; commit: string };
export type PreparedApp =
  | { ok: true; old: Repo; new: Repo; diff: string }
  | { ok: false; base: string; detail: string };
export type RunningApp = { origin: string; startUrl: string; alive(): Promise<boolean>; logs(): Promise<string> };

export class SetupError extends Error {}

export class AppNeverReady extends Error {
  logs: string;
  constructor(logs: string) {
    super("app never answered");
    this.logs = logs;
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "umbreon",
  GIT_AUTHOR_EMAIL: "umbreon@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "umbreon",
  GIT_COMMITTER_EMAIL: "umbreon@localhost",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

const LOCKDOWN = [
  "--user", "node", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--memory", "512m", "--pids-limit", "256",
];

// The app's only network is internal, so this proxy is the one way in, and the app has no way out.
const PROXY = `const net = require("net");
const port = Number(process.argv[1]);
net.createServer((client) => {
  const app = net.connect(port, "app");
  client.on("error", () => app.destroy());
  app.on("error", () => client.destroy());
  client.pipe(app).pipe(client);
}).listen(port);`;

const git = (dir: string, args: string[]) => exec("git", ["-C", dir, ...args], { env: GIT_ENV });
const docker = (args: string[]) => exec("docker", args, { maxBuffer: 64 * 1024 * 1024 });
const stderrOf = (e: unknown) => String((e as { stderr?: string }).stderr || e).trim();

export async function loadCase(caseDir: string): Promise<Case> {
  const dir = resolve(caseDir);
  const appDir = resolve(dir, "../..");
  const diffFile = join(dir, "change.diff");
  const prFile = join(dir, "pr.md");
  let prText: string;
  try {
    prText = await readFile(prFile, "utf8");
    await access(diffFile);
    await access(join(appDir, "package.json"));
  } catch (e) {
    throw new SetupError(`${dir} is not a case folder: ${(e as Error).message}`);
  }
  const title = prText.split("\n", 1)[0].replace(/^#\s*/, "").trim();
  if (!title) throw new SetupError(`${prFile} has no title: its first line must be the PR title`);
  // The base app comes from `git archive HEAD`, so an edit that is not committed would be silently left out.
  const { stdout: dirty } = await git(appDir, ["status", "--porcelain", "--", ".", ":(exclude)prs"]);
  if (dirty) {
    throw new SetupError(`${appDir} has uncommitted changes. The run tests the committed app, so commit or stash them first:\n${dirty.trimEnd()}`);
  }
  return { name: basename(dir), caseDir: dir, appDir, prText, title, diffFile };
}

export async function prepareApp(c: Case, runDir: string): Promise<PreparedApp> {
  const root = resolve(runDir);
  const oldDir = join(root, "old");
  const newDir = join(root, "new");
  const tarFile = join(root, "base.tar");
  await mkdir(root, { recursive: true });
  // Not recursive: a reused run folder would make `git apply` fail and report a good diff as broken.
  await mkdir(oldDir);
  await git(c.appDir, ["archive", "-o", tarFile, "HEAD", "--", ".", ":(exclude)prs"]);
  await exec("tar", ["-x", "-f", tarFile, "-C", oldDir]);
  await rm(tarFile);
  if (await stat(join(oldDir, "prs")).then(() => true, () => false)) {
    throw new Error(`prs/ leaked into ${oldDir}`);
  }
  await git(oldDir, ["init", "-q"]);
  const base = await commitAll(oldDir, "base");

  await cp(oldDir, newDir, { recursive: true });
  try {
    await git(newDir, ["apply", c.diffFile]);
  } catch (e) {
    return { ok: false, base, detail: stderrOf(e) };
  }
  const commit = await commitAll(newDir, c.title);
  const { stdout: diff } = await git(newDir, ["diff", base, commit]);
  return { ok: true, old: { dir: oldDir, commit: base }, new: { dir: newDir, commit }, diff };
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function preflight(profile: AppProfile): Promise<{ imageId: string }> {
  try {
    await docker(["info"]);
  } catch {
    throw new SetupError("Docker is not running");
  }
  const inspect = ["image", "inspect", "-f", "{{.Id}}", profile.image];
  let found = await docker(inspect).catch(() => null);
  if (!found) {
    try {
      await docker(["pull", profile.image]);
    } catch (e) {
      throw new SetupError(`could not pull ${profile.image}: ${stderrOf(e)}`);
    }
    found = await docker(inspect);
  }
  return { imageId: found.stdout.trim() };
}

export async function withApp<T>(
  repoDir: string,
  profile: AppProfile,
  labels: { runId: string; check: string },
  signal: AbortSignal,
  use: (app: RunningApp) => Promise<T>,
): Promise<T> {
  const name = `umbreon-${labels.runId}-${labels.check}`;
  const proxy = `${name}-proxy`;
  const network = `${name}-net`;
  const owner = ["--label", `umbreon.owner=${process.pid}`, "--label", `umbreon.run=${labels.runId}`];
  const logs = () => logsOf(name);
  try {
    // No signal on these calls: killing the CLI mid-create can leave a container that appears after the removal below.
    await docker(["network", "create", "--internal", ...owner, network]);
    // No --rm, so a crashed container stays long enough to read its logs.
    await docker([
      "run", "-d", "--name", name, ...owner, ...LOCKDOWN,
      "--network", network, "--network-alias", "app",
      // -v needs an absolute path; a bare name would mean a named volume.
      "-v", `${resolve(repoDir)}:/app:ro`, "-w", "/app",
      ...Object.entries(profile.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      profile.image, ...profile.command,
    ]);
    // Docker refuses the default bridge and a user-defined network in one `run`, so the proxy joins the app's network after.
    await docker(["run", "-d", "--name", proxy, ...owner, ...LOCKDOWN, "-p", `127.0.0.1::${profile.port}`,
      profile.image, "node", "-e", PROXY, String(profile.port)]);
    await docker(["network", "connect", network, proxy]);
    signal.throwIfAborted();
    const { stdout } = await docker(["port", proxy, `${profile.port}/tcp`]);
    const origin = `http://${stdout.trim().split("\n")[0]}`;
    await waitReady(name, origin + profile.readyPath, signal, logs);
    return await use({ origin, startUrl: origin + profile.startPath, alive: () => isRunning(name), logs });
  } finally {
    await exec("docker", ["rm", "-f", name, proxy], { timeout: 10_000 }).catch(() => {});
    await exec("docker", ["network", "rm", "-f", network], { timeout: 10_000 }).catch(() => {});
  }
}

async function waitReady(name: string, url: string, signal: AbortSignal, logs: () => Promise<string>) {
  const deadline = Date.now() + 20_000;
  for (let poll = 1; ; poll++) {
    if (await answers200(url, signal)) return;
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new AppNeverReady(await logs());
    // The proxy answers for the app, so only `docker inspect` shows a crash. Poll 1 catches a crash on start;
    // later checks are spaced out because each one is a Docker call.
    if (poll % 10 === 1 && !(await isRunning(name))) throw new AppNeverReady(await logs());
    await sleep(100);
  }
}

// An open port is not enough: Docker Desktop accepts the connection before the app listens,
// then closes it with no reply. Redirects are followed only on this origin. The app is the PR under test,
// so a 3xx to anywhere else must not be requested, and a 200 from there must not count as ready.
export async function answers200(url: string, signal: AbortSignal): Promise<boolean> {
  const origin = new URL(url).origin;
  const poll = AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
  const seen = new Set<string>();
  let current = url;
  try {
    while (!seen.has(current)) {
      seen.add(current);
      const res = await fetch(current, { redirect: "manual", signal: poll });
      await res.arrayBuffer();
      if (res.status === 200) return true;
      if (res.status < 300 || res.status >= 400) return false;
      const location = res.headers.get("location");
      if (!location) return false;
      const next = new URL(location, current);
      if (next.origin !== origin) return false;
      current = next.href;
    }
  } catch {
    return false;
  }
  return false;
}

async function isRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await docker(["inspect", "-f", "{{.State.Running}}", name]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

// The app's errors arrive on stderr, so both streams are kept.
async function logsOf(name: string): Promise<string> {
  try {
    const { stdout, stderr } = await docker(["logs", name]);
    return stdout + stderr;
  } catch (e) {
    return `docker logs failed: ${stderrOf(e)}`;
  }
}

export async function sweepOrphans(): Promise<string[]> {
  const containers = await orphans(["ps", "-a"], "{{.Names}}");
  const networks = await orphans(["network", "ls"], "{{.Name}}");
  if (containers.length > 0) await removeOrphans(["rm", "-f", ...containers]);
  if (networks.length > 0) await removeOrphans(["network", "rm", "-f", ...networks]);
  return [...containers, ...networks];
}

// Another process may be sweeping the same orphans right now. Its container removals and the network endpoints they
// hold clear in moments, so these errors mean wait and retry until the orphans are gone; any other error is real.
const SETTLING = /No such container|is already in progress|has active endpoints|^exit status \d+$/;

async function removeOrphans(args: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await docker(args);
      return;
    } catch (e) {
      if (Date.now() > deadline || !stderrOf(e).split("\n").every((line) => SETTLING.test(line))) throw e;
      await sleep(100);
    }
  }
}

async function orphans(list: string[], nameFormat: string): Promise<string[]> {
  const { stdout } = await docker([...list, "--filter", "label=umbreon.owner", "--format", `${nameFormat}\t{{.Label "umbreon.owner"}}`]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([, pid]) => !isAlive(Number(pid)))
    .map(([found]) => found);
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
