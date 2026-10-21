import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, BrowserContextOptions, Locator as Found, Page } from "playwright";
import type { RunningApp } from "./app.ts";
import { firstLine, phaseOf, stepName, type Phase } from "./report.ts";
import { describeLocator, isAbsence, stepsOf, type Assertion, type Check, type Locator, type NumberedCheck, type Step, type UiReference } from "./scenario.ts";
import type { Cause, CheckRun, Evidence, StepResult } from "./verdict.ts";

const VIEWPORT = { width: 1280, height: 800 };
const GOTO_MS = 15_000;
const ACTION_MS = 5_000;
const ASSERT_MS = 5_000;
const POLL_MS = 100;
const QUIET_MS = 300;
const SETTLE_CAP_MS = 5_000;
const EVIDENCE_MS = 5_000;
const STEP_MS = 20_000;
const LOOK_CAP_CHARS = 120 * 1024;

type Problem =
  | { status: "failed"; expected: string; observed: string }
  | { status: "could_not_run"; cause: Cause; detail: string };
/** Where a rehearsal stopped, and `text`, one line for the repair prompt saying what failed and what the screen showed. */
export type RehearsalProblem = Problem & { index: number; text: string };
type Observation = { holds: boolean; expected: string; observed: string };
type Session = { context: BrowserContext; page: Page; app: RunningApp; signal: AbortSignal; inFlight(): number; died(): boolean };

const cannot = (cause: Cause, detail: string): Problem => ({ status: "could_not_run", cause, detail });
const hung = cannot("page_hung", `the step did not finish in ${STEP_MS / 1000} s; the page may be stuck in a loop`);
const lost: Evidence = { state: "missing", reason: "the page hung" };
const LATE = Symbol("late");
const HANG = Symbol("hang");
const matches = (n: number) => `${n} visible match${n === 1 ? "" : "es"}`;
const quoted = (texts: readonly string[]) => (texts.length ? texts.map((text) => JSON.stringify(text)).join(", ") : "nothing");
const textOf = (problem: Problem) => (problem.status === "failed" ? `expected ${problem.expected}, saw ${problem.observed}` : problem.detail);

async function openSession(browser: Browser, app: RunningApp, signal: AbortSignal, options: BrowserContextOptions = {}): Promise<Session> {
  const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block", ...options });
  // The app's own script runs in this browser, on this machine, so it may reach the app and nothing else.
  const origin = new URL(app.origin).origin;
  const socketOrigin = origin.replace(/^http/, "ws");
  await context.route((url) => url.origin !== origin, (route) => route.abort("blockedbyclient"));
  await context.routeWebSocket((url) => url.origin !== socketOrigin, (socket) => socket.close());
  const page = await context.newPage();
  let inFlight = 0;
  let crashed = false;
  page.on("request", () => inFlight++);
  page.on("requestfinished", () => inFlight--);
  page.on("requestfailed", () => inFlight--);
  page.on("crash", () => { crashed = true; });
  return { context, page, app, signal, inFlight: () => inFlight, died: () => crashed || page.isClosed() || !browser.isConnected() };
}

/**
 * Gives one step STEP_MS, and stops it at once when the run is stopped. Playwright's own timeouts never fire while
 * the page's script is stuck in a loop, so both cases close the context, which makes every pending call reject.
 */
async function bounded<T>(s: Session, onHang: () => T, work: () => Promise<T>): Promise<T> {
  const finished = new AbortController();
  const late = sleep(STEP_MS, LATE, { signal: AbortSignal.any([s.signal, finished.signal]) });
  try {
    const result = await Promise.race([work(), late]);
    if (result !== LATE) return result;
  } catch (error) {
    if (!s.signal.aborted) throw error;
  } finally {
    finished.abort();
  }
  await closeQuietly(s);
  s.signal.throwIfAborted();
  return onHang();
}

function within(scope: Page | Found, l: Locator): Found {
  switch (l.by) {
    case "role": return scope.getByRole(l.role, { name: l.name, exact: true });
    case "label": return scope.getByLabel(l.text, { exact: true });
    case "text": return scope.getByText(l.text, { exact: true });
    case "testId": return scope.getByTestId(l.id);
    case "css": return scope.locator(l.selector);
  }
}

function find(page: Page, l: Locator): Found {
  return within(l.within ? find(page, l.within) : page, l).filter({ visible: true });
}

