#!/usr/bin/env node
import { parseArgs } from "node:util";
import { SetupError } from "./app.ts";
import { lineOf, renderReport } from "./report.ts";
import { plannerModel, verify, type PlanChoice } from "./verify.ts";

const USAGE = "usage: umbreon verify <caseDir> [--scenario <file>]";

function exit(code: number, text: string, stream: NodeJS.WriteStream): void {
  // A bare process.exit can cut off output still queued for a pipe.
  stream.write(`${text}\n`, () => process.exit(code));
}

function parse(): { caseDir: string; scenario: string | undefined } | null {
  try {
    const { values, positionals } = parseArgs({ options: { scenario: { type: "string" } }, allowPositionals: true });
    const [command, caseDir, ...extra] = positionals;
    return command === "verify" && caseDir && extra.length === 0 ? { caseDir, scenario: values.scenario } : null;
  } catch {
    return null;
  }
}

const args = parse();
if (!args) {
  exit(2, USAGE, process.stderr);
} else {
  // After a hangup the terminal is gone, so a write can fail with EIO or EPIPE. Unhandled, that error would end the
  // run before cleanup and the record. exit() still gets the error in its write callback, so it still exits.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (controller.signal.aborted) process.exit(130);
      controller.abort();
      process.stderr.write(`Stopping after cleanup (${signal}). ${signal === "SIGINT" ? "Press Ctrl-C again" : "Send it again"} to quit at once.\n`);
    });
  }
  try {
    const plan: PlanChoice = args.scenario ? { kind: "file", path: args.scenario } : { kind: "model", model: await plannerModel() };
    const onEvent: Parameters<typeof verify>[1]["onEvent"] = (event) => {
      const line = lineOf(event);
      if (line !== null) process.stderr.write(`${line}\n`);
    };
    const record = await verify(args.caseDir, { plan, signal: controller.signal, onEvent });
    const { verdict } = record;
    const interrupted = verdict.kind === "NOT PROVEN" && verdict.blockers.some((b) => b.reason === "halted" && b.halt.reason === "interrupted");
    const code = verdict.kind === "PROVEN" ? 0 : interrupted ? 130 : 1;
    exit(code, renderReport(record, process.cwd()), process.stdout);
  } catch (error) {
    exit(2, error instanceof SetupError ? `umbreon: ${error.message}` : String((error as Error).stack ?? error), process.stderr);
  }
}
