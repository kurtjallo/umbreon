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
export type Case = { name: string; caseDir: string; appDir: string; prText: string; diffFile: string };
export type Repo = { dir: string; commit: string };
export type PreparedApp =
  | { ok: true; old: Repo; new: Repo; diff: string; title: string }
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

const git = (dir: string, args: string[]) => exec("git", ["-C", dir, ...args], { env: GIT_ENV });
const docker = (args: string[]) => exec("docker", args, { maxBuffer: 64 * 1024 * 1024 });
const stderrOf = (e: unknown) => String((e as { stderr?: string }).stderr || e).trim();

export async function loadCase(caseDir: string): Promise<Case> {
  const dir = resolve(caseDir);
  const appDir = resolve(dir, "../..");
  const diffFile = join(dir, "change.diff");
  try {
    const prText = await readFile(join(dir, "pr.md"), "utf8");
    await access(diffFile);
    await access(join(appDir, "package.json"));
    return { name: basename(dir), caseDir: dir, appDir, prText, diffFile };
  } catch (e) {
    throw new SetupError(`${dir} is not a case folder: ${(e as Error).message}`);
  }
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
  const title = c.prText.split("\n", 1)[0].replace(/^#\s*/, "").trim();
  const commit = await commitAll(newDir, title);
  const { stdout: diff } = await git(newDir, ["diff", base, commit]);
  return { ok: true, old: { dir: oldDir, commit: base }, new: { dir: newDir, commit }, diff, title };
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
  const logs = () => logsOf(name);
  try {
    // No --rm, so a crashed container stays long enough to read its logs.
    // No signal either: killing the CLI mid-create can leave a container that appears after the rm below.
    await docker([
      "run", "-d", "--name", name,
      "--label", `umbreon.owner=${process.pid}`, "--label", `umbreon.run=${labels.runId}`,
      "-p", `127.0.0.1::${profile.port}`,
      // -v needs an absolute path; a bare name would mean a named volume.
      "-v", `${resolve(repoDir)}:/app:ro`, "-w", "/app",
      "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "512m", "--pids-limit", "256",
      ...Object.entries(profile.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      profile.image, ...profile.command,
    ]);
    signal.throwIfAborted();
    const origin = await originOf(name, profile.port, logs);
    await waitReady(name, origin + profile.readyPath, signal, logs);
    return await use({ origin, startUrl: origin + profile.startPath, alive: () => isRunning(name), logs });
  } finally {
    await exec("docker", ["rm", "-f", name], { timeout: 10_000 }).catch(() => {});
  }
}

async function originOf(name: string, port: number, logs: () => Promise<string>): Promise<string> {
  try {
    const { stdout } = await docker(["port", name, `${port}/tcp`]);
    return `http://${stdout.trim().split("\n")[0]}`;
  } catch (e) {
    // `docker port` fails on a container that already exited, so a crash shows up here first.
    if (!(await isRunning(name))) throw new AppNeverReady(await logs());
    throw e;
  }
}

async function waitReady(name: string, url: string, signal: AbortSignal, logs: () => Promise<string>) {
  const deadline = Date.now() + 20_000;
  for (let poll = 1; ; poll++) {
    if (await answers200(url, signal)) return;
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new AppNeverReady(await logs());
    if (poll % 10 === 0 && !(await isRunning(name))) throw new AppNeverReady(await logs());
    await sleep(100);
  }
}

// An open port is not enough: Docker Desktop accepts the connection before the app listens,
// then closes it with no reply.
async function answers200(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
    await res.arrayBuffer();
    return res.status === 200;
  } catch {
    return false;
  }
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
  const { stdout } = await docker([
    "ps", "-a", "--filter", "label=umbreon.owner", "--format", '{{.Names}}\t{{.Label "umbreon.owner"}}',
  ]);
  const orphans = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([, pid]) => !isAlive(Number(pid)))
    .map(([name]) => name);
  if (orphans.length > 0) await docker(["rm", "-f", ...orphans]);
  return orphans;
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
