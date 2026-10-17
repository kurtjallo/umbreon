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
const CASES = ["delete-correct", "delete-bug", "clear-completed-correct", "clear-completed-bug"];
const ORIGIN = "http://127.0.0.1:4180";

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

async function openWithTasks(page, titles) {
  await page.goto(ORIGIN);
  await page.getByText("No tasks yet. Add your first task above.", { exact: true }).waitFor();
  for (const title of titles) await addTask(page, title);
}

async function titleFacts(page) {
  const { tasks } = await (await fetch(`${ORIGIN}/api/tasks`)).json();
  return {
    screen: JSON.stringify(await page.locator(".task-title").allTextContents()),
    api: JSON.stringify(tasks.map((task) => task.title)),
  };
}

const EXAMS = {
  delete: {
    want: { screen: '["Buy milk"]', api: '["Buy milk"]', focus: '- button "Delete Buy milk": Delete' },
    async run(page) {
      await openWithTasks(page, ["Buy milk", "Walk dog"]);
      await page.getByRole("button", { name: "Delete Walk dog", exact: true }).click();
      await page.getByRole("dialog", { name: "Delete task?", exact: true }).getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Task deleted." }).waitFor();

      const focused = page.locator(":focus");
      return {
        ...(await titleFacts(page)),
        focus: (await focused.count()) === 1 ? await focused.ariaSnapshot() : "nothing focused",
      };
    },
  },
  "clear-completed": {
    want: { screen: '["Walk dog"]', api: '["Walk dog"]', clearButton: "gone" },
    async run(page) {
      await openWithTasks(page, ["Buy milk", "Walk dog", "Pay rent"]);
      await page.getByRole("checkbox", { name: "Buy milk", exact: true }).check();
      await page.getByRole("checkbox", { name: "Pay rent", exact: true }).check();
      await page.getByText("2 of 3 done", { exact: true }).waitFor();
      const clear = page.getByRole("button", { name: "Clear completed", exact: true });
      await clear.click();
      await page.getByRole("status").filter({ hasText: "Completed tasks cleared." }).waitFor();

      return { ...(await titleFacts(page)), clearButton: (await clear.isVisible()) ? "visible" : "gone" };
    },
  },
};

async function runCase(name, exam) {
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
        return { ...tests, facts: await exam.run(await browser.newPage()) };
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
  const exam = EXAMS[name.replace(/-(correct|bug)$/, "")];
  const { testsPassed, testOutput, facts } = await runCase(name, exam);
  const { verdict: expected } = JSON.parse(await readFile(path.join(APP_ROOT, "prs", name, "expected.json"), "utf8"));
  const failed = Object.keys(exam.want).filter((fact) => facts[fact] !== exam.want[fact]);
  const got = failed.length === 0 ? "PROVEN" : "NOT PROVEN";
  const match = testsPassed && got === expected;
  allMatch &&= match;

  console.log(
    name.padEnd(25) +
      `app tests: ${testsPassed ? "pass" : "fail"}`.padEnd(18) +
      `expected: ${expected}`.padEnd(23) +
      `got: ${got}`.padEnd(18) +
      (match ? "✅" : "❌"),
  );
  for (const fact of failed) console.log(`  ${fact}: ${facts[fact]}`);
  if (!testsPassed) console.log(testOutput.trimEnd());
}
process.exitCode = allMatch ? 0 : 1;
