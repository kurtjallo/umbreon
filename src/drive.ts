import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, BrowserContextOptions, Locator as Found, Page } from "playwright";
import type { RunningApp } from "./app.ts";
import { phaseOf, stepName, type Phase } from "./report.ts";
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
const LOOK_CAP_CHARS = 120 * 1024;

type Problem =
  | { status: "failed"; expected: string; observed: string }
  | { status: "could_not_run"; cause: Cause; detail: string };
type Observation = { holds: boolean; expected: string; observed: string };
type Session = { context: BrowserContext; page: Page; app: RunningApp; inFlight(): number; died(): boolean };

const cannot = (cause: Cause, detail: string): Problem => ({ status: "could_not_run", cause, detail });
const firstLine = (error: unknown) => String(error instanceof Error ? error.message : error).split("\n")[0];
const matches = (n: number) => `${n} visible match${n === 1 ? "" : "es"}`;
const quoted = (texts: readonly string[]) => (texts.length ? texts.map((text) => JSON.stringify(text)).join(", ") : "nothing");
const textOf = (problem: Problem) => (problem.status === "failed" ? `expected ${problem.expected}, saw ${problem.observed}` : problem.detail);

async function openSession(browser: Browser, app: RunningApp, options: BrowserContextOptions = {}): Promise<Session> {
  const context = await browser.newContext({ viewport: VIEWPORT, ...options });
  const page = await context.newPage();
  let inFlight = 0;
  let crashed = false;
  page.on("request", () => inFlight++);
  page.on("requestfinished", () => inFlight--);
  page.on("requestfailed", () => inFlight--);
  page.on("crash", () => { crashed = true; });
  return { context, page, app, inFlight: () => inFlight, died: () => crashed || page.isClosed() || !browser.isConnected() };
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

async function confirm(page: Page, a: Assertion, phase: Phase): Promise<Problem | null> {
  const deadline = Date.now() + ASSERT_MS;
  let seen = await observe(page, a);
  while (!seen.holds && Date.now() < deadline) {
    await sleep(POLL_MS);
    seen = await observe(page, a);
  }
  if (seen.holds) return null;
  return phase === "then"
    ? { status: "failed", expected: seen.expected, observed: seen.observed }
    : cannot("setup_failed", `expected ${seen.expected}, saw ${seen.observed}`);
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
      return confirm(s.page, step, phase);
  }
}

const openStart = (s: Session) => act(s, null, () => s.page.goto(s.app.startUrl, { timeout: GOTO_MS }));

/**
 * The code rules checked right before `when`. The gone rule: whatever `then` expects gone must be on screen now.
 * The effect rule: at least one `then` assertion must be false now, so the check can see what `when` changes.
 * The rehearsal also checks that the first `when` step's target is on screen.
 */
async function rulesBeforeWhen(s: Session, check: Check, rehearsal: boolean): Promise<Problem | null> {
  const whenAt = check.given.length;
  const thenAt = whenAt + check.when.length;
  for (const [i, a] of check.then.entries()) {
    if (isAbsence(a) && (await find(s.page, a.target).count()) === 0) {
      return cannot("gone_rule", `${stepName(check, thenAt + i)} expects something gone, but nothing matched it before the "when" steps, so its absence would prove nothing`);
    }
  }
  const first = check.when[0];
  if (rehearsal && first.do !== "goto" && first.target && (await find(s.page, first.target).count()) === 0) {
    return cannot("no_match", `${stepName(check, whenAt)}: nothing matched its target before the "when" steps`);
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

/** What the planner sees: the start page's ARIA snapshot and the same-origin HTML and JS the page loaded. */
export async function lookAtApp(browser: Browser, app: RunningApp): Promise<UiReference> {
  const s = await openSession(browser, app);
  try {
    const origin = new URL(app.origin).origin;
    const bodies: Promise<{ url: string; text: string } | null>[] = [];
    s.page.on("response", (response) => {
      if (new URL(response.url()).origin !== origin || !/html|javascript/.test(response.headers()["content-type"] ?? "")) return;
      bodies.push(response.text().then((text) => ({ url: response.url(), text }), () => null));
    });
    await s.page.goto(app.startUrl, { timeout: GOTO_MS });
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
  } finally {
    await closeQuietly(s);
  }
}

/** Runs one frozen check on a fresh browser context and records every step, with evidence, into `dir`. */
export async function runCheck(browser: Browser, app: RunningApp, check: NumberedCheck, dir: string): Promise<CheckRun> {
  const out = resolve(dir);
  await mkdir(out, { recursive: true });
  const s = await openSession(browser, app, { recordVideo: { dir: out } });
  // The video starts with the page, so atMs is also the offset into the video.
  const startedAt = Date.now();
  try {
    const traceFailure = await s.context.tracing.start({ screenshots: true, snapshots: true }).then(() => null, firstLine);
    const whenAt = check.given.length;
    const steps: StepResult[] = [];
    let stopped = false;
    for (const [index, step] of stepsOf(check).entries()) {
      if (stopped) {
        steps.push({ status: "skipped", index });
        continue;
      }
      const problem = await guarded(s, async () =>
        (index === 0 ? await openStart(s) : null)
        ?? (index === whenAt ? await rulesBeforeWhen(s, check, false) : null)
        ?? await runStep(s, step, phaseOf(check, index)));
      steps.push(await record(s, out, index, Date.now() - startedAt, problem));
      stopped = problem !== null;
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

/**
 * Runs a check's `given` on the old app, then the rules checked before `when`, and stops there.
 * Returns null when all of it holds, or one line for the repair prompt saying what failed and what the screen showed.
 */
export async function rehearseCheck(browser: Browser, app: RunningApp, check: Check): Promise<string | null> {
  const s = await openSession(browser, app);
  try {
    const start = await guarded(s, () => openStart(s));
    if (start) return `the start page did not load: ${textOf(start)}`;
    for (const [index, step] of check.given.entries()) {
      const problem = await guarded(s, () => runStep(s, step, "given"));
      if (problem) return `${stepName(check, index)}: ${textOf(problem)}`;
    }
    const broken = await guarded(s, () => rulesBeforeWhen(s, check, true));
    return broken ? textOf(broken) : null;
  } finally {
    await closeQuietly(s);
  }
}
