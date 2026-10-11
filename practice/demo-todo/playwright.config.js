import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node server.js",
    url: "http://127.0.0.1:4173/api/tasks",
    reuseExistingServer: false,
    env: {
      PORT: "4173",
      HOST: "127.0.0.1",
      DB_PATH: path.join(os.tmpdir(), "demo-todo-e2e.db"),
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
