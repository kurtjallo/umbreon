import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_FILES = ["server.js", "package.json", "playwright.config.js", "public", "tests"];
const CASES = ["delete-correct", "delete-bug"];
const ORIGIN = "http://127.0.0.1:4180";
const WANT = {
  screen: '["Buy milk"]',
  api: '["Buy milk"]',
  focus: '- button "Delete Buy milk": Delete',
};

const run = promisify(execFile);

async function copyApp(name, dir) {
  for (const file of APP_FILES) await cp(path.join(APP_ROOT, file), path.join(dir, file), { recursive: true });
  await symlink(path.join(APP_ROOT, "node_modules"), path.join(dir, "node_modules"));
  await run("git", ["apply", path.join(APP_ROOT, "prs", name, "change.diff")], { cwd: dir });
}

async function appTests(dir) {
  try {
    await run("npx", ["playwright", "test"], { cwd: dir });
    return { testsPassed: true };
  } catch (error) {
    return { testsPassed: false, testOutput: `${error.stdout}${error.stderr}` };
  }
}

async function waitForServer(server) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}`);
    if (await fetch(`${ORIGIN}/api/tasks`).then((response) => response.ok, () => false)) return;
    await sleep(100);
  }
  throw new Error(`server never answered ${ORIGIN}/api/tasks`);
}

async function addTask(page, title) {
  const form = page.getByRole("form", { name: "Add task" });
  await form.getByLabel("Title", { exact: true }).fill(title);
  await form.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("listitem").filter({ hasText: title }).waitFor();
}

async function exam(page) {
  await page.goto(ORIGIN);
  await page.getByText("No tasks yet. Add your first task above.", { exact: true }).waitFor();
  await addTask(page, "Buy milk");
  await addTask(page, "Walk dog");
  await page.getByRole("button", { name: "Delete Walk dog", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete task?", exact: true }).getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Task deleted." }).waitFor();

  const { tasks } = await (await fetch(`${ORIGIN}/api/tasks`)).json();
  const focused = page.locator(":focus");
  return {
    screen: JSON.stringify(await page.locator(".task-title").allTextContents()),
    api: JSON.stringify(tasks.map((task) => task.title)),
    focus: (await focused.count()) === 1 ? await focused.ariaSnapshot() : "nothing focused",
  };
}

async function runCase(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `demo-todo-${name}-`));
  try {
    await copyApp(name, dir);
    const tests = await appTests(dir);
    const server = spawn(process.execPath, ["server.js"], {
      cwd: dir,
      env: { ...process.env, PORT: "4180", HOST: "127.0.0.1", DB_PATH: path.join(dir, "exam.db") },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const exited = once(server, "exit");
    try {
      await waitForServer(server);
      const browser = await chromium.launch();
      try {
        return { ...tests, facts: await exam(await browser.newPage()) };
      } finally {
        await browser.close();
      }
    } finally {
      server.kill();
      await exited;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let allMatch = true;
for (const name of CASES) {
  const { testsPassed, testOutput, facts } = await runCase(name);
  const { verdict: expected } = JSON.parse(await readFile(path.join(APP_ROOT, "prs", name, "expected.json"), "utf8"));
  const failed = Object.keys(WANT).filter((fact) => facts[fact] !== WANT[fact]);
  const got = failed.length === 0 ? "PROVEN" : "NOT PROVEN";
  const match = testsPassed && got === expected;
  allMatch &&= match;

  console.log(
    name.padEnd(17) +
      `app tests: ${testsPassed ? "pass" : "fail"}`.padEnd(18) +
      `expected: ${expected}`.padEnd(23) +
      `got: ${got}`.padEnd(18) +
      (match ? "✅" : "❌"),
  );
  for (const fact of failed) console.log(`  ${fact}: ${facts[fact]}`);
  if (!testsPassed) console.log(testOutput.trimEnd());
}
process.exitCode = allMatch ? 0 : 1;
