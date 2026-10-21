#!/usr/bin/env node
import { parseArgs } from "node:util";
import { SetupError } from "./app.ts";
import { serveDashboard } from "./dashboard.ts";
import { lineOf, renderReport } from "./report.ts";
import { RUNS_DIR, plannerModel, verify, type PlanChoice } from "./verify.ts";

const USAGE = "usage: umbreon verify <caseDir> [--scenario <file>]\n       umbreon dashboard [--port <n>]";
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Command =
  | { kind: "verify"; caseDir: string; scenario: string | undefined }
  | { kind: "dashboard"; port: number | undefined };

function exit(code: number, text: string, stream: NodeJS.WriteStream): void {
  // A bare process.exit can cut off output still queued for a pipe.
  stream.write(`${text}\n`, () => process.exit(code));
}

function parse(): Command | null {
  try {
    const { values, positionals } = parseArgs({ options: { scenario: { type: "string" }, port: { type: "string" } }, allowPositionals: true });
    const [command, ...rest] = positionals;
    if (command === "verify" && rest.length === 1 && values.port === undefined) return { kind: "verify", caseDir: rest[0], scenario: values.scenario };
    if (command === "dashboard" && rest.length === 0 && values.scenario === undefined) {
      const port = values.port === undefined ? undefined : Number(values.port);
      return port === undefined || (Number.isInteger(port) && port > 0 && port < 65_536) ? { kind: "dashboard", port } : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function runVerify(command: Extract<Command, { kind: "verify" }>): Promise<void> {
  const controller = new AbortController();
  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => {
      if (controller.signal.aborted) process.exit(130);
      controller.abort();
      process.stderr.write(`Stopping after cleanup (${signal}). ${signal === "SIGINT" ? "Press Ctrl-C again" : "Send it again"} to quit at once.\n`);
    });
  }
  const plan: PlanChoice = command.scenario ? { kind: "file", path: command.scenario } : { kind: "model", model: await plannerModel() };
  const onEvent: Parameters<typeof verify>[1]["onEvent"] = (event) => {
    const line = lineOf(event);
    if (line !== null) process.stderr.write(`${line}\n`);
  };
  const record = await verify(command.caseDir, { plan, signal: controller.signal, onEvent });
  const { verdict } = record;
  const interrupted = verdict.kind === "NOT PROVEN" && verdict.blockers.some((b) => b.reason === "halted" && b.halt.reason === "interrupted");
  const code = verdict.kind === "PROVEN" ? 0 : interrupted ? 130 : 1;
  exit(code, renderReport(record, process.cwd()), process.stdout);
}

/** The port's default lives in serveDashboard. */
async function runDashboard(command: Extract<Command, { kind: "dashboard" }>): Promise<void> {
  const dashboard = await serveDashboard({ runsDir: RUNS_DIR, port: command.port });
  process.stdout.write(`${dashboard.url}\n`);
  for (const signal of STOP_SIGNALS) process.once(signal, () => dashboard.close().then(() => process.exit(0)));
}

const command = parse();
if (!command) {
  exit(2, USAGE, process.stderr);
} else {
  // After a hangup the terminal is gone, so a write can fail with EIO or EPIPE. Unhandled, that error would end the
  // run before cleanup and the record. exit() still gets the error in its write callback, so it still exits.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  try {
    if (command.kind === "verify") await runVerify(command);
    else await runDashboard(command);
  } catch (error) {
    exit(2, error instanceof SetupError ? `umbreon: ${error.message}` : String((error as Error).stack ?? error), process.stderr);
  }
}
