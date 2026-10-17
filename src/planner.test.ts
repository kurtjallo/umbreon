import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { planScenario, renderPlannerInput, repairChecks, systemPrompt, type PlannerInput } from "./planner.ts";
import { ScenarioSchema, planProblems } from "./scenario.ts";

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
const signal = new AbortController().signal;

const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  },
  warnings: [],
});

function promptOf(model: MockLanguageModelV4, call: number): string {
  return model.doGenerateCalls[call].prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n");
}

test("planScenario returns a valid plan from one call, with the skill and the schema as instructions at temperature 0", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [reply(good())] });
  const result = await planScenario(input, model, signal);
  assert.deepEqual(result, { ok: true, scenario: good(), calls: 1, usage: { inputTokens: 100, outputTokens: 10 } });
  const call = model.doGenerateCalls[0];
  assert.equal(call.temperature, 0);
  const system = call.prompt[0];
  assert.equal(system.role, "system");
  assert.ok(system.role === "system" && system.content.startsWith(`${systemPrompt()}\n\nReply with only one JSON object`));
  assert.ok(system.role === "system" && system.content.includes('"claims"'));
  assert.deepEqual(call.responseFormat, { type: "json" }, "no schema for the server to enforce");
  assert.equal(promptOf(model, 0), renderPlannerInput(input));
});

test("planScenario retries once with the rule problems and accepts the second plan", async () => {
  const broken = good();
  broken.claims[0].quote = "Delete removes every task at once.";
  const problem = planProblems(broken, input.prText)[0];
  const model = new MockLanguageModelV4({ doGenerate: [reply(broken), reply(good())] });
  const result = await planScenario(input, model, signal);
  assert.deepEqual(result, { ok: true, scenario: good(), calls: 2, usage: { inputTokens: 200, outputTokens: 20 } });
  assert.ok(promptOf(model, 1).includes(`Your last answer was rejected:\n- ${problem}`), promptOf(model, 1));
});

test("planScenario gives up after two bad answers, shows the schema problems on the retry, and counts both calls' tokens", async () => {
  const noWhen = { claims: [{ ...good().claims[0], checks: [{ ...good().claims[0].checks[0], when: [] }] }] };
  const broken = good();
  broken.claims[2].quote = "the task";
  const model = new MockLanguageModelV4({ doGenerate: [reply(noWhen), reply(broken)] });
  const result = await planScenario(input, model, signal);
  assert.deepEqual(result, {
    ok: false, problems: planProblems(broken, input.prText), calls: 2, usage: { inputTokens: 200, outputTokens: 20 },
  });
  assert.ok(promptOf(model, 1).includes("- claims.0.checks.0.when: Too small"), promptOf(model, 1));
});

test("planScenario stops at once when the caller cancels, without a retry", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      return reply(good());
    },
  });
  await assert.rejects(planScenario(input, model, controller.signal), { name: "AbortError" });
  assert.equal(model.doGenerateCalls.length, 1);
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
  const result = await repairChecks(input, model, scenario, failing, signal);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 10 });
  assert.deepEqual(result.scenario.claims[1].checks[0], fixed[0]);
  assert.deepEqual(result.scenario.claims[3].checks[0], fixed[1]);
  for (const i of [0, 2]) assert.equal(JSON.stringify(result.scenario.claims[i]), JSON.stringify(scenario.claims[i]));
  result.scenario.claims.forEach((claim, i) => {
    assert.equal(claim.quote, scenario.claims[i].quote);
    assert.equal(claim.it, scenario.claims[i].it);
  });
  const prompt = promptOf(model, 0);
  assert.ok(prompt.startsWith(renderPlannerInput(input)));
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
  const result = await repairChecks(input, model, scenario, failing, signal);
  assert.deepEqual(result, { ok: false, problems: ["returned 1 checks, expected 2"], usage: { inputTokens: 100, outputTokens: 10 } });
});

test("renderPlannerInput holds the PR text, the diff, the snapshot and each loaded file, in that order", () => {
  const text = renderPlannerInput(input);
  const order = [input.prText, input.diff, input.ui.ariaSnapshot, "# /app.js\nrenderTasks();"].map((part) => text.indexOf(part));
  assert.ok(order.every((at) => at !== -1), String(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("systemPrompt is the skill body without its frontmatter", () => {
  const prompt = systemPrompt();
  assert.ok(prompt.startsWith("You turn a pull request into browser checks"), prompt.slice(0, 80));
  assert.ok(!prompt.includes("description:"));
  assert.ok(!prompt.includes("---"));
});