/** Waits until no request has been in flight for 300 ms, so an assertion never reads the screen from before the action landed. */
async function settle(s: Session): Promise<void> {
  const deadline = Date.now() + SETTLE_CAP_MS;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (s.inFlight() > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= QUIET_MS) break;
    await sleep(25);
  }
  // A click that navigates destroys the page's context mid-evaluate; the next step's own wait covers the new page.
  await s.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))).catch(() => {});
}

async function diagnose(s: Session, target: Found | null, error: unknown): Promise<Problem> {
  const message = firstLine(error);
  if (s.died()) return cannot("browser_error", `the browser page died: ${message}`);
  if (!(await s.app.alive())) return cannot("app_down", `the app stopped running: ${message}`);
  if (!target) return cannot("not_actionable", message);
  const n = await target.count();
  if (n === 0) return cannot("no_match", "no visible match");
  if (n > 1) return cannot("ambiguous", `${matches(n)}, so it is unclear which one to use`);
  return cannot("not_actionable", message);
}

async function act(s: Session, target: Found | null, run: () => Promise<unknown>): Promise<Problem | null> {
  try {
    await run();
  } catch (error) {
    return diagnose(s, target, error);
  }
  await settle(s);
  return null;
}

/** Any error the step did not explain itself becomes a could-not-run result, so a check always ends in a result. */
async function guarded(s: Session, work: () => Promise<Problem | null>): Promise<Problem | null> {
  try {
    return await work();
  } catch (error) {
    return diagnose(s, null, error);
  }
}

// A greedy pick can take the element a later text needs, so this searches for a full one-to-one matching.
function eachOnItsOwnElement(want: readonly string[], elements: readonly string[][]): boolean {
  const holder = new Map<number, number>();
  const place = (t: number, tried: Set<number>): boolean => elements.some((lines, e) => {
    if (tried.has(e) || !lines.includes(want[t])) return false;
    tried.add(e);
    const other = holder.get(e);
    if (other !== undefined && !place(other, tried)) return false;
    holder.set(e, t);
    return true;
  });
  return want.every((_, t) => place(t, new Set()));
}

async function focusText(page: Page): Promise<string> {
  const focused = page.locator(":focus");
  if ((await focused.count()) !== 1) return "nothing focused";
  // Focus can move between the count and the snapshot. This text only describes; it never decides.
  const snapshot = await focused.ariaSnapshot({ timeout: 1_000 }).catch(() => "");
  const first = snapshot.split("\n")[0].replace(/^- /, "");
  return first ? `focus on ${first}` : "focus on an element with no ARIA snapshot";
}

async function observe(page: Page, a: Assertion): Promise<Observation> {
  const found = find(page, a.target);
  switch (a.do) {
    case "expect_visible": {
      const n = await found.count();
      return { holds: n > 0, expected: "at least 1 visible match", observed: matches(n) };
    }
    case "expect_absent": {
      const n = await found.count();
      return { holds: n === 0, expected: matches(0), observed: matches(n) };
    }
    case "expect_count": {
      const n = await found.count();
      return { holds: n === a.count, expected: matches(a.count), observed: matches(n) };
    }
    case "expect_texts": {
      const elements = (await found.allInnerTexts()).map((text) => text.split("\n").map((line) => line.trim()).filter(Boolean));
      return {
        holds: elements.length === a.texts.length && eachOnItsOwnElement(a.texts, elements),
        expected: quoted(a.texts),
        observed: quoted(elements.map((lines) => lines.join(" / "))),
      };
    }
    case "expect_focus": {
      const holds = await found.evaluateAll((elements) => elements.length === 1 && elements[0] === document.activeElement);
      return { holds, expected: `focus on ${describeLocator(a.target)}`, observed: await focusText(page) };
    }
  }
}

async function confirm(s: Session, a: Assertion, phase: Phase): Promise<Problem | null> {
  const deadline = Date.now() + ASSERT_MS;
  let seen = await observe(s.page, a);
  while (!seen.holds && Date.now() < deadline) {
    await sleep(POLL_MS);
    seen = await observe(s.page, a);
  }
  if (seen.holds) return null;
  const saw = `expected ${seen.expected}, saw ${seen.observed}`;
  // A dead app leaves its last page on screen, and a failure read from that page says nothing about the app.
  if (!(await s.app.alive())) return cannot("app_down", `the app stopped running: ${saw}`);
  return phase === "then"
    ? { status: "failed", expected: seen.expected, observed: seen.observed }
    : cannot("setup_failed", saw);
}

