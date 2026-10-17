import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import {
  ScenarioSchema, checksOf, describeLocator, freeze, planProblems, replaceChecks, sentencesOf, uncoveredSentences,
  type PlanSource,
} from "./scenario.ts";

const root = new URL("../", import.meta.url);
const prText = readFileSync(new URL("practice/demo-todo/prs/delete-correct/pr.md", root), "utf8");
const FIXTURES = ["good", "liar", "typo", "no-setup", "vacuous"];
const raw = (name: string) => JSON.parse(readFileSync(new URL(`scripts/fixtures/demo-todo-${name}.json`, root), "utf8"));
const fixture = (name: string) => ScenarioSchema.parse(raw(name));
const source: PlanSource = { kind: "file", path: "scripts/fixtures/demo-todo-good.json" };

test("every fixture parses and breaks no plan rule, so only running the app can catch the bad ones", () => {
  for (const name of FIXTURES) assert.deepEqual(planProblems(fixture(name), prText), [], name);
});

test("sentencesOf splits each practice PR into its five sentences and drops the title", () => {
  for (const name of ["delete-correct", "delete-bug"]) {
    assert.deepEqual(sentencesOf(readFileSync(new URL(`practice/demo-todo/prs/${name}/pr.md`, root), "utf8")), [
      "After you delete a task, focus used to jump to the task list box, so keyboard users had to tab back to where they were.",
      "Now focus moves to the Delete button of the next task.",
      "If you deleted the last task in the list, it moves to the previous task instead.",
      "If the list is now empty, focus goes to the task list box as before.",
      "Delete still removes only the task you clicked.",
    ], name);
  }
});

test("a PR with text too short to quote, or a repeated sentence, still gets a valid plan", () => {
  const github = `${prText}\n## Changes\n\n- Docs\n\n## Testing\n\nN/A\n`;
  assert.deepEqual(sentencesOf(github), sentencesOf(prText));
  assert.deepEqual(planProblems(fixture("good"), github), []);

  const repeated = `${prText}\nDelete still removes only the task you clicked.\n`;
  assert.deepEqual(sentencesOf(repeated), sentencesOf(prText));
  assert.deepEqual(planProblems(fixture("good"), repeated), []);
});

test("sentencesOf reads GitHub's usual layout: headings dropped, each list item its own sentence", () => {
  assert.deepEqual(sentencesOf("## Summary\n- Delete now removes only the task you clicked.\n- Focus moves next"), [
    "Delete now removes only the task you clicked.",
    "Focus moves next",
  ]);
  assert.deepEqual(sentencesOf("## Summary\nDelete keeps focus. It moves to the next task.\n\n## Test plan\n- [x] npm test\n"), [
    "Delete keeps focus.",
    "It moves to the next task.",
    "[x] npm test",
  ]);
});

test("sentencesOf keeps bullets without full stops apart, in every list style", () => {
  assert.deepEqual(sentencesOf("Changes:\n- Removes the task\n* Moves focus next\n+ Keeps the list box\n1. Adds a test\n2. Fixes a typo\n   in the label"), [
    "Changes:",
    "Removes the task",
    "Moves focus next",
    "Keeps the list box",
    "Adds a test",
    "Fixes a typo in the label",
  ]);
});

test("uncoveredSentences lists the PR sentence no claim quotes and no not-testable entry marks", () => {
  assert.deepEqual(uncoveredSentences(fixture("good"), prText), []);
  assert.deepEqual(uncoveredSentences({ ...fixture("good"), notTestable: [] }, prText), [sentencesOf(prText)[0]]);
});

test("planProblems rejects a plan that leaves a PR sentence unaccounted for", () => {
  const scenario = fixture("good");
  scenario.claims.splice(1, 1);
  assert.deepEqual(planProblems(scenario, prText), [
    'sentence 2 of the PR text, "Now focus moves to the Delete button of the next task.", is neither quoted by a claim nor marked not testable; '
      + "write a claim for it, or mark it not testable with a reason if it states nothing a user can see in this app",
  ]);
});

test("planProblems rejects a sentence that is both quoted by a claim and marked not testable", () => {
  const scenario = fixture("good");
  scenario.notTestable.push({ quote: "Delete still removes only", reason: "Already true before this change." });
  assert.deepEqual(planProblems(scenario, prText), [
    'sentence 5 of the PR text, "Delete still removes only the task you clicked.", is quoted by a claim and also marked not testable; keep only one',
  ]);
});

test("planProblems holds a not-testable quote to the same rules as a claim's", () => {
  const scenario = fixture("good");
  scenario.notTestable[0].quote = "focus used to jump to the menu";
  assert.deepEqual(planProblems(scenario, prText), [
    'notTestable 1: "quote" is not in any sentence of the PR text; copy it exactly from one sentence',
    `sentence 1 of the PR text, ${JSON.stringify(sentencesOf(prText)[0])}, is neither quoted by a claim nor marked not testable; `
      + "write a claim for it, or mark it not testable with a reason if it states nothing a user can see in this app",
  ]);
});

