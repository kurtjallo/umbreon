import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openEventLog, parseEvents, stepEvent, summarizePlan } from "./events.ts";
import { ScenarioSchema } from "./scenario.ts";

const good = () => ScenarioSchema.parse(JSON.parse(readFileSync(new URL("../scripts/fixtures/demo-todo-good.json", import.meta.url), "utf8")));

test("openEventLog appends one numbered, timed line per event and hands each to the listener", () => {
  const dir = mkdtempSync(join(tmpdir(), "umbreon-events-"));
  const seen: number[] = [];
  const times = [new Date("2026-10-17T10:00:00Z"), new Date("2026-10-17T10:00:02Z")];
  const log = openEventLog(dir, (event) => seen.push(event.seq), () => times.shift()!);
  log.emit({ type: "run_started", runId: "r1", caseName: "delete-bug", pid: 42, capMs: 480_000 });
  log.emit({ type: "stage_started", stage: "repo" });
  const events = parseEvents(readFileSync(log.path, "utf8"));
  assert.deepEqual(events.map((e) => [e.seq, e.at, e.type]), [
    [1, "2026-10-17T10:00:00.000Z", "run_started"],
    [2, "2026-10-17T10:00:02.000Z", "stage_started"],
  ]);
  assert.deepEqual(seen, [1, 2]);
});

test("parseEvents skips a last line the writer has not finished", () => {
  const text = '{"seq":1,"at":"x","type":"stage_started","stage":"repo"}\n{"seq":2,"at":"x","ty';
  assert.deepEqual(parseEvents(text).map((e) => e.seq), [1]);
  assert.deepEqual(parseEvents(""), []);
});

test("summarizePlan numbers claims and checks like the report and labels each step's phase", () => {
  const scenario = good();
  const summary = summarizePlan(scenario, { notTestable: [{ quote: "Background.", reason: "history, not a promise" }], uncovered: ["Not this one."] });
  assert.equal(summary.claims.length, scenario.claims.length);
  assert.equal(summary.claims[0].id, "c1");
  assert.equal(summary.claims[0].checks[0].id, "c1.1");
  const check = scenario.claims[0].checks[0];
  const steps = summary.claims[0].checks[0].steps;
  assert.equal(steps.length, check.given.length + check.when.length + check.then.length);
  assert.equal(steps[0].phase, check.given.length ? "given" : "when");
  assert.equal(steps.at(-1)!.phase, "then");
  assert.deepEqual(summary.notTestable, [{ quote: "Background.", reason: "history, not a promise" }]);
  assert.deepEqual(summary.uncovered, ["Not this one."]);
});

test("stepEvent keeps evidence paths relative to the run folder and spells out why a step stopped", () => {
  const run = "/runs/r1";
  assert.deepEqual(
    stepEvent("drive", "c1.1", { status: "failed", index: 11, atMs: 8683, screenshot: { state: "captured", file: "/runs/r1/c1.1/12.png" }, expected: 'focus on button "Delete Alpha"', observed: 'focus on button "Delete Beta"', aria: { state: "not_requested" } }, run),
    { type: "step", phase: "drive", checkId: "c1.1", index: 11, status: "failed", atMs: 8683, detail: 'expected focus on button "Delete Alpha", saw focus on button "Delete Beta"', screenshot: "c1.1/12.png" },
  );
  assert.equal(
    (stepEvent("baseline", "c2.1", { status: "could_not_run", index: 3, atMs: 900, screenshot: { state: "missing", reason: "closed" }, cause: "no_match", detail: "no visible match", aria: { state: "not_requested" } }, run) as { detail: string }).detail,
    "no match: no visible match",
  );
  assert.deepEqual(stepEvent("drive", "c2.1", { status: "skipped", index: 4 }, run), { type: "step", phase: "drive", checkId: "c2.1", index: 4, status: "skipped", atMs: null, detail: null, screenshot: null });
});
