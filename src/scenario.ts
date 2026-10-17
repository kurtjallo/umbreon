import { createHash } from "node:crypto";
import { z } from "zod";

const ROLES = ["alert", "alertdialog", "button", "cell", "checkbox", "combobox", "dialog", "form", "group", "heading",
  "img", "link", "list", "main", "menu", "menuitem", "navigation", "option", "progressbar", "radio", "region", "row",
  "searchbox", "spinbutton", "status", "switch", "tab", "table", "tabpanel", "textbox"] as const;
const KEYS = ["Enter", "Tab", "Shift+Tab", "Escape", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Delete", "Home", "End"] as const;
const Text = z.string().min(1).max(200);
const It = z.string().startsWith("It should").max(200);

const ByRole = z.strictObject({ by: z.literal("role"), role: z.enum(ROLES), name: Text });
const ByLabel = z.strictObject({ by: z.literal("label"), text: Text });
const ByText = z.strictObject({ by: z.literal("text"), text: Text });
const ByTestId = z.strictObject({ by: z.literal("testId"), id: Text });
const ByCss = z.strictObject({ by: z.literal("css"), selector: Text });
const within = { within: z.union([ByRole, ByLabel, ByText, ByTestId, ByCss]).optional() };

export const LocatorSchema = z.union([
  ByRole.extend(within), ByLabel.extend(within), ByText.extend(within), ByTestId.extend(within), ByCss.extend(within),
]);
export const ListLocatorSchema = z.union([
  ByRole.extend(within), ByLabel.extend(within), ByTestId.extend(within), ByCss.extend(within),
]);

const Goto = z.strictObject({ do: z.literal("goto"), path: z.string().regex(/^\/(?![/\\])\S*$/).max(200) });
const Click = z.strictObject({ do: z.literal("click"), target: LocatorSchema });
const Fill = z.strictObject({ do: z.literal("fill"), target: LocatorSchema, value: z.string().max(200) });
const Press = z.strictObject({ do: z.literal("press"), key: z.enum(KEYS), target: LocatorSchema.optional() });
const ExpectVisible = z.strictObject({ do: z.literal("expect_visible"), target: LocatorSchema });
const ExpectAbsent = z.strictObject({ do: z.literal("expect_absent"), target: LocatorSchema });
const ExpectCount = z.strictObject({ do: z.literal("expect_count"), target: LocatorSchema, count: z.int().min(0).max(50) });
const ExpectFocus = z.strictObject({ do: z.literal("expect_focus"), target: LocatorSchema });
const ExpectTexts = z.strictObject({ do: z.literal("expect_texts"), target: ListLocatorSchema, texts: z.array(Text).max(20) });

export const ActionSchema = z.union([Goto, Click, Fill, Press]);
export const AssertionSchema = z.union([ExpectVisible, ExpectAbsent, ExpectCount, ExpectFocus, ExpectTexts]);
export const SetupStepSchema = z.union([Goto, Click, Fill, Press, ExpectVisible, ExpectCount, ExpectTexts]);
export const CheckSchema = z.strictObject({
  it: It,
  given: z.array(SetupStepSchema).max(20),
  when: z.array(ActionSchema).min(1).max(10),
  then: z.array(AssertionSchema).min(1).max(10),
});
const MIN_QUOTE = 8;
const Quote = z.string().min(MIN_QUOTE).max(400);
export const ClaimSchema = z.strictObject({ quote: Quote, it: It, checks: z.array(CheckSchema).min(1).max(3) });
export const NotTestableSchema = z.strictObject({ quote: Quote, reason: Text });
export const ScenarioSchema = z.strictObject({
  claims: z.array(ClaimSchema).min(1).max(8),
  notTestable: z.array(NotTestableSchema).max(40),
});

type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type Locator = DeepReadonly<z.infer<typeof LocatorSchema>>;
export type Action = DeepReadonly<z.infer<typeof ActionSchema>>;
export type Assertion = DeepReadonly<z.infer<typeof AssertionSchema>>;
export type Step = Action | Assertion;
export type Check = DeepReadonly<z.infer<typeof CheckSchema>>;
export type Claim = DeepReadonly<z.infer<typeof ClaimSchema>>;
export type Scenario = DeepReadonly<z.infer<typeof ScenarioSchema>>;
export type NumberedCheck = Check & { readonly id: string; readonly claimId: string; readonly claimIndex: number; readonly checkIndex: number };

/** What the planner learns about the running app before it writes a plan. */
export type UiReference = { ariaSnapshot: string; files: { url: string; text: string }[]; truncated: boolean };

export type PlanSource =
  | { kind: "model"; modelId: string; calls: number; usage: { inputTokens: number; outputTokens: number } }
  | { kind: "file"; path: string };
const frozenBrand = Symbol("FrozenScenario");
export type FrozenScenario = Scenario & {
  readonly sha256: string;
  readonly source: DeepReadonly<PlanSource>;
  readonly [frozenBrand]: true;
};

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;

/**
 * Paragraphs and list items are units, and each unit splits on ".", "!" or "?" followed by a space. Headings are dropped.
 * So is a sentence shorter than any quote, like "N/A", and a repeated sentence counts once, because a plan could
 * never quote either one alone.
 */
export function sentencesOf(prText: string): string[] {
  return [...new Set(prText.split("\n")
    .map((line) => (HEADING.test(line) ? "" : line.replace(LIST_ITEM, "\n\n")))
    .join("\n")
    .split(/\n\s*\n/)
    .flatMap((unit) => normalize(unit).split(/(?<=[.!?])\s+/))
    .filter((sentence) => sentence.length >= MIN_QUOTE))];
}

/** A quote that is a whole sentence picks that one, even when a longer sentence contains it too. */
function sentencesContaining(quote: string, prText: string): number[] {
  const needle = normalize(quote);
  const sentences = sentencesOf(prText);
  const whole = sentences.indexOf(needle);
  return whole !== -1 ? [whole] : sentences.flatMap((sentence, index) => (sentence.includes(needle) ? [index] : []));
}

/** The sentences these quotes pick out. A quote that matches no sentence, or several, picks out none. */
function quoted(quotes: readonly { quote: string }[], prText: string): Set<number> {
  return new Set(quotes.flatMap(({ quote }) => {
    const hits = sentencesContaining(quote, prText);
    return hits.length === 1 ? hits : [];
  }));
}

/** PR sentences that no claim with checks quotes and no not-testable entry marks. */
export function uncoveredSentences(scenario: Scenario, prText: string): string[] {
  const accounted = quoted([...scenario.claims.filter((claim) => claim.checks.length > 0), ...scenario.notTestable], prText);
  return sentencesOf(prText).filter((_, index) => !accounted.has(index));
}

export function isAbsence(step: Step): boolean {
  return step.do === "expect_absent"
    || (step.do === "expect_count" && step.count === 0)
    || (step.do === "expect_texts" && step.texts.length === 0);
}

export function checksOf(scenario: Scenario): NumberedCheck[] {
  return scenario.claims.flatMap((claim, i) => claim.checks.map((check, j) => ({
    id: `c${i + 1}.${j + 1}`, claimId: `c${i + 1}`, claimIndex: i, checkIndex: j, ...check,
  })));
}

/** One list for the driver and the verdict, so a StepResult's index means the same step to both. */
export function stepsOf(check: Check): Step[] {
  return [...check.given, ...check.when, ...check.then];
}

function describeOne(l: Locator): string {
  switch (l.by) {
    case "role": return `${l.role} ${JSON.stringify(l.name)}`;
    case "label": return `label ${JSON.stringify(l.text)}`;
    case "text": return `text ${JSON.stringify(l.text)}`;
    case "testId": return `test id ${JSON.stringify(l.id)}`;
    case "css": return `css ${JSON.stringify(l.selector)}`;
  }
}

export function describeLocator(l: Locator): string {
  return l.within ? `${describeOne(l)} in ${describeOne(l.within)}` : describeOne(l);
}

export function replaceChecks(
  scenario: Scenario,
  targets: readonly { claimIndex: number; checkIndex: number }[],
  replacements: readonly Check[],
): Scenario {
  if (targets.length !== replacements.length) throw new Error(`${targets.length} targets but ${replacements.length} replacements`);
  return {
    notTestable: scenario.notTestable,
    claims: scenario.claims.map((claim, i) => ({
      ...claim,
      checks: claim.checks.map((check, j) => {
        const n = targets.findIndex((t) => t.claimIndex === i && t.checkIndex === j);
        return n === -1 ? check : replacements[n];
      }),
    })),
  };
}

function locatorsOf(step: Step): Locator[] {
  if (!("target" in step) || !step.target) return [];
  return step.target.within ? [step.target, step.target.within] : [step.target];
}

export function planProblems(scenario: Scenario, prText: string): string[] {
  const problems: string[] = [];
  const checkQuote = (label: string, quote: string) => {
    const hits = sentencesContaining(quote, prText).length;
    if (hits === 0) problems.push(`${label}: "quote" is not in any sentence of the PR text; copy it exactly from one sentence`);
    if (hits > 1) problems.push(`${label}: "quote" appears in ${hits} sentences of the PR text; quote enough to match only one`);
  };
  scenario.claims.forEach((claim, i) => checkQuote(`claim ${i + 1}`, claim.quote));
  scenario.notTestable.forEach((note, i) => checkQuote(`notTestable ${i + 1}`, note.quote));
  const claimed = quoted(scenario.claims, prText);
  const marked = quoted(scenario.notTestable, prText);
  sentencesOf(prText).forEach((sentence, i) => {
    const which = `sentence ${i + 1} of the PR text, ${JSON.stringify(sentence)},`;
    if (claimed.has(i) && marked.has(i)) problems.push(`${which} is quoted by a claim and also marked not testable; keep only one`);
    if (!claimed.has(i) && !marked.has(i)) {
      problems.push(`${which} is neither quoted by a claim nor marked not testable; write a claim for it, or mark it not testable with a reason if it states nothing a user can see in this app`);
    }
  });
  for (const check of checksOf(scenario)) {
    for (const locator of stepsOf(check).flatMap(locatorsOf)) {
      if (locator.by === "css" && locator.selector.includes(":focus")) {
        problems.push(`check ${check.id}: css selector ${JSON.stringify(locator.selector)} uses :focus; check focus with expect_focus`);
      }
    }
    if (check.then.every(isAbsence)) {
      problems.push(`check ${check.id}: "then" needs at least one assertion that is not an absence (expect_absent, expect_count 0, or empty expect_texts)`);
    }
  }
  return problems;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function freeze(scenario: Scenario, source: PlanSource): FrozenScenario {
  const copy = structuredClone(scenario);
  const frozen: FrozenScenario = {
    ...copy,
    sha256: createHash("sha256").update(JSON.stringify(copy)).digest("hex"),
    source: structuredClone(source),
    [frozenBrand]: true,
  };
  return deepFreeze(frozen);
}