test("planProblems rejects a quote that is in no PR sentence", () => {
  const scenario = fixture("good");
  scenario.claims[0].quote = "Delete removes every task at once.";
  assert.deepEqual(planProblems(scenario, prText), [
    'claim 1: "quote" is not in any sentence of the PR text; copy it exactly from one sentence',
    'sentence 5 of the PR text, "Delete still removes only the task you clicked.", is neither quoted by a claim nor marked not testable; '
      + "write a claim for it, or mark it not testable with a reason if it states nothing a user can see in this app",
  ]);
});

test("planProblems rejects a quote that matches more than one PR sentence", () => {
  const scenario = fixture("good");
  scenario.claims[2].quote = "the task";
  assert.deepEqual(planProblems(scenario, prText), [
    'claim 3: "quote" appears in 3 sentences of the PR text; quote enough to match only one',
    'sentence 3 of the PR text, "If you deleted the last task in the list, it moves to the previous task instead.", is neither quoted by a claim nor marked not testable; '
      + "write a claim for it, or mark it not testable with a reason if it states nothing a user can see in this app",
  ]);
});

test("planProblems rejects a css :focus selector, even inside within", () => {
  const scenario = fixture("good");
  scenario.claims[3].checks[0].then[1] = {
    do: "expect_visible",
    target: { by: "role", role: "button", name: "Delete Buy milk", within: { by: "css", selector: "li:focus-within" } },
  };
  assert.deepEqual(planProblems(scenario, prText), [
    'check c4.1: css selector "li:focus-within" uses :focus; check focus with expect_focus',
  ]);
});

test("planProblems rejects a then made only of absences", () => {
  const scenario = fixture("good");
  const titles = { by: "css", selector: ".task-title" } as const;
  scenario.claims[0].checks[0].then = [
    { do: "expect_absent", target: { by: "text", text: "Walk dog" } },
    { do: "expect_count", target: titles, count: 0 },
    { do: "expect_texts", target: titles, texts: [] },
  ];
  assert.deepEqual(planProblems(scenario, prText), [
    'check c1.1: "then" needs at least one assertion that is not an absence (expect_absent, expect_count 0, or empty expect_texts)',
  ]);
});

test("the schema rejects shapes the planner must not write", () => {
  const cases: [string, (s: any) => void][] = [
    ["a role locator without a name", (s) => { delete s.claims[0].checks[0].given[1].target.name; }],
    ["the listitem role", (s) => { s.claims[0].checks[0].given[1].target = { by: "role", role: "listitem", name: "Buy milk" }; }],
    ["expect_texts on an exact-text locator", (s) => { s.claims[0].checks[0].then[0].target = { by: "text", text: "Buy milk" }; }],
    ["expect_focus in given", (s) => { s.claims[0].checks[0].given.push({ do: "expect_focus", target: { by: "label", text: "Title" } }); }],
    ["an id on a claim", (s) => { s.claims[0].id = "only"; }],
    ["an id on a check", (s) => { s.claims[0].checks[0].id = "check-1"; }],
    ["a goto that leaves the app's origin", (s) => { s.claims[0].checks[0].given.unshift({ do: "goto", path: "//example.com/" }); }],
    ["no notTestable list", (s) => { delete s.notTestable; }],
    ["a not-testable entry without a reason", (s) => { delete s.notTestable[0].reason; }],
  ];
  for (const [label, mutate] of cases) {
    const scenario = raw("good");
    mutate(scenario);
    assert.equal(ScenarioSchema.safeParse(scenario).success, false, label);
  }
});

test("the JSON Schema uses anyOf, never oneOf, which Anthropic and Google reject", () => {
  assert.doesNotMatch(JSON.stringify(z.toJSONSchema(ScenarioSchema)), /oneOf/);
});

test("freeze gives a stable hash and a deeply immutable copy", () => {
  const scenario = fixture("good");
  const frozen = freeze(scenario, source);
  assert.match(frozen.sha256, /^[0-9a-f]{64}$/);
  assert.equal(freeze(fixture("good"), source).sha256, frozen.sha256);
  assert.notEqual(freeze(fixture("liar"), source).sha256, frozen.sha256);

  const target = frozen.claims[0].checks[0].given[0];
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.claims) && Object.isFrozen(target) && Object.isFrozen(frozen.source));
  assert.equal(Reflect.set(frozen.claims[0], "quote", "changed"), false);

  scenario.claims[0].quote = "changed after freezing";
  assert.equal(frozen.claims[0].quote, "Delete still removes only the task you clicked.");
});

test("checksOf numbers claims and checks from 1, and replaceChecks swaps only the named checks", () => {
  const good = fixture("good");
  const liar = fixture("liar");
  assert.deepEqual(checksOf(good).map((check) => check.id), ["c1.1", "c2.1", "c3.1", "c4.1"]);

  const replaced = replaceChecks(good, [{ claimIndex: 1, checkIndex: 0 }], [liar.claims[1].checks[0]]);
  assert.deepEqual(replaced, liar);
  assert.deepEqual(good, fixture("good"));
  assert.throws(() => replaceChecks(good, [{ claimIndex: 1, checkIndex: 0 }], []));
});

test("describeLocator reads like the report", () => {
  assert.equal(
    describeLocator({ by: "role", role: "button", name: "Delete Alpha", within: { by: "role", role: "dialog", name: "Delete task?" } }),
    'button "Delete Alpha" in dialog "Delete task?"',
  );
});
