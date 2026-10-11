import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESTART_ORIGIN = "http://127.0.0.1:4174";
const EMPTY_TEXT = "No tasks yet. Add your first task above.";
const SERVER_ERROR = {
  status: 500,
  contentType: "application/json",
  body: JSON.stringify({ error: "Something went wrong." }),
};

function taskRow(page, title) {
  return page.getByRole("listitem").filter({ hasText: title });
}

function alertsWithText(page) {
  return page.getByRole("alert").filter({ hasText: /\S/ });
}

async function openEmptyApp(page, url = "/") {
  await page.goto(url);
  await expect(page.getByText(EMPTY_TEXT, { exact: true })).toBeVisible();
}

async function addTask(page, title, description = "") {
  const form = page.getByRole("form", { name: "Add task" });
  await form.getByLabel("Title", { exact: true }).fill(title);
  await form.getByLabel("Description (optional)", { exact: true }).fill(description);
  await form.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("status")).toHaveText("Task added.");
  await expect(taskRow(page, title)).toBeVisible();
}

async function expectError(response, status, error) {
  expect(response.status()).toBe(status);
  expect(await response.json()).toEqual({ error });
}

function startServer(dbPath) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: "4174", HOST: "127.0.0.1", DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    const collect = (chunk) => {
      output += chunk;
      if (output.includes(`Listening on ${RESTART_ORIGIN}`)) resolve();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("exit", (code) => reject(new Error(`Server exited with ${code} before listening:\n${output}`)));
    setTimeout(() => reject(new Error(`Server did not print "Listening on" in time:\n${output}`)), 10_000).unref();
  });
  return { child, ready };
}

async function stopServer(child, killSignal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill(killSignal);
  const [code] = await exited;
  return code;
}

test.beforeEach(async ({ request }) => {
  const response = await request.get("/api/tasks");
  expect(response.status()).toBe(200);
  const { tasks } = await response.json();
  for (const task of tasks) {
    expect((await request.delete(`/api/tasks/${task.id}`)).status()).toBe(204);
  }
});

test("full journey: create, edit, complete, persist and delete a task", async ({ page }) => {
  await openEmptyApp(page);
  await expect(page.getByRole("heading", { level: 1, name: "To-Do" })).toBeVisible();

  const addForm = page.getByRole("form", { name: "Add task" });
  await addTask(page, "Plan trip", "Pick dates");
  await expect(taskRow(page, "Plan trip")).toContainText("Pick dates");
  await expect(addForm.getByLabel("Title", { exact: true })).toHaveValue("");
  await expect(addForm.getByLabel("Description (optional)", { exact: true })).toHaveValue("");
  await expect(addForm.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(page.getByText("0 of 1 done", { exact: true })).toBeVisible();

  await taskRow(page, "Plan trip").getByRole("button", { name: /^Edit / }).click();
  const editForm = page.getByRole("form", { name: "Edit task" });
  const editTitle = editForm.getByLabel("Title", { exact: true });
  const editDescription = editForm.getByLabel("Description (optional)", { exact: true });
  await expect(editTitle).toBeFocused();
  await expect(editTitle).toHaveValue("Plan trip");
  await expect(editDescription).toHaveValue("Pick dates");
  await editTitle.fill("Book flights");
  await editDescription.fill("Compare prices");
  await editForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Task updated.");
  await expect(editForm).toHaveCount(0);
  await expect(taskRow(page, "Plan trip")).toHaveCount(0);

  const row = taskRow(page, "Book flights");
  const checkbox = row.getByRole("checkbox");
  await expect(row).toContainText("Compare prices");
  await expect(checkbox).toHaveAccessibleName("Book flights");
  await expect(row.getByRole("button", { name: /^Edit / })).toHaveAccessibleName("Edit Book flights");
  await expect(row.getByRole("button", { name: /^Delete / })).toHaveAccessibleName("Delete Book flights");
  await expect(row).toHaveAttribute("data-completed", "false");

  await checkbox.click();
  await expect(page.getByRole("status")).toHaveText("Task marked complete.");
  await expect(checkbox).toBeChecked();
  await expect(row).toHaveAttribute("data-completed", "true");
  await expect(page.getByText("1 of 1 done", { exact: true })).toBeVisible();

  await page.reload();
  await expect(row).toContainText("Compare prices");
  await expect(checkbox).toBeChecked();
  await expect(row).toHaveAttribute("data-completed", "true");
  await expect(page.getByText("1 of 1 done", { exact: true })).toBeVisible();

  await checkbox.click();
  await expect(page.getByRole("status")).toHaveText("Task marked incomplete.");
  await expect(checkbox).not.toBeChecked();
  await expect(row).toHaveAttribute("data-completed", "false");
  await expect(page.getByText("0 of 1 done", { exact: true })).toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Delete task?", exact: true });
  await row.getByRole("button", { name: /^Delete / }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('"Book flights" will be permanently deleted.');
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: /^Delete / }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Task deleted.");
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(EMPTY_TEXT, { exact: true })).toBeVisible();
});

