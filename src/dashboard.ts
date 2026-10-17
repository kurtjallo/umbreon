import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, posix, resolve, sep } from "node:path";
import { EVENTS_FILE, parseEvents, type EventStage, type PlanSummary, type RunEvent, type RunPhase } from "./events.ts";
import type { Phase } from "./report.ts";
import type { Outcome, StepResult, Verdict } from "./verdict.ts";

export type RunStatus = "running" | "stuck" | "stopped" | Verdict["kind"];

/** `stuck` and `halted` mark the stage the run is in when it went quiet or ended without finishing it. */
export type StageState = "todo" | "now" | "stuck" | "done" | "halted";
export type StageView = { stage: EventStage; state: StageState; ms: number; calls: number };

export type Purpose = "plan" | "repair";
export type CallView = { n: number; purpose: Purpose; ok: boolean; ms: number; inputTokens: number; outputTokens: number; costUsd: number | null; problems: string[] };
/** The model call the run is waiting on right now: its stage only ever waits on a model. */
export type PendingCall = { n: number; purpose: Purpose; ms: number };

/** `interrupted`: the check was rehearsing or running when the run ended, and the verdict did not judge it. */
export type CheckState = "waiting" | "rehearsing" | "ready" | "not_ready" | "running" | "interrupted" | Outcome["result"];
export type StepStatus = StepResult["status"] | "todo" | "now";
export type StepView = { phase: Phase; text: string; status: StepStatus; detail: string | null; screenshot: string | null; atMs: number | null };
/** Paths relative to the run folder. Set once the check has been driven. */
export type EvidenceLinks = { video: string | null; videoAtMs: number | null; trace: string | null; appLog: string | null; pageSnapshot: string | null };
export type RunResult = Extract<RunEvent, { type: "check_finished"; phase: RunPhase }>["result"];
/**
 * The rerun of a check on the app before the change. `step` is the step it stopped at (failed, could not run)
 * or is on (running), numbered from 1.
 */
export type BaselineView = {
  state: "running" | "interrupted" | RunResult;
  step: { n: number; text: string; detail: string | null; screenshot: string | null } | null;
  video: string | null;
};
/** Step numbers in `latestScreenshot` and `baseline.step` count from 1, as the page shows them. */
export type CheckView = {
  id: string;
  it: string;
  state: CheckState;
  problem: string | null;
  steps: StepView[];
  latestScreenshot: { path: string; step: number } | null;
  evidence: EvidenceLinks | null;
  baseline: BaselineView | null;
};
export type ClaimView = { id: string; quote: string; it: string; checks: CheckView[] };
export type PlanView = { sha256: string | null; frozen: boolean; claims: ClaimView[]; notTestable: PlanSummary["notTestable"]; uncovered: string[] };
export type VerdictView = { kind: Verdict["kind"]; commit: string | null; halt: string | null; total: number; counts: Record<Outcome["result"], number> };

export type RunView = {
  runId: string;
  caseName: string;
  status: RunStatus;
  base: string | null;
  commit: string | null;
  startedAt: string;
  lastEventAt: string;
  elapsedMs: number;
  quietMs: number;
  quietLimitMs: number;
  capMs: number;
  stage: EventStage;
  stages: StageView[];
  calls: CallView[];
  pendingCall: PendingCall | null;
  totals: { inputTokens: number; outputTokens: number; costUsd: number | null };
  plan: PlanView | null;
  verdict: VerdictView | null;
};

export type RunSummary = Pick<RunView, "runId" | "caseName" | "status" | "startedAt" | "elapsedMs">;
export type DashboardPayload = { runs: RunSummary[]; view: RunView | null };

/**
 * One row per stage, in strip order. Optional stages show only when the run went through them.
 * A stage looks stuck after its quiet limit: every model call (capped at 180 s) and every browser step ends with an event.
 */
