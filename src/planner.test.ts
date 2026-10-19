import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import {
  planScenario, renderPlannerInput, renderSortInput, repairChecks, sortProblems, sortSentences, systemPrompt,
  type CallObserver, type CallRecord, type PlannerInput,
} from "./planner.ts";
import { ScenarioSchema, planProblems, sentencesOf } from "./scenario.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const input: PlannerInput = {
  prText: read("practice/demo-todo/prs/delete-correct/pr.md"),
  diff: read("practice/demo-todo/prs/delete-correct/change.diff"),
  ui: {
    ariaSnapshot: '- heading "Tasks" [level=1]\n- textbox "Title"\n- button "Add task"',
    files: [{ url: "/app.js", text: "renderTasks();" }],
    truncated: false,
  },
};
const good = () => ScenarioSchema.parse(JSON.parse(read("scripts/fixtures/demo-todo-good.json")));
const sentences = sentencesOf(input.prText);
const HISTORY = "History: how focus moved before this change, not what the changed app does.";
const signal = new AbortController().signal;
const quiet: CallObserver = { started() {}, finished() {} };
const SCHEMA_INTRO = "\n\nReply with only one JSON object that matches this JSON Schema:\n";

const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  },
  warnings: [],
});

/** An observer that keeps every record. `heard()` checks each started call finished, then gives what each call came to and spent. */
function listen() {
  const calls: CallRecord[] = [];
  let started = 0;
  const observer: CallObserver = { started: () => started++, finished: (call) => calls.push(call) };
  const heard = () => {
    assert.equal(started, calls.length, "every call that started also finished");
    for (const call of calls) assert.ok(call.ms >= 0 && (call.ok ? call.problems.length === 0 : call.problems.length > 0), JSON.stringify(call));
    return calls.map(({ ok, inputTokens, outputTokens }) => ({ ok, inputTokens, outputTokens }));
  };
  return { observer, calls, heard };
}
const spent = (ok: boolean) => ({ ok, inputTokens: 100, outputTokens: 10 });

function systemOf(model: MockLanguageModelV4, call: number): string {
  const [system] = model.doGenerateCalls[call].prompt;
  assert.equal(system.role, "system");
  return system.role === "system" ? system.content : "";
}

const replySchemaOf = (system: string) => JSON.parse(system.slice(system.indexOf(SCHEMA_INTRO) + SCHEMA_INTRO.length));

function promptOf(model: MockLanguageModelV4, call: number): string {
  return model.doGenerateCalls[call].prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n");
}

test("sortSentences sees only the numbered sentences, with its own skill and schema as instructions at temperature 0", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [reply({ notTestable: [{ sentence: 1, reason: HISTORY }] })] });
  const { observer, heard } = listen();
  const result = await sortSentences(input.prText, model, signal, observer);
  assert.deepEqual(result, { ok: true, value: [{ quote: sentences[0], reason: HISTORY }] });
  assert.deepEqual(heard(), [spent(true)]);
  assert.equal(model.doGenerateCalls[0].temperature, 0);
  assert.ok(systemOf(model, 0).startsWith(`${systemPrompt("sort-sentences")}${SCHEMA_INTRO}`));
  assert.deepEqual(Object.keys(replySchemaOf(systemOf(model, 0)).properties), ["notTestable"]);

  const prompt = promptOf(model, 0);
  assert.equal(prompt, renderSortInput(input.prText));
  assert.equal(prompt, sentences.map((sentence, i) => `${i + 1}. ${sentence}`).join("\n"));
  for (const hidden of [input.diff, "+++ b/public/app.js", input.ui.ariaSnapshot, "renderTasks();", "/app.js", "Keep focus in the task list after deleting"]) {
    assert.ok(!prompt.includes(hidden), `the sorter's prompt holds ${JSON.stringify(hidden.slice(0, 40))}`);
  }
});

