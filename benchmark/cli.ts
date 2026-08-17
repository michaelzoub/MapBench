#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { createAuthoredEval } from "./author-eval.js";
import { materializeExampleRepository } from "./examples.js";
import { BENCHMARK_REPETITIONS, DEFAULT_BENCHMARK_MODEL, DEFAULT_BENCHMARK_REASONING_EFFORT, runBenchmark } from "./runner.js";
import { scaffoldEvalTask } from "./scaffold.js";
import { listTasks, resolveBundledTasksRoot } from "./task-loader.js";
import { CONDITIONS, DEFAULT_CONDITIONS, normalizeCondition, type BenchmarkOptions } from "./types.js";

const HELP = `project-outline benchmark

Usage:
  project-outline benchmark --repo <path>
  project-outline benchmark --repo <path> --task <id>
  project-outline benchmark ask
  project-outline benchmark init --repo <path> --task <id>
  project-outline benchmark --example payments-service --task <id>

Options:
  --repo <path>             Target Git repository (required; never modified)
  --example <name>          Bundled repository snapshot (use instead of --repo)
  --task <id>               Run an explicit task subset (repeatable)
  --tasks <path>            Task root (default: bundled top-level tasks/)
  --all                     Run every task (also the default when --task is omitted)
  --runs <n>                Must be 3; every task-condition cell has exactly 3 fresh runs
  --conditions <csv|preset> Conditions (default: targeted; presets: targeted, factorial)
  --model <model>           Fixed Codex model (default: gpt-5.6-terra)
                             Reasoning effort is fixed to low
  --pricing <mode>          Live pricing mode: openrouter or off (default: openrouter)
  --pricing-model <id>      OpenRouter author/slug when it differs from --model
  --timeout <seconds>       Codex timeout per run (default: 1800)
  --dry-run                 Validate and print the complete plan without invoking Codex
  --debug-usage             Save raw turn.completed usage events beside each result
  --keep-workspaces         Retain disposable clones
  --output <path>           Results parent (default: benchmark-results)
  --seed <value>            Explicit condition-order randomization seed
`;

const ASK_HELP = `project-outline benchmark ask

Interactively creates a repository-grounded private grader, validates positive and
negative controls, and optionally runs the five targeted comparisons.

Usage:
  project-outline benchmark ask
  project-outline benchmark ask --repo <path> --task <name> --question <text> --run

Options:
  --repo <path>             Repository to evaluate
  --task <name>             Task name or lowercase task id
  --question <text>         Repository-level question
  --title <title>           Report title (default: task name)
  --runs <n>                Paired repetitions (default: 3)
  --model <model>           Model for grader authoring and benchmark runs
  --pricing <mode>          openrouter or off (default: openrouter)
  --pricing-model <id>      OpenRouter author/slug override
  --timeout <seconds>       Timeout per benchmark run
  --output <path>           Results parent
  --tasks <path>            Task root (default: <cwd>/tasks)
  --run                     Start the benchmark without the final confirmation
  --no-run                  Create and validate the eval without running it
  --dry-run                 Create the eval, then print the five-condition plan
`;

const INIT_HELP = `project-outline benchmark init

Usage:
  project-outline benchmark init --repo <path> --task <id> [--title <title>] [--tasks <path>]

Creates a fail-closed custom eval under <cwd>/tasks by default.
Edit prompt.md and grader/expected.json before running the benchmark.
`;

function value(args: string[], index: number, flag: string): [string, number] {
  const inline = args[index].split("=", 2)[1];
  if (inline) return [inline, index];
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return [next, index + 1];
}

export function parseConditionSelection(input: string): BenchmarkOptions["conditions"] {
  if (input === "targeted" || input === "default") return [...DEFAULT_CONDITIONS];
  if (input === "factorial" || input === "all") return [...CONDITIONS];
  return [...new Set(input.split(",").map((condition) => normalizeCondition(condition)))];
}

function taskId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Task name must contain at least one letter or digit.");
  return id;
}