const STAGES: Record<EventStage, { quietLimitMs: number; optional: boolean }> = {
  repo: { quietLimitMs: 60_000, optional: false },
  look: { quietLimitMs: 60_000, optional: false },
  plan: { quietLimitMs: 210_000, optional: false },
  rehearse: { quietLimitMs: 60_000, optional: false },
  repair: { quietLimitMs: 210_000, optional: true },
  drive: { quietLimitMs: 60_000, optional: false },
  baseline: { quietLimitMs: 60_000, optional: true },
};
const STAGE_ORDER = Object.keys(STAGES) as EventStage[];

type StatusFacts = { verdict: Verdict["kind"] | null; alive: boolean; quietMs: number; quietLimitMs: number };
/** The first rule that answers decides the status; when none does, the run is running. */
const STATUS_RULES: readonly ((facts: StatusFacts) => RunStatus | null)[] = [
  (f) => f.verdict,
  (f) => (f.alive ? null : "stopped"),
  (f) => (f.quietMs > f.quietLimitMs ? "stuck" : null),
];
const CURRENT_STAGE: Record<RunStatus, StageState> = { running: "now", stuck: "stuck", stopped: "halted", PROVEN: "done", "NOT PROVEN": "done" };

type StepEvent = Extract<RunEvent, { type: "step" }>;
type PlanCheck = PlanSummary["claims"][number]["checks"][number];
type Rehearsal = { state: "rehearsing" | "ready" | "not_ready"; problem: string | null };
type PhaseRun = { state: "running" | RunResult; problem: string | null; video: string | null; steps: Map<number, StepEvent> };
/** Everything the events said about one check. Each phase keeps its own steps, so a baseline rerun never overwrites the drive. */
type CheckLog = { rehearsal: Rehearsal | null; runs: Partial<Record<RunPhase, PhaseRun>> };

const ms = (iso: string) => Date.parse(iso);
const checksIn = (plan: PlanSummary) => plan.claims.flatMap((claim) => claim.checks);

/** A repair replaces some checks under the same ids, so a check whose definition changed starts over. */
function forgetChanged(logs: Map<string, CheckLog>, before: PlanSummary | null, after: PlanSummary): void {
  const old = new Map(before ? checksIn(before).map((check) => [check.id, JSON.stringify(check)]) : []);
  for (const check of checksIn(after)) if (old.get(check.id) !== JSON.stringify(check)) logs.delete(check.id);
}

function stepViews(check: PlanCheck, run: PhaseRun | undefined, live: boolean): StepView[] {
  const next = live ? check.steps.findIndex((_, i) => !run?.steps.has(i)) : -1;
  return check.steps.map((step, i) => {
    const result = run?.steps.get(i);
    return {
      phase: step.phase,
      text: step.text,
      status: result?.status ?? (i === next ? "now" : "todo"),
      detail: result?.detail ?? null,
      screenshot: result?.screenshot ?? null,
      atMs: result?.atMs ?? null,
    };
  });
}

const stoppedAt = (steps: readonly StepView[]) => steps.findIndex((step) => step.status === "failed" || step.status === "could_not_run");

function evidenceOf(run: PhaseRun, steps: readonly StepView[], latest: string | null): EvidenceLinks | null {
  const anyFile = run.video ?? latest;
  if (anyFile === null) return null;
  const folder = posix.dirname(anyFile);
  const stop = steps[stoppedAt(steps)];
  return {
    video: run.video,
    videoAtMs: run.video !== null && stop ? stop.atMs : null,
    trace: posix.join(folder, "trace.zip"),
    appLog: posix.join(folder, "app.log"),
    pageSnapshot: stop?.screenshot?.replace(/\.png$/, ".aria.yml") ?? null,
  };
}

function baselineView(check: PlanCheck, run: PhaseRun | undefined, over: boolean): BaselineView | null {
  if (!run) return null;
  const state = run.state === "running" && over ? "interrupted" : run.state;
  const steps = stepViews(check, run, state === "running");
  const at = state === "running" ? steps.findIndex((step) => step.status === "now") : stoppedAt(steps);
  const step = steps[at];
  return { state, step: step ? { n: at + 1, text: step.text, detail: step.detail, screenshot: step.screenshot } : null, video: run.video };
}

