import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SetupError } from "../src/app.ts";
import { tokens } from "../src/report.ts";
import { checksOf } from "../src/scenario.ts";
import type { RunRecord, Verdict } from "../src/verdict.ts";
import { plannerModel, verify, type PlanChoice } from "../src/verify.ts";

const USAGE = "usage: node scripts/repeat.ts [--times N=5] [--scenario file] [--parallel P=1] [cases...]";
const DEFAULT_CASES = ["delete-correct", "delete-bug"].map((name) => fileURLToPath(new URL(`../practice/demo-todo/prs/${name}`, import.meta.url)));

type Expected = "PROVEN" | "NOT PROVEN";
type Kind = "right" | "right for the wrong reason" | "WRONG PASS" | "wrong fail";
type Job = { caseDir: string; name: string; expected: Expected; round: number };
type Done = Job & { record: RunRecord; kind: Kind; seconds: number };

function kindOf(expected: Expected, verdict: Verdict): Kind {
  if (verdict.kind === "PROVEN") return expected === "PROVEN" ? "right" : "WRONG PASS";
  if (expected === "PROVEN") return "wrong fail";
  return verdict.checks.some((outcome) => outcome.result === "failed") ? "right" : "right for the wrong reason";
}

// The only code in Umbreon that reads expected.json, so the answer key never reaches verify().
async function expectedOf(caseDir: string): Promise<Expected> {
  const { verdict } = JSON.parse(await readFile(resolve(caseDir, "expected.json"), "utf8")) as { verdict: unknown };
  if (verdict !== "PROVEN" && verdict !== "NOT PROVEN") throw new SetupError(`${caseDir}/expected.json has no verdict PROVEN or NOT PROVEN`);
  return verdict;
}

function planText(record: RunRecord): string {
  const source = record.scenario?.source;
  if (!source) return "no plan";
  if (source.kind === "file") return "plan from file";
  return `plan ${source.calls} call${source.calls === 1 ? "" : "s"}, ${tokens(source.usage.inputTokens)} in / ${tokens(source.usage.outputTokens)} out`;
}

function line(done: Done): string {
  const count = (result: string) => done.record.verdict.checks.filter((outcome) => outcome.result === result).length;
  return [
    done.name.padEnd(16), `round ${done.round}`, done.record.verdict.kind.padEnd(10), `expected ${done.expected}`.padEnd(19),
    done.kind.padEnd(26), `${count("failed")} failed, ${count("could_not_run")} could not run`, planText(done.record), `${done.seconds.toFixed(1)} s`,
  ].join("  ");
}

/** Per claim: in how many runs at least one of its checks failed, so a claim that never catches anything shows. */
function claimTally(done: readonly Done[]): string[] {
  const tally = new Map<string, { runs: number; caught: number }>();
  for (const { record } of done) {
    const scenario = record.scenario;
    if (!scenario) continue;
    const quoteOf = new Map(checksOf(scenario).map((check) => [check.id, scenario.claims[check.claimIndex].quote]));
    const caught = new Set(record.verdict.checks.filter((outcome) => outcome.result === "failed").map((outcome) => quoteOf.get(outcome.checkId)));
    for (const quote of new Set(scenario.claims.map((claim) => claim.quote))) {
      const entry = tally.get(quote) ?? { runs: 0, caught: 0 };
      tally.set(quote, { runs: entry.runs + 1, caught: entry.caught + (caught.has(quote) ? 1 : 0) });
    }
  }
  const noPlan = done.filter(({ record }) => !record.scenario).length;
  return [
    ...[...tally].map(([quote, { runs, caught }]) => `   ${JSON.stringify(quote)}: a check failed in ${caught} of ${runs} runs`),
    ...(noPlan ? [`   ${noPlan} runs had no plan`] : []),
  ];
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: { times: { type: "string", default: "5" }, scenario: { type: "string" }, parallel: { type: "string", default: "1" } },
      allowPositionals: true,
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const times = Number(parsed.values.times);
  const parallel = Number(parsed.values.parallel);
  if (!Number.isInteger(times) || times < 1 || !Number.isInteger(parallel) || parallel < 1) {
    console.error(USAGE);
    return 2;
  }
  const caseDirs = parsed.positionals.length ? parsed.positionals.map((dir) => resolve(dir)) : DEFAULT_CASES;
  const plan: PlanChoice = parsed.values.scenario ? { kind: "file", path: parsed.values.scenario } : { kind: "model", model: await plannerModel() };
  const cases = await Promise.all(caseDirs.map(async (caseDir) => ({ caseDir, name: basename(caseDir), expected: await expectedOf(caseDir) })));

  const queue: Job[] = [];
  for (let round = 1; round <= times; round++) queue.push(...cases.map((c) => ({ ...c, round })));
  const done: Done[] = [];
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const started = Date.now();
      const record = await verify(job.caseDir, { plan });
      const finished: Done = { ...job, record, kind: kindOf(job.expected, record.verdict), seconds: (Date.now() - started) / 1000 };
      done.push(finished);
      console.log(line(finished));
    }
  }));

  const kinds: Kind[] = ["right", "right for the wrong reason", "WRONG PASS", "wrong fail"];
  console.log(`\n${done.length} runs: ${kinds.map((kind) => `${done.filter((d) => d.kind === kind).length} ${kind}`).join(", ")}`);
  for (const c of cases.filter((c) => c.expected === "NOT PROVEN")) {
    console.log([`${c.name}, per claim:`, ...claimTally(done.filter((d) => d.caseDir === c.caseDir))].join("\n"));
  }
  return done.every((d) => d.kind === "right") ? 0 : 1;
}

// The default exit on these signals skips the "exit" event, where Playwright kills its browsers.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(130));
try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof SetupError ? `repeat: ${error.message}` : error);
  process.exitCode = 2;
}