async function runStep(s: Session, step: Step, phase: Phase): Promise<Problem | null> {
  switch (step.do) {
    case "goto":
      return act(s, null, () => s.page.goto(new URL(step.path, s.app.origin).href, { timeout: GOTO_MS }));
    case "click": {
      const target = find(s.page, step.target);
      return act(s, target, () => target.click({ timeout: ACTION_MS }));
    }
    case "fill": {
      const target = find(s.page, step.target);
      return act(s, target, () => target.fill(step.value, { timeout: ACTION_MS }));
    }
    case "press": {
      const target = step.target ? find(s.page, step.target) : null;
      return act(s, target, () => (target ? target.press(step.key, { timeout: ACTION_MS }) : s.page.keyboard.press(step.key)));
    }
    case "expect_visible":
    case "expect_absent":
    case "expect_count":
    case "expect_focus":
    case "expect_texts":
      return confirm(s, step, phase);
  }
}

const openStart = (s: Session) => act(s, null, () => s.page.goto(s.app.startUrl, { timeout: GOTO_MS }));

/**
 * The code rules checked right before `when`. The gone rule: whatever `then` expects gone must be on screen now.
 * The effect rule: at least one `then` assertion must be false now, so the check can see what `when` changes.
 * The first `when` target is checked before that, so a missing click is not hidden by an absence.
 */
async function rulesBeforeWhen(s: Session, check: Check): Promise<Problem | null> {
  const whenAt = check.given.length;
  const thenAt = whenAt + check.when.length;
  const first = check.when[0];
  // Before the absence rule. An absent new control would hide a click the old app cannot make.
  if (first.do !== "goto" && first.target && (await find(s.page, first.target).count()) === 0) {
    return cannot("no_match", `${stepName(check, whenAt)}: nothing matched its target before the "when" steps`);
  }
  for (const [i, a] of check.then.entries()) {
    if (isAbsence(a) && (await find(s.page, a.target).count()) === 0) {
      return cannot("gone_rule", `${stepName(check, thenAt + i)} expects something gone, but nothing matched it before the "when" steps, so its absence would prove nothing`);
    }
  }
  const held: string[] = [];
  for (const [i, a] of check.then.entries()) {
    const seen = await observe(s.page, a);
    if (!seen.holds) return null;
    held.push(`${stepName(check, thenAt + i)} saw ${seen.observed}`);
  }
  return cannot("effect_rule", `every "then" assertion already held before the "when" steps, so the check cannot see what they change: ${held.join("; ")}`);
}

async function capture(file: string, write: (file: string) => Promise<unknown>): Promise<Evidence> {
  try {
    await write(file);
    return { state: "captured", file };
  } catch (error) {
    return { state: "missing", reason: firstLine(error) };
  }
}

async function record(s: Session, dir: string, index: number, atMs: number, problem: Problem | null): Promise<StepResult> {
  const name = String(index + 1).padStart(2, "0");
  const screenshot = await capture(join(dir, `${name}.png`), (path) => s.page.screenshot({ path, timeout: EVIDENCE_MS }));
  if (!problem) return { status: "passed", index, atMs, screenshot };
  const aria = await capture(join(dir, `${name}.aria.yml`), async (path) => {
    await writeFile(path, await s.page.locator("body").ariaSnapshot({ timeout: EVIDENCE_MS }));
  });
  return { ...problem, index, atMs, screenshot, aria };
}

// Closing a context twice is harmless, and closing one whose browser died throws; neither may hide the result.
const closeQuietly = (s: Session) => s.context.close().catch(() => {});

export async function lookAtApp(browser: Browser, app: RunningApp, signal: AbortSignal): Promise<UiReference> {
  const s = await openSession(browser, app, signal);
  const onHang = () => {
    throw new Error(`looking at the start page did not finish in ${STEP_MS / 1000} s; the page may be stuck in a loop`);
  };
  try {
    return await bounded(s, onHang, () => look(s));
  } finally {
    await closeQuietly(s);
  }
}

async function look(s: Session): Promise<UiReference> {
  const origin = new URL(s.app.origin).origin;
  const bodies: Promise<{ url: string; text: string } | null>[] = [];
  s.page.on("response", (response) => {
    if (new URL(response.url()).origin !== origin || !/html|javascript/.test(response.headers()["content-type"] ?? "")) return;
    bodies.push(response.text().then((text) => ({ url: response.url(), text }), () => null));
  });
  await s.page.goto(s.app.startUrl, { timeout: GOTO_MS });
  await settle(s);
  const ariaSnapshot = await s.page.locator("body").ariaSnapshot();
  const loaded = (await Promise.all(bodies)).filter((file) => file !== null).sort((a, b) => a.url.localeCompare(b.url));
  let room = LOOK_CAP_CHARS;
  let truncated = false;
  const files: UiReference["files"] = [];
  for (const file of loaded) {
    const text = file.text.slice(0, room);
    if (text) files.push({ url: file.url, text });
    room -= text.length;
    truncated = text.length < file.text.length;
    if (truncated) break;
  }
  return { ariaSnapshot, files, truncated };
}