test("blank titles are rejected when adding and when editing", async ({ page }) => {
  const writes = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await openEmptyApp(page);

  const addForm = page.getByRole("form", { name: "Add task" });
  await addForm.getByLabel("Title", { exact: true }).fill("   ");
  await addForm.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("alert")).toHaveText("Title is required.");
  await expect(addForm.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(page.getByText(EMPTY_TEXT, { exact: true })).toBeVisible();
  expect(writes, "a blank title must not be sent to the server").toEqual([]);

  await addTask(page, "Water plants");
  await expect(alertsWithText(page)).toHaveCount(0);
  await taskRow(page, "Water plants").getByRole("button", { name: /^Edit / }).click();
  const editForm = page.getByRole("form", { name: "Edit task" });
  await editForm.getByLabel("Title", { exact: true }).fill("");
  await editForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Title is required.");
  await expect(editForm).toBeVisible();
  expect(writes, "a blank edit must not be sent to the server").toEqual(["POST /api/tasks"]);

  await page.reload();
  await expect(taskRow(page, "Water plants")).toBeVisible();
});

test("the API rejects invalid input with exact error messages", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "API behaviour does not depend on the browser");

  await expectError(await request.post("/api/tasks", { data: { title: "   " } }), 400, "Title is required.");
  await expectError(
    await request.post("/api/tasks", { data: { title: "a".repeat(201) } }),
    400,
    "Title must be 200 characters or fewer.",
  );
  await expectError(
    await request.post("/api/tasks", {
      headers: { "Content-Type": "text/plain" },
      data: JSON.stringify({ title: "Plain text body" }),
    }),
    415,
    "Content-Type must be application/json.",
  );

  const created = await request.post("/api/tasks", { data: { title: "Short-lived" } });
  expect(created.status()).toBe(201);
  const { task } = await created.json();
  await expectError(
    await request.patch(`/api/tasks/${task.id}`, { data: { completed: "yes" } }),
    400,
    "Completed must be true or false.",
  );

  expect((await request.delete(`/api/tasks/${task.id}`)).status()).toBe(204);
  await expectError(
    await request.patch(`/api/tasks/${task.id}`, { data: { completed: true } }),
    404,
    "Task not found.",
  );
});

test("shows a loading state until the task list arrives", async ({ page }) => {
  let releaseList;
  const listReleased = new Promise((resolve) => {
    releaseList = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await listReleased;
    await route.fallback();
  });

  await page.goto("/");
  const loading = page.getByText("Loading tasks...", { exact: true });
  await expect(loading).toBeVisible();

  releaseList();
  await expect(page.getByText(EMPTY_TEXT, { exact: true })).toBeVisible();
  await expect(loading).toBeHidden();
});