test("sortProblems rejects a number out of range or listed twice, and passes a valid list", () => {
  assert.deepEqual(sortProblems({ notTestable: [{ sentence: 1, reason: HISTORY }] }, 5), []);
  assert.deepEqual(sortProblems({ notTestable: [] }, 5), []);
  assert.deepEqual(sortProblems({ notTestable: [{ sentence: 6, reason: HISTORY }] }, 5), [
    "notTestable 1: there is no sentence 6; the sentences are numbered 1 to 5",
  ]);
  assert.deepEqual(sortProblems({ notTestable: [{ sentence: 1, reason: HISTORY }, { sentence: 1, reason: "Motivation: why." }] }, 5), [
    "notTestable 2: sentence 1 is listed more than once; list each sentence once",
  ]);
});

test("sortSentences retries once with the problems, then returns each sentence's exact text in PR order", async () => {
  const pr = `${input.prText}\n## Testing\n\n- Added unit tests for focus after delete.\n`;
  const testing = "Testing: which tests were added.";
  const model = new MockLanguageModelV4({
    doGenerate: [
      reply({ notTestable: [{ sentence: 7, reason: testing }, { sentence: 1, reason: HISTORY }, { sentence: 1, reason: HISTORY }] }),
      reply({ notTestable: [{ sentence: 6, reason: testing }, { sentence: 1, reason: HISTORY }] }),
    ],
  });
  const { observer, calls, heard } = listen();
  const result = await sortSentences(pr, model, signal, observer);
  assert.deepEqual(result, {
    ok: true,
    value: [{ quote: sentences[0], reason: HISTORY }, { quote: "Added unit tests for focus after delete.", reason: testing }],
  });
  assert.deepEqual(heard(), [spent(false), spent(true)]);
  assert.deepEqual(calls[0].problems, [
    "notTestable 1: there is no sentence 7; the sentences are numbered 1 to 6",
    "notTestable 3: sentence 1 is listed more than once; list each sentence once",
  ]);
  assert.ok(promptOf(model, 1).endsWith(
    "Your last answer was rejected:\n"
      + "- notTestable 1: there is no sentence 7; the sentences are numbered 1 to 6\n"
      + "- notTestable 3: sentence 1 is listed more than once; list each sentence once",
  ), promptOf(model, 1));
});

test("sortSentences gives up after two bad answers and counts both calls", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [reply({ notTestable: [{ sentence: 9, reason: HISTORY }] }), reply({ notTestable: [{ sentence: "one", reason: HISTORY }] })],
  });
  const { observer, heard } = listen();
  const result = await sortSentences(input.prText, model, signal, observer);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.length === 1 && result.problems[0].startsWith("notTestable.0.sentence: "), JSON.stringify(result));
  assert.deepEqual(heard(), [spent(false), spent(false)]);
});

test("planScenario asks for claims only and adds the sorted not-testable sentences itself", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [reply({ claims: good().claims })] });
  const { observer, heard } = listen();
  const result = await planScenario(input, good().notTestable, model, signal, observer);
  assert.deepEqual(result, { ok: true, value: good() });
  assert.deepEqual(heard(), [spent(true)]);
  const call = model.doGenerateCalls[0];
  assert.equal(call.temperature, 0);
  assert.ok(systemOf(model, 0).startsWith(`${systemPrompt("prove-change")}${SCHEMA_INTRO}`));
  assert.deepEqual(Object.keys(replySchemaOf(systemOf(model, 0)).properties), ["claims"]);
  assert.deepEqual(call.responseFormat, { type: "json" }, "no schema for the server to enforce");
  assert.equal(promptOf(model, 0), renderPlannerInput(input, good().notTestable));
});

test("planScenario rejects a reply that writes its own notTestable, like the review's plan for delete-bug", async () => {
  const previous = good().claims.filter((claim) => claim.quote === sentences[2]);
  const excuses = sentences.filter((sentence) => sentence !== sentences[2]).map((quote) => ({ quote, reason: "Not something a user can see." }));
  const model = new MockLanguageModelV4({ doGenerate: [reply({ claims: previous, notTestable: excuses }), reply({ claims: previous, notTestable: excuses })] });
  const { observer, calls, heard } = listen();
  const result = await planScenario(input, [], model, signal, observer);
  assert.deepEqual(result, { ok: false, problems: ['answer: Unrecognized key: "notTestable"'] });
  assert.deepEqual(heard(), [spent(false), spent(false)]);
  assert.deepEqual(calls.map((call) => call.problems), [['answer: Unrecognized key: "notTestable"'], ['answer: Unrecognized key: "notTestable"']]);
});