/** `onStep` hears each step as it is recorded, and hears the last step again if the app's death rewrites it. */
export async function runCheck(
  browser: Browser,
  app: RunningApp,
  check: NumberedCheck,
  dir: string,
  signal: AbortSignal,
  onStep: (result: StepResult) => void = () => {},
): Promise<CheckRun> {
  const out = resolve(dir);
  await mkdir(out, { recursive: true });
  const s = await openSession(browser, app, signal, { recordVideo: { dir: out } });
  // The video starts with the page, so atMs is also the offset into the video.
  const startedAt = Date.now();
  try {
    const traceFailure = await s.context.tracing.start({ screenshots: true, snapshots: true }).then(() => null, firstLine);
    const whenAt = check.given.length;
    const steps: StepResult[] = [];
    const push = (result: StepResult) => {
      steps.push(result);
      onStep(result);
    };
    let stopped = false;
    for (const [index, step] of stepsOf(check).entries()) {
      if (stopped) {
        push({ status: "skipped", index });
        continue;
      }
      // The start page has its own 20s. The step has its own. The screenshot is outside both, so a slow
      // load or a slow capture cannot mark a step that finished as hung.
      const hang = (): typeof HANG => HANG;
      let problem: Problem | null | typeof HANG = null;
      if (index === 0) problem = await bounded<Problem | null | typeof HANG>(s, hang, () => guarded(s, () => openStart(s)));
      if (problem === null) {
        problem = await bounded<Problem | null | typeof HANG>(s, hang, () => guarded(s, async () =>
          (index === whenAt ? await rulesBeforeWhen(s, check) : null)
          ?? await runStep(s, step, phaseOf(check, index))));
      }
      if (problem === HANG) {
        push({ ...hung, index, atMs: Date.now() - startedAt, screenshot: lost, aria: lost });
        stopped = true;
        continue;
      }
      const result = await record(s, out, index, Date.now() - startedAt, problem);
      push(result);
      stopped = result.status !== "passed";
    }
    // An app that dies right after it answers leaves the updated page on screen, so every assertion still holds.
    const last = steps[steps.length - 1];
    if (last.status === "passed" && !(await app.alive())) {
      const down: StepResult = {
        status: "could_not_run", cause: "app_down", detail: "the app stopped running by the end of the check",
        index: last.index, atMs: last.atMs, screenshot: last.screenshot, aria: { state: "missing", reason: "the app had stopped" },
      };
      steps[steps.length - 1] = down;
      onStep(down);
    }
    const trace: Evidence = traceFailure === null
      ? await capture(join(out, "trace.zip"), (path) => s.context.tracing.stop({ path }))
      : { state: "missing", reason: traceFailure };
    const appLog = await capture(join(out, "app.log"), async (path) => writeFile(path, await app.logs()));
    const recording = s.page.video();
    const video = await capture(join(out, "video.webm"), async (path) => {
      await s.context.close();
      if (!recording) throw new Error("no video was recorded");
      await rename(await recording.path(), path);
    });
    return { checkId: check.id, steps, video, trace, appLog };
  } finally {
    await closeQuietly(s);
  }
}

export async function rehearseCheck(browser: Browser, app: RunningApp, check: Check, signal: AbortSignal): Promise<RehearsalProblem | null> {
  const s = await openSession(browser, app, signal);
  const step = (work: () => Promise<Problem | null>) => bounded(s, () => hung, () => guarded(s, work));
  try {
    const start = await step(() => openStart(s));
    if (start) return { ...start, index: 0, text: `the start page did not load: ${textOf(start)}` };
    for (const [index, given] of check.given.entries()) {
      const problem = await step(() => runStep(s, given, "given"));
      if (problem) return { ...problem, index, text: `${stepName(check, index)}: ${textOf(problem)}` };
    }
    const broken = await step(() => rulesBeforeWhen(s, check));
    return broken ? { ...broken, index: check.given.length, text: textOf(broken) } : null;
  } finally {
    await closeQuietly(s);
  }
}