test("a failed list load shows an error and recovers with Try again", async ({ page }) => {
  const loadError = "Couldn't load tasks. Check your connection and try again.";
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "GET" ? route.fulfill(SERVER_ERROR) : route.fallback(),
  );

  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: loadError })).toHaveText(loadError);
  const tryAgain = page.getByRole("button", { name: "Try again", exact: true });
  await expect(tryAgain).toBeVisible();

  await page.unroute("**/api/tasks");
  await tryAgain.click();
  await expect(page.getByText(EMPTY_TEXT, { exact: true })).toBeVisible();
  await expect(alertsWithText(page)).toHaveCount(0);
  await expect(tryAgain).toHaveCount(0);
});

test("a failed add keeps the typed text so the user can retry", async ({ page }) => {
  await openEmptyApp(page);
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "POST" ? route.fulfill(SERVER_ERROR) : route.fallback(),
  );

  const addForm = page.getByRole("form", { name: "Add task" });
  const title = addForm.getByLabel("Title", { exact: true });
  const description = addForm.getByLabel("Description (optional)", { exact: true });
  await title.fill("Renew passport");
  await description.fill("Bring two photos");
  await addForm.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("alert")).toHaveText("Couldn't add the task. Please try again.");
  await expect(title).toHaveValue("Renew passport");
  await expect(description).toHaveValue("Bring two photos");
  await expect(page.getByText(EMPTY_TEXT, { exact: true })).toBeVisible();

  await page.unroute("**/api/tasks");
  await addForm.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("status")).toHaveText("Task added.");
  await expect(alertsWithText(page)).toHaveCount(0);
  await expect(taskRow(page, "Renew passport")).toContainText("Bring two photos");
});

test("a failed toggle reverts the checkbox", async ({ page }) => {
  await openEmptyApp(page);
  await addTask(page, "Pay rent");
  await page.route("**/api/tasks/*", (route) =>
    route.request().method() === "PATCH" ? route.fulfill(SERVER_ERROR) : route.fallback(),
  );

  const row = taskRow(page, "Pay rent");
  await row.getByRole("checkbox").click();
  await expect(page.getByRole("alert")).toHaveText("Couldn't update the task. Please try again.");
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await expect(row).toHaveAttribute("data-completed", "false");
  await expect(page.getByText("0 of 1 done", { exact: true })).toBeVisible();
});

test("a failed delete keeps the task", async ({ page }) => {
  await openEmptyApp(page);
  await addTask(page, "Call dentist");
  await page.route("**/api/tasks/*", (route) =>
    route.request().method() === "DELETE" ? route.fulfill(SERVER_ERROR) : route.fallback(),
  );

  const row = taskRow(page, "Call dentist");
  const dialog = page.getByRole("dialog", { name: "Delete task?", exact: true });
  await row.getByRole("button", { name: /^Delete / }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Couldn't delete the task. Please try again.");
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();
});

test("task text is rendered as text, never as HTML", async ({ page }) => {
  const title = '<img src=x onerror="window.__xss=1">';
  await openEmptyApp(page);
  await addTask(page, title);

  const list = page.getByRole("list", { name: "Tasks" });
  await expect(list.getByText(title, { exact: true })).toBeVisible();
  await expect(list.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  await page.reload();
  await expect(list.getByText(title, { exact: true })).toBeVisible();
  await expect(list.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test("tasks survive a server restart", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "spawns its own server on a fixed port");

  const dbDir = await mkdtemp(path.join(os.tmpdir(), "demo-todo-restart-"));
  const dbPath = path.join(dbDir, "todos.db");
  let server;
  try {
    server = startServer(dbPath);
    await server.ready;
    await openEmptyApp(page, RESTART_ORIGIN);
    await addTask(page, "Survive a restart", "Stored in SQLite");

    expect(await stopServer(server.child), "server exits 0 on SIGTERM").toBe(0);
    server = startServer(dbPath);
    await server.ready;

    await page.reload();
    await expect(taskRow(page, "Survive a restart")).toContainText("Stored in SQLite");
  } finally {
    if (server) await stopServer(server.child, "SIGKILL");
    await rm(dbDir, { recursive: true, force: true });
  }
});