function checkView(check: PlanCheck, log: CheckLog | undefined, judged: Outcome["result"] | undefined, over: boolean): CheckView {
  const drive = log?.runs.drive;
  const own: CheckState = drive?.state ?? log?.rehearsal?.state ?? "waiting";
  const state = judged ?? (over && (own === "running" || own === "rehearsing") ? "interrupted" : own);
  const steps = stepViews(check, drive, state === "running");
  const shots = steps.flatMap((step, i) => (step.screenshot === null ? [] : [{ path: step.screenshot, step: i + 1 }]));
  const latestScreenshot = shots.at(-1) ?? null;
  return {
    id: check.id,
    it: check.it,
    state,
    problem: drive && drive.state !== "running" ? drive.problem : log?.rehearsal?.problem ?? null,
    steps,
    latestScreenshot,
    evidence: drive && drive.state !== "running" ? evidenceOf(drive, steps, latestScreenshot?.path ?? null) : null,
    baseline: baselineView(check, log?.runs.baseline, over),
  };
}

/** Folds a run's events into what the dashboard draws. `alive` says whether the run's process still exists. */
export function viewOf(events: readonly RunEvent[], now: Date, alive: boolean): RunView {
  const started = events[0];
  if (started?.type !== "run_started") throw new Error("a run's events start with run_started");
  let stage: EventStage = "repo";
  const intervals: { stage: EventStage; from: number }[] = [{ stage, from: ms(started.at) }];
  const callsIn = new Map<EventStage, number>();
  const calls: CallView[] = [];
  const logs = new Map<string, CheckLog>();
  const logOf = (checkId: string): CheckLog => {
    const log = logs.get(checkId) ?? { rehearsal: null, runs: {} };
    logs.set(checkId, log);
    return log;
  };
  let repo: { base: string; commit: string } | null = null;
  let plan: Extract<RunEvent, { type: "plan" }> | null = null;
  let plannedInStage = false;
  let verdict: Extract<RunEvent, { type: "verdict" }> | null = null;

  for (const event of events) {
    switch (event.type) {
      case "run_started":
        break;
      case "stage_started":
        if (event.stage !== stage) intervals.push({ stage: event.stage, from: ms(event.at) });
        stage = event.stage;
        plannedInStage = false;
        break;
      case "repo_ready":
        repo = { base: event.base, commit: event.commit };
        break;
      case "model_call":
        calls.push({ n: calls.length + 1, purpose: event.purpose, ok: event.ok, ms: event.ms, inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd: event.costUsd, problems: event.problems });
        callsIn.set(stage, (callsIn.get(stage) ?? 0) + 1);
        break;
      case "plan":
        forgetChanged(logs, plan?.plan ?? null, event.plan);
        plan = event;
        plannedInStage = true;
        break;
      case "check_started":
        if (event.phase === "rehearse") logOf(event.checkId).rehearsal = { state: "rehearsing", problem: null };
        else logOf(event.checkId).runs[event.phase] = { state: "running", problem: null, video: null, steps: new Map() };
        break;
      case "step":
        logs.get(event.checkId)?.runs[event.phase]?.steps.set(event.index, event);
        break;
      case "check_finished":
        if (event.phase === "rehearse") {
          logOf(event.checkId).rehearsal = { state: event.ready ? "ready" : "not_ready", problem: event.problem };
        } else {
          const log = logOf(event.checkId);
          log.runs[event.phase] = { state: event.result, problem: event.problem, video: event.video, steps: log.runs[event.phase]?.steps ?? new Map() };
        }
        break;
      case "verdict":
        verdict = event;
        break;
    }
  }

  const lastEventAt = events[events.length - 1].at;
  const lastEventMs = ms(lastEventAt);
  const facts: StatusFacts = { verdict: verdict?.kind ?? null, alive, quietMs: now.getTime() - lastEventMs, quietLimitMs: STAGES[stage].quietLimitMs };
  const status = STATUS_RULES.map((rule) => rule(facts)).find((answer) => answer !== null) ?? "running";
  const live = status === "running" || status === "stuck";
  const end = verdict ? ms(verdict.at) : live ? now.getTime() : lastEventMs;
  const quietMs = Math.max(0, end - lastEventMs);

  const spent = new Map<EventStage, number>();
  intervals.forEach(({ stage: s, from }, i) => spent.set(s, (spent.get(s) ?? 0) + Math.max(0, (intervals[i + 1]?.from ?? end) - from)));
  const currentState = verdict?.halt ? "halted" : CURRENT_STAGE[status];
  const stages = STAGE_ORDER.filter((s) => spent.has(s) || !STAGES[s].optional).map((s): StageView => ({
    stage: s,
    state: s === stage ? currentState : spent.has(s) ? "done" : "todo",
    ms: spent.get(s) ?? 0,
    calls: callsIn.get(s) ?? 0,
  }));

  const waitingOn = live && !plannedInStage && (stage === "plan" || stage === "repair") ? stage : null;
  const costs = calls.flatMap((call) => (call.costUsd === null ? [] : [call.costUsd]));
  const judged = new Map(verdict?.checks.map((check) => [check.checkId, check.result]));
  const counts: Record<Outcome["result"], number> = { passed: 0, failed: 0, could_not_run: 0, evidence_missing: 0 };
  for (const check of verdict?.checks ?? []) counts[check.result]++;

  return {
    runId: started.runId,
    caseName: started.caseName,
    status,
    base: repo?.base ?? null,
    commit: verdict?.commit ?? repo?.commit ?? null,
    startedAt: started.at,
    lastEventAt,
    elapsedMs: Math.max(0, end - ms(started.at)),
    quietMs,
    quietLimitMs: STAGES[stage].quietLimitMs,
    capMs: started.capMs,
    stage,
    stages,
    calls,
    pendingCall: waitingOn ? { n: calls.length + 1, purpose: waitingOn, ms: quietMs } : null,
    totals: {
      inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
      costUsd: calls.length > 0 && costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
    },
    plan: plan && {
      sha256: plan.sha256,
      frozen: plan.frozen,
      claims: plan.plan.claims.map((claim) => ({
        id: claim.id,
        quote: claim.quote,
        it: claim.it,
        checks: claim.checks.map((check) => checkView(check, logs.get(check.id), judged.get(check.id), !live)),
      })),
      notTestable: plan.plan.notTestable,
      uncovered: plan.plan.uncovered,
    },
    verdict: verdict && { kind: verdict.kind, commit: verdict.commit, halt: verdict.halt, total: verdict.checks.length, counts },
  };
}

