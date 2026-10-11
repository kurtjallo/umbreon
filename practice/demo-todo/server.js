import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || join(APP_DIR, "data", "todos.db");
const MAX_BODY_BYTES = 16 * 1024;

const SECURITY_HEADERS = new Map([
  ["Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
]);

const STATIC_FILES = new Map([
  ["/", { file: join(APP_DIR, "public", "index.html"), type: "text/html; charset=utf-8" }],
  ["/app.js", { file: join(APP_DIR, "public", "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: join(APP_DIR, "public", "styles.css"), type: "text/css; charset=utf-8" }],
]);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const listTasks = db.prepare("SELECT * FROM tasks ORDER BY id DESC");
const insertTask = db.prepare(
  "INSERT INTO tasks (title, description, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *",
);
const updateTask = db.prepare(`
  UPDATE tasks
  SET title = COALESCE(?, title),
      description = COALESCE(?, description),
      completed = COALESCE(?, completed),
      updated_at = ?
  WHERE id = ?
  RETURNING *
`);
const deleteTask = db.prepare("DELETE FROM tasks WHERE id = ?");

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    completed: row.completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function httpError(status, message, headers = {}) {
  return Object.assign(new Error(message), { status, headers });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw httpError(415, "Content-Type must be application/json.");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    throw httpError(413, "Request body is too large.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Request body is too large.", { Connection: "close" });
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }
  return body;
}

function parseTitle(value) {
  if (typeof value !== "string") throw httpError(400, "Title must be text.");
  const title = value.trim();
  if (title.length === 0) throw httpError(400, "Title is required.");
  if (title.length > 200) throw httpError(400, "Title must be 200 characters or fewer.");
  return title;
}

function parseDescription(value) {
  if (typeof value !== "string") throw httpError(400, "Description must be text.");
  const description = value.trim();
  if (description.length > 2000) throw httpError(400, "Description must be 2000 characters or fewer.");
  return description;
}

async function handle(req, res) {
  const path = req.url.split("?", 1)[0];

  const asset = STATIC_FILES.get(path);
  if (asset) {
    if (req.method !== "GET") throw httpError(405, "Method not allowed.", { Allow: "GET" });
    const content = await readFile(asset.file).catch((error) => {
      throw error.code === "ENOENT" ? httpError(404, "Not found.") : error;
    });
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
    res.end(content);
    return;
  }

  if (path === "/api/tasks") {
    if (req.method === "GET") {
      sendJson(res, 200, { tasks: listTasks.all().map(toTask) });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.title === undefined) throw httpError(400, "Title is required.");
      const title = parseTitle(body.title);
      const description = body.description === undefined ? "" : parseDescription(body.description);
      const now = new Date().toISOString();
      sendJson(res, 201, { task: toTask(insertTask.get(title, description, now, now)) });
      return;
    }
    throw httpError(405, "Method not allowed.", { Allow: "GET, POST" });
  }

  const idText = /^\/api\/tasks\/([1-9][0-9]*)$/.exec(path)?.[1];
  if (idText) {
    const id = Number(idText);
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (body.title === undefined && body.description === undefined && body.completed === undefined) {
        throw httpError(400, "Nothing to update.");
      }
      const title = body.title === undefined ? null : parseTitle(body.title);
      const description = body.description === undefined ? null : parseDescription(body.description);
      if (body.completed !== undefined && typeof body.completed !== "boolean") {
        throw httpError(400, "Completed must be true or false.");
      }
      const completed = body.completed === undefined ? null : Number(body.completed);
      const row = updateTask.get(title, description, completed, new Date().toISOString(), id);
      if (!row) throw httpError(404, "Task not found.");
      sendJson(res, 200, { task: toTask(row) });
      return;
    }
    if (req.method === "DELETE") {
      if (deleteTask.run(id).changes === 0) throw httpError(404, "Task not found.");
      res.writeHead(204).end();
      return;
    }
    throw httpError(405, "Method not allowed.", { Allow: "PATCH, DELETE" });
  }

  throw httpError(404, "Not found.");
}

const server = createServer(async (req, res) => {
  res.setHeaders(SECURITY_HEADERS);
  try {
    await handle(req, res);
  } catch (error) {
    if (!error.status && error.code !== "ECONNRESET") console.error(error);
    if (res.destroyed) return;
    if (error.status) {
      sendJson(res, error.status, { error: error.message }, error.headers);
    } else {
      sendJson(res, 500, { error: "Something went wrong." });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${server.address().port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