test("the review's dodge on delete-bug fails: only the sorter skips sentences, so the planner must claim the rest", async () => {
  const bug: PlannerInput = {
    ...input, prText: read("practice/demo-todo/prs/delete-bug/pr.md"), diff: read("practice/demo-todo/prs/delete-bug/change.diff"),
  };
  const bugSentences = sentencesOf(bug.prText);
  const sorter = new MockLanguageModelV4({ doGenerate: [reply({ notTestable: [{ sentence: 1, reason: HISTORY }] })] });
  const { observer, heard } = listen();
  const sorted = await sortSentences(bug.prText, sorter, signal, observer);
  assert.deepEqual(sorted, { ok: true, value: [{ quote: bugSentences[0], reason: HISTORY }] });
  if (!sorted.ok) return;

  const previous = good().claims.filter((claim) => claim.quote === "If you deleted the last task in the list, it moves to the previous task instead.");
  const planner = new MockLanguageModelV4({ doGenerate: [reply({ claims: previous }), reply({ claims: good().claims })] });
  const planned = await planScenario(bug, sorted.value, planner, signal, observer);
  const unclaimed = [1, 3, 4].map((i) => `- sentence ${i + 1} of the PR text, ${JSON.stringify(bugSentences[i])}, is neither quoted by a claim nor marked not testable; write a claim that quotes it`);
  assert.ok(promptOf(planner, 1).endsWith(`Your last answer was rejected:\n${unclaimed.join("\n")}`), promptOf(planner, 1));
  assert.ok(unclaimed[2].includes("Delete still removes only the task you clicked."));
  assert.deepEqual(planned, { ok: true, value: { claims: good().claims, notTestable: sorted.value } });
  assert.deepEqual(heard(), [spent(true), spent(false), spent(true)], "one observer hears the sort call and both plan calls");
});

test("planScenario retries once with the rule problems and accepts the second plan", async () => {
  const broken = good();
  broken.claims[0].quote = "Delete removes every task at once.";
  const problem = planProblems(broken, input.prText, "model")[0];
  const model = new MockLanguageModelV4({ doGenerate: [reply({ claims: broken.claims }), reply({ claims: good().claims })] });
  const { observer, heard } = listen();
  const result = await planScenario(input, good().notTestable, model, signal, observer);
  assert.deepEqual(result, { ok: true, value: good() });
  assert.deepEqual(heard(), [spent(false), spent(true)]);
  assert.ok(promptOf(model, 1).includes(`Your last answer was rejected:\n- ${problem}`), promptOf(model, 1));
});

test("planScenario rejects a claim on a sentence the sorter marked not testable", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [reply({ claims: good().claims }), reply({ claims: good().claims })] });
  const result = await planScenario(input, [{ quote: sentences[4], reason: "Motivation: why." }], model, signal, quiet);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((problem) => problem.includes("is quoted by a claim and also marked not testable")), JSON.stringify(result));
});

test("planScenario gives up after two bad answers, shows the schema problems on the retry, and counts both calls' tokens", async () => {
  const noWhen = { claims: [{ ...good().claims[0], checks: [{ ...good().claims[0].checks[0], when: [] }] }] };
  const broken = good();
  broken.claims[2].quote = "the task";
  const model = new MockLanguageModelV4({ doGenerate: [reply(noWhen), reply({ claims: broken.claims })] });
  const { observer, heard } = listen();
  const result = await planScenario(input, good().notTestable, model, signal, observer);
  assert.deepEqual(result, { ok: false, problems: planProblems(broken, input.prText, "model") });
  assert.deepEqual(heard(), [spent(false), spent(false)]);
  assert.ok(promptOf(model, 1).endsWith("Your last answer was rejected:\n- claims.0.checks.0.when: Too small: expected array to have >=1 items"), promptOf(model, 1));
});

test("planScenario stops at once when the caller cancels, without a retry", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      return reply({ claims: good().claims });
    },
  });
  const { observer, calls } = listen();
  await assert.rejects(planScenario(input, good().notTestable, model, controller.signal, observer), { name: "AbortError" });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.deepEqual(calls, [], "a call the run stopped is not a record");
});