export const summaryOf = ({ runId, caseName, status, startedAt, elapsedMs }: RunView): RunSummary => ({ runId, caseName, status, startedAt, elapsedMs });

/** ESRCH means no such process; EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const RUN_ID = /^[\w.-]+$/;
const MAX_RUNS = 50;
const TICK_MS = 1_000;
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".log": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** Maps `/runs/<runId>/<path>` to a file inside that run's folder, or null. Checks run after decoding, so `%2e%2e` is caught too. */
export function evidenceFile(runsDir: string, pathname: string): string | null {
  const match = /^\/runs\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  let runId: string;
  let path: string;
  try {
    runId = decodeURIComponent(match[1]);
    path = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!RUN_ID.test(runId) || path.split("/").includes("..") || !(extname(path).toLowerCase() in CONTENT_TYPES)) return null;
  const root = resolve(runsDir);
  const runDir = resolve(root, runId);
  const file = resolve(runDir, path);
  return runDir.startsWith(root + sep) && file.startsWith(runDir + sep) ? file : null;
}

/** Reads one `bytes=` range. The browser's video player needs ranges before it can seek, e.g. to the moment a check failed. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
  return start <= end ? { start, end } : "unsatisfiable";
}

export type DashboardOptions = { runsDir: string; port?: number; isAlive?: (pid: number) => boolean; pollMs?: number };
export type Dashboard = { url: string; close(): Promise<void> };

type Client = { res: ServerResponse; run: string | null; last: string };
type LoadedRun = { size: number; events: RunEvent[]; pid: number };

/** Serves the dashboard on 127.0.0.1 only: the page, a live stream of run views, and the runs' evidence files. */
export async function serveDashboard(options: DashboardOptions): Promise<Dashboard> {
  const { runsDir, port = 4300, isAlive = processAlive, pollMs = 250 } = options;
  let runs = new Map<string, LoadedRun>();
  const clients = new Set<Client>();
  let timers: NodeJS.Timeout[] = [];
  let hosts: ReadonlySet<string> = new Set();

  /** Re-reads each events file whose size changed. Run ids start with their start time, so name order is newest first. */
  const refresh = (): boolean => {
    let names: string[] = [];
    try {
      names = readdirSync(runsDir).filter((name) => RUN_ID.test(name)).sort().reverse();
    } catch {
      // No runs folder yet: show no runs.
    }
    const next = new Map<string, LoadedRun>();
    let changed = false;
    for (const name of names) {
      if (next.size === MAX_RUNS) break;
      const path = resolve(runsDir, name, EVENTS_FILE);
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      const cached = runs.get(name);
      if (cached?.size === size) {
        next.set(name, cached);
        continue;
      }
      changed = true;
      try {
        const events = parseEvents(readFileSync(path, "utf8"));
        if (events[0]?.type === "run_started") next.set(name, { size, events, pid: events[0].pid });
      } catch {
        // A file that is not an event log is not a run.
      }
    }
    changed ||= [...runs.keys()].some((name) => !next.has(name));
    runs = next;
    return changed;
  };

  const payload = (run: string | null): DashboardPayload => {
    const now = new Date();
    const views = [...runs].flatMap(([name, { events, pid }]) => {
      try {
        return [{ name, view: viewOf(events, now, isAlive(pid)) }];
      } catch {
        // One malformed log must not take the dashboard down with it.
        return [];
      }
    });
    const shown = run === null ? views[0] : views.find((entry) => entry.name === run);
    return { runs: views.map(({ view }) => summaryOf(view)), view: shown?.view ?? null };
  };

  const send = (client: Client) => {
    const data = JSON.stringify(payload(client.run));
    if (data === client.last) return;
    client.last = data;
    client.res.write(`data: ${data}\n\n`);
  };
  const broadcast = () => clients.forEach(send);
  const stopWatching = () => {
    timers.forEach(clearInterval);
    timers = [];
  };

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only this machine's own names, so a web page using DNS rebinding cannot read the runs.
    if (req.method !== "GET" || !hosts.has(req.headers.host ?? "")) return void res.writeHead(403).end();
    if (url.pathname === "/") {
      const page = await readFile(new URL("./dashboard.html", import.meta.url));
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
    }
    if (url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 1000\n\n");
      const client: Client = { res, run: url.searchParams.get("run"), last: "" };
      clients.add(client);
      res.on("close", () => {
        clients.delete(client);
        if (clients.size === 0) stopWatching();
      });
      refresh();
      send(client);
      if (timers.length === 0) timers = [setInterval(() => refresh() && broadcast(), pollMs), setInterval(broadcast, TICK_MS)];
      return;
    }
    const file = evidenceFile(runsDir, url.pathname);
    const body = file && (await stat(file).then((s) => s.isFile(), () => false)) ? await readFile(file) : null;
    if (file && body) {
      const headers = { "content-type": CONTENT_TYPES[extname(file).toLowerCase()], "accept-ranges": "bytes", "x-content-type-options": "nosniff" };
      const range = byteRange(req.headers.range, body.length);
      if (range === "unsatisfiable") return void res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      if (range === null) return void res.writeHead(200, headers).end(body);
      const { start, end } = range;
      return void res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` }).end(body.subarray(start, end + 1));
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
  };
  const server = createServer((req, res) => {
    respond(req, res).catch(() => (res.headersSent ? res : res.writeHead(500)).end());
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done());
  });
  const bound = (server.address() as AddressInfo).port;
  hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);

  return {
    url: `http://127.0.0.1:${bound}/`,
    async close() {
      stopWatching();
      for (const client of clients) client.res.end();
      clients.clear();
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
    },
  };
}