function cleanInteractivePath(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function askWorkflow(args: string[]): Promise<string[] | null> {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(ASK_HELP); return null; }
  if (args.includes("--run") && args.includes("--no-run")) throw new Error("Use either --run or --no-run, not both.");
  let repo = "";
  let name = "";
  let question = "";
  let title = "";
  let runs = String(BENCHMARK_REPETITIONS);
  let model = DEFAULT_BENCHMARK_MODEL;
  let pricing = "openrouter";
  let pricingModel = "";
  let timeout = "";
  let output = "";
  let tasksRoot = "";
  let runChoice: boolean | null = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].split("=", 1)[0];
    if (["--run", "--no-run", "--dry-run"].includes(flag)) {
      if (flag === "--run") runChoice = true;
      else if (flag === "--no-run") runChoice = false;
      else { dryRun = true; runChoice = true; }
      continue;
    }
    if (!["--repo", "--task", "--question", "--title", "--runs", "--model", "--pricing", "--pricing-model", "--timeout", "--output", "--tasks"].includes(flag)) {
      throw new Error(`Unknown benchmark ask option: ${args[index]}`);
    }
    const [input, consumed] = value(args, index, flag);
    index = consumed;
    if (flag === "--repo") repo = cleanInteractivePath(input);
    else if (flag === "--task") name = input;
    else if (flag === "--question") question = input;
    else if (flag === "--title") title = input;
    else if (flag === "--runs") runs = input;
    else if (flag === "--model") model = input;
    else if (flag === "--pricing") pricing = input;
    else if (flag === "--pricing-model") pricingModel = input;
    else if (flag === "--timeout") timeout = input;
    else if (flag === "--output") output = input;
    else tasksRoot = path.resolve(input);
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if ((!repo || !name || !question || runChoice === null) && !interactive) {
    throw new Error("Non-interactive benchmark ask requires --repo, --task, --question, and either --run, --no-run, or --dry-run.");
  }
  const readline = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (!repo) repo = cleanInteractivePath(await readline!.question(`Repository path [${process.cwd()}]: `)) || process.cwd();
    if (!name) name = (await readline!.question("Task name: ")).trim();
    if (!question) question = (await readline!.question("Question to evaluate: ")).trim();
    const id = taskId(name);
    process.stdout.write(`\nAuthoring a private grader for ${id} from the repository's current HEAD commit...\n`);
    const resolvedTasksRoot = tasksRoot || path.resolve("tasks");
    const created = await createAuthoredEval({ repo, tasksRoot: resolvedTasksRoot, id, question, title: title || name, model });
    process.stdout.write(`Created and validated: ${created.directory}\nGround truth: ${created.expected.requiredFiles.length} file(s), ${created.expected.requiredSymbols.length} symbol(s).\n`);
    if (runChoice === null) {
      const answer = (await readline!.question(`Run 4 conditions × ${runs} repetitions now? [y/N]: `)).trim().toLowerCase();
      runChoice = answer === "y" || answer === "yes";
    }
    if (!runChoice) {
      process.stdout.write(`Eval is ready. Run it later with:\n  project-outline benchmark --repo ${JSON.stringify(path.resolve(repo))} --tasks ${JSON.stringify(resolvedTasksRoot)} --task ${id} --conditions targeted --runs ${runs}\n`);
      return null;
    }
    const benchmarkArgs = ["--repo", path.resolve(repo), "--tasks", resolvedTasksRoot, "--task", id, "--conditions", "targeted", "--runs", runs, "--model", model, "--pricing", pricing];
    if (pricingModel) benchmarkArgs.push("--pricing-model", pricingModel);
    if (timeout) benchmarkArgs.push("--timeout", timeout);
    if (output) benchmarkArgs.push("--output", output);
    if (dryRun) benchmarkArgs.push("--dry-run");
    return benchmarkArgs;
  } finally {
    readline?.close();
  }
}

async function initTask(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(INIT_HELP); return; }
  let repo = "";
  let id = "";
  let title = "";
  let tasksRoot = "";
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].split("=", 1)[0];
    if (!["--repo", "--task", "--title", "--tasks"].includes(flag)) throw new Error(`Unknown option: ${args[index]}`);
    const [input, consumed] = value(args, index, flag);
    index = consumed;
    if (flag === "--repo") repo = path.resolve(input);
    else if (flag === "--task") id = input;
    else if (flag === "--title") title = input;
    else tasksRoot = path.resolve(input);
  }
  if (!repo) throw new Error("--repo is required.");
  if (!id) throw new Error("--task is required.");
  let repositoryStat;
  try { repositoryStat = await fs.stat(repo); }
  catch { throw new Error(`Repository does not exist: ${repo}`); }
  if (!repositoryStat.isDirectory()) throw new Error(`Repository is not a directory: ${repo}`);
  const resolvedTasksRoot = tasksRoot || path.resolve("tasks");
  const directory = await scaffoldEvalTask({ tasksRoot: resolvedTasksRoot, id, title });
  process.stdout.write(`Created custom eval: ${directory}\nEdit prompt.md and grader/expected.json, then run project-outline benchmark --repo ${JSON.stringify(repo)} --tasks ${JSON.stringify(resolvedTasksRoot)}.\n`);
}