test("repairChecks replaces only the failing checks and keeps every other part byte-identical", async () => {
  const scenario = good();
  const fixed = [
    { ...scenario.claims[1].checks[0], it: "It should focus Delete Buy milk once Walk dog is gone." },
    { ...scenario.claims[3].checks[0], it: "It should focus the list box once the only task is gone." },
  ];
  const failing = [
    { claimIndex: 1, checkIndex: 0, id: "c2.1", problem: "given: expect_count css \".task-title\" = 2: saw 1 visible match" },
    { claimIndex: 3, checkIndex: 0, id: "c4.1", problem: "when: nothing matched button \"Delete Buy milk\"" },
  ];
  const model = new MockLanguageModelV4({ doGenerate: [reply({ checks: fixed })] });
  const { observer, heard } = listen();
  const result = await repairChecks(input, model, scenario, failing, signal, observer);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(heard(), [spent(true)]);
  assert.deepEqual(result.value.claims[1].checks[0], fixed[0]);
  assert.deepEqual(result.value.claims[3].checks[0], fixed[1]);
  for (const i of [0, 2]) assert.equal(JSON.stringify(result.value.claims[i]), JSON.stringify(scenario.claims[i]));
  result.value.claims.forEach((claim, i) => {
    assert.equal(claim.quote, scenario.claims[i].quote);
    assert.equal(claim.it, scenario.claims[i].it);
  });
  const prompt = promptOf(model, 0);
  assert.ok(prompt.startsWith(renderPlannerInput(input, scenario.notTestable)));
  assert.ok(prompt.includes(JSON.stringify(scenario, null, 2)));
  assert.ok(prompt.includes(`- c2.1 (claim 2, check 1): ${failing[0].problem}\n- c4.1 (claim 4, check 1): ${failing[1].problem}`));
  assert.ok(prompt.includes("Return exactly 2 replacement checks, in the order listed."));
});

test("repairChecks rejects an answer with the wrong number of checks", async () => {
  const scenario = good();
  const failing = [
    { claimIndex: 1, checkIndex: 0, id: "c2.1", problem: "setup failed" },
    { claimIndex: 3, checkIndex: 0, id: "c4.1", problem: "setup failed" },
  ];
  const model = new MockLanguageModelV4({ doGenerate: [reply({ checks: [scenario.claims[1].checks[0]] })] });
  const { observer, calls, heard } = listen();
  const result = await repairChecks(input, model, scenario, failing, signal, observer);
  assert.deepEqual(result, { ok: false, problems: ["returned 1 checks, expected 2"] });
  assert.deepEqual(heard(), [spent(false)]);
  assert.deepEqual(calls[0].problems, ["returned 1 checks, expected 2"], "the record says why the call was rejected, not only that the schema passed");
});

test("renderPlannerInput holds the PR text, the sentences to claim, the ones not testable, the diff, the snapshot and each loaded file, in that order", () => {
  const text = renderPlannerInput(input, good().notTestable);
  const toClaim = `# Sentences you must claim\n${sentences.slice(1).map((sentence, i) => `${i + 2}. ${sentence}`).join("\n")}`;
  const marked = `# Sentences marked not testable\n1. ${sentences[0]}\n   Reason: ${HISTORY}`;
  const order = [input.prText, toClaim, marked, input.diff, input.ui.ariaSnapshot, "# /app.js\nrenderTasks();"].map((part) => text.indexOf(part));
  assert.ok(order.every((at) => at !== -1), `${order}\n${text}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(renderPlannerInput(input, []).includes("# Sentences marked not testable\nNone."));
});

test("systemPrompt is the named skill's body without its frontmatter", () => {
  const starts = { "prove-change": "You turn a pull request into browser checks", "sort-sentences": "You get the sentences of a pull request's description" };
  for (const [skill, start] of Object.entries(starts) as [keyof typeof starts, string][]) {
    const prompt = systemPrompt(skill);
    assert.ok(prompt.startsWith(start), prompt.slice(0, 80));
    assert.ok(!prompt.includes("description:"));
    assert.ok(!prompt.includes("---"));
  }
});
