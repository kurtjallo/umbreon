import { appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describeStep, phaseOf, type Phase } from "./report.ts";
import { checksOf, stepsOf, type Scenario } from "./scenario.ts";
import type { Evidence, Outcome, StepResult, Verdict } from "./verdict.ts";

/** baseline runs the frozen checks on the app before the change, after every check passed on the changed app. */
export type EventStage = "repo" | "look" | "plan" | "rehearse" | "repair" | "drive" | "baseline";
export type RunPhase = "drive" | "baseline";

export type PlanSummary = {
  claims: { id: string; quote: string; it: string; checks: { id: string; it: string; steps: { phase: Phase; text: string }[] }[] }[];
  notTestable: { quote: string; reason: string }[];
  uncovered: string[];
};

/** Paths in events are relative to the run folder, so a viewer can serve them without knowing where runs live. */
export type RunEventBody =
  | { type: "run_started"; runId: string; caseName: string; pid: number; capMs: number }
  | { type: "stage_started"; stage: EventStage }
  | { type: "repo_ready"; base: string; commit: string }
  | { type: "model_call"; purpose: "plan" | "repair"; ok: boolean; ms: number; inputTokens: number; outputTokens: number; costUsd: number | null; problems: string[] }
  | { type: "plan"; frozen: boolean; sha256: string | null; plan: PlanSummary }
  | { type: "check_started"; phase: "rehearse" | RunPhase; checkId: string }
  | { type: "step"; phase: RunPhase; checkId: string; index: number; status: StepResult["status"]; atMs: number | null; detail: string | null; screenshot: string | null }
  | { type: "check_finished"; phase: "rehearse"; checkId: string; ready: boolean; problem: string | null }
  | { type: "check_finished"; phase: RunPhase; checkId: string; result: "passed" | "failed" | "could_not_run"; problem: string | null; video: string | null }
  | { type: "verdict"; kind: Verdict["kind"]; commit: string | null; checks: { checkId: string; result: Outcome["result"] }[]; halt: string | null };

export type RunEvent = RunEventBody & { seq: number; at: string };

export type EventLog = { readonly path: string; emit(event: RunEventBody): void };

export const EVENTS_FILE = "events.jsonl";

/** One writer per run. Each event is one appended line, so a reader never sees a reordered or half-merged log. */
export function openEventLog(runDir: string, onEvent: (event: RunEvent) => void = () => {}, now: () => Date = () => new Date()): EventLog {
  const path = join(runDir, EVENTS_FILE);
  let seq = 0;
  return {
    path,
    emit(body) {
      const event = { ...body, seq: ++seq, at: now().toISOString() } as RunEvent;
      appendFileSync(path, `${JSON.stringify(event)}\n`);
      onEvent(event);
    },
  };
}

/** Reads only complete lines: the writer may be halfway through the last one. */
export function parseEvents(text: string): RunEvent[] {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
}

export function relativeEvidence(evidence: Evidence, runDir: string): string | null {
  return evidence.state === "captured" ? relative(runDir, evidence.file) : null;
}

export function summarizePlan(scenario: Scenario, notes: { notTestable?: readonly { quote: string; reason: string }[]; uncovered: readonly string[] }): PlanSummary {
  const checks = checksOf(scenario);
  return {
    claims: scenario.claims.map((claim, i) => ({
      id: `c${i + 1}`,
      quote: claim.quote,
      it: claim.it,
      checks: checks.filter((check) => check.claimIndex === i).map((check) => ({
        id: check.id,
        it: check.it,
        steps: stepsOf(check).map((step, index) => ({ phase: phaseOf(check, index), text: describeStep(step) })),
      })),
    })),
    notTestable: (notes.notTestable ?? []).map((note) => ({ ...note })),
    uncovered: [...notes.uncovered],
  };
}

export function stepEvent(phase: RunPhase, checkId: string, result: StepResult, runDir: string): RunEventBody {
  const base = { type: "step" as const, phase, checkId, index: result.index, status: result.status };
  switch (result.status) {
    case "skipped":
      return { ...base, atMs: null, detail: null, screenshot: null };
    case "passed":
      return { ...base, atMs: result.atMs, detail: null, screenshot: relativeEvidence(result.screenshot, runDir) };
    case "failed":
      return { ...base, atMs: result.atMs, detail: `expected ${result.expected}, saw ${result.observed}`, screenshot: relativeEvidence(result.screenshot, runDir) };
    case "could_not_run":
      return { ...base, atMs: result.atMs, detail: `${result.cause.replace(/_/g, " ")}: ${result.detail}`, screenshot: relativeEvidence(result.screenshot, runDir) };
  }
}