export async function runBenchmarkCli(inputArgs = process.argv.slice(2)): Promise<void> {
  const args = [...inputArgs];
  if (args[0] === "ask") {
    const benchmarkArgs = await askWorkflow(args.slice(1));
    if (benchmarkArgs) await runBenchmarkCli(benchmarkArgs);
    return;
  }
  if (args[0] === "init") { await initTask(args.slice(1)); return; }
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(HELP); return; }
  const bundledTasksRoot = resolveBundledTasksRoot(import.meta.dirname);
  const options: BenchmarkOptions = {
    repo: "", taskIds: [], runs: BENCHMARK_REPETITIONS, conditions: [...DEFAULT_CONDITIONS], model: DEFAULT_BENCHMARK_MODEL, timeoutMs: 1_800_000,
    dryRun: false, keepWorkspaces: false, outputRoot: path.resolve("benchmark-results"), tasksRoot: bundledTasksRoot,
    pricingMode: "openrouter", debugUsage: false,
  };
  let all = false;
  let example = "";
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].split("=", 1)[0];
    if (["--dry-run", "--debug-usage", "--keep-workspaces", "--all"].includes(flag)) {
      if (flag === "--dry-run") options.dryRun = true;
      else if (flag === "--debug-usage") options.debugUsage = true;
      else if (flag === "--keep-workspaces") options.keepWorkspaces = true;
      else all = true;
      continue;
    }
    if (!["--repo", "--example", "--task", "--tasks", "--runs", "--conditions", "--model", "--pricing", "--pricing-model", "--timeout", "--output", "--seed"].includes(flag)) {
      throw new Error(`Unknown option: ${args[index]}`);
    }
    const [input, consumed] = value(args, index, flag);
    index = consumed;
    if (flag === "--repo") options.repo = path.resolve(input);
    else if (flag === "--example") example = input;
    else if (flag === "--task") options.taskIds.push(input);
    else if (flag === "--tasks") options.tasksRoot = path.resolve(input);
    else if (flag === "--runs") options.runs = Number(input);
    else if (flag === "--conditions") {
      options.conditions = parseConditionSelection(input);
    } else if (flag === "--model") options.model = input;
    else if (flag === "--pricing") {
      if (input !== "openrouter" && input !== "off") throw new Error("--pricing must be openrouter or off.");
      options.pricingMode = input;
    } else if (flag === "--pricing-model") options.pricingModel = input;
    else if (flag === "--timeout") options.timeoutMs = Number(input) * 1000;
    else if (flag === "--output") options.outputRoot = path.resolve(input);
    else if (flag === "--seed") options.seed = input;
  }
  if (options.repo && example) throw new Error("Use either --repo or --example, not both.");
  if (!options.repo && !example) throw new Error("--repo or --example is required.");
  if (options.runs !== BENCHMARK_REPETITIONS) throw new Error(`--runs must be exactly ${BENCHMARK_REPETITIONS}.`);
  const missingConditions = DEFAULT_CONDITIONS.filter((condition) => !options.conditions.includes(condition));
  if (missingConditions.length) process.stderr.write(`benchmark: warning: incomplete targeted comparison; missing conditions: ${missingConditions.join(", ")}\n`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout must be positive.");
  if (all && options.taskIds.length) throw new Error("Use either --all or --task, not both.");
  if (!all && !options.taskIds.length && example && options.tasksRoot === bundledTasksRoot) {
    options.taskIds = ["explain-system-architecture", "issue-to-symbol-localization", "reconstruct-payment-execution-path"];
  } else if (all || !options.taskIds.length) options.taskIds = await listTasks(options.tasksRoot);
  if (!options.taskIds.length) throw new Error("No benchmark tasks were found.");
  options.taskIds = [...new Set(options.taskIds)];
  let cleanupRoot = "";
  if (example) {
    const materialized = await materializeExampleRepository(example);
    options.repo = materialized.repo;
    cleanupRoot = materialized.cleanupRoot;
  }
  let result;
  try {
    result = await runBenchmark(options);
  } finally {
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      targetRepository: options.repo,
      tasks: options.taskIds,
      conditions: options.conditions,
      runs: options.runs,
      model: options.model,
      reasoningEffort: DEFAULT_BENCHMARK_REASONING_EFFORT,
      pricing: result.pricing,
      timeoutMs: options.timeoutMs,
      plannedResultsDirectory: result.resultsRoot,
      executionOrder: result.plan,
    }, null, 2)}\n`);
  } else process.stdout.write(`Benchmark complete: ${result.resultsRoot}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) runBenchmarkCli().catch((error: unknown) => {
  process.stderr.write(`benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
