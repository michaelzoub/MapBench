import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { estimateCost, parseCodexEvents } from "./events.js";
import { analyzeNavigation } from "./navigation.js";
import { runCheck, runHiddenGrader, unavailableCheck } from "./grader.js";
import { generateReport } from "./report.js";
import { runProcess } from "./process.js";
import { buildSummary } from "./summary.js";
import { loadTask } from "./tasks.js";
import { disabledPricing, fetchOpenRouterPricing } from "./pricing.js";
import type { BenchmarkOptions, GraderResult, LoadedTask, PricingResolution, RunResult } from "./types.js";
import { CONDITION_FACTORS, CONDITION_LABELS } from "./types.js";
import { seededShuffle, slugTimestamp, writeJson } from "./util.js";
import {
  assertGraderOutsideWorkspace,
  captureChanges,
  commitBaseline,
  COMPONENTS,
  createWorkspace,
  prepareCondition,
  removePrivateTaskFromWorkspace,
  resolveCommit,
  resolveTreeHash,
} from "./workspace.js";

const FIXED_PROMPT_SUFFIX = `\n\nWork only in this repository. Complete the requested task and inspect the code as needed. Do not read files outside the repository. Do not modify files unless the task explicitly requests changes. Do not commit changes. Return only the requested answer format.`;
export const DEFAULT_BENCHMARK_MODEL = "gpt-5.6-terra";
export const DEFAULT_BENCHMARK_REASONING_EFFORT = "low";
export const BENCHMARK_REPETITIONS = 3;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createIsolatedCodexHome(parent: string, label: string): Promise<{ directory: string; initialFiles: string[] }> {
  const directory = path.join(parent, `${label}-codex-home`);
  await fs.mkdir(directory, { recursive: false });
  const sourceHome = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  const sourceAuth = path.join(sourceHome, "auth.json");
  const destinationAuth = path.join(directory, "auth.json");
  try {
    await fs.copyFile(sourceAuth, destinationAuth);
    await fs.chmod(destinationAuth, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { directory, initialFiles: (await fs.readdir(directory)).sort() };
}

export function codexCommand(workspace: string, model: string, finalMessage: string): string[] {
  return [
    "codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--color", "never", "--model", model, "--sandbox", "workspace-write", "--cd", workspace,
    "--config", `model_reasoning_effort="${DEFAULT_BENCHMARK_REASONING_EFFORT}"`,
    "--config", 'approval_policy="never"', "--output-last-message", finalMessage, "-",
  ];
}

async function executeRun(
  options: BenchmarkOptions,
  resultsRoot: string,
  commit: string,
  task: LoadedTask,
  condition: BenchmarkOptions["conditions"][number],
  run: number,
  pairId: string,
  workspaceParent: string,
  pricing: PricingResolution,
): Promise<RunResult> {
  const artifactDirectory = path.join(resultsRoot, condition, task.id, `run-${String(run).padStart(3, "0")}`);
  await fs.mkdir(artifactDirectory, { recursive: true });
  const workspace = await createWorkspace(options.repo, commit, `${task.id}-${run}-${condition}`, workspaceParent);
  const codexHome = await createIsolatedCodexHome(workspaceParent, `${task.id}-${run}-${condition}`);
  await removePrivateTaskFromWorkspace(workspace, options.repo, options.tasksRoot);
  await assertGraderOutsideWorkspace(workspace, task.graderDirectory);
  let baselineCommit = commit;
  let baselineTreeHash = "";
  let events = "";
  let finalResponse = "";
  let patch = "";
  let filesChanged: string[] = [];
  let error: string | undefined;
  let invocation = { exitCode: null as number | null, durationMs: 0, timedOut: false, stderr: "" };
  let grader: GraderResult = { ...unavailableCheck(), score: 0, maxScore: 1, passed: false, details: null };
  let checks = { regression: unavailableCheck(), typecheck: unavailableCheck(), build: unavailableCheck() };
  try {
    await prepareCondition(workspace, condition);
    baselineCommit = await commitBaseline(workspace);
    baselineTreeHash = await resolveTreeHash(workspace, baselineCommit);
    const finalMessageFile = path.join(artifactDirectory, "final-message.md");
    const command = codexCommand(workspace, options.model, finalMessageFile);
    const result = await runProcess(command, {
      cwd: workspace,
      timeoutMs: options.timeoutMs,
      stdin: `${task.prompt}${FIXED_PROMPT_SUFFIX}\n`,
      env: { CODEX_HOME: codexHome.directory },
      unsetEnv: ["CODEX_THREAD_ID"],
    });
    invocation = { exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, stderr: result.stderr || result.error || "" };
    events = result.stdout;
    const eventsFile = path.join(artifactDirectory, "events.jsonl");
    await fs.writeFile(eventsFile, events, "utf8");
    try { finalResponse = await fs.readFile(finalMessageFile, "utf8"); } catch { finalResponse = ""; }
    const changes = await captureChanges(workspace, baselineCommit);
    patch = changes.patch;
    filesChanged = changes.files;
    grader = await runHiddenGrader(task, workspace, finalMessageFile, eventsFile);
    checks = {
      regression: await runCheck(task.checks?.regression, workspace, task.graderDirectory),
      typecheck: await runCheck(task.checks?.typecheck, workspace, task.graderDirectory),
      build: await runCheck(task.checks?.build, workspace, task.graderDirectory),
    };
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  }
  const parsed = parseCodexEvents(events);
  const usageEventFile = options.debugUsage ? "usage-events.json" : null;
  parsed.tokens.provenance.rawEventFile = usageEventFile;
  const result: RunResult = {
    schemaVersion: 2,
    pairId,
    taskId: task.id,
    condition,
    run,
    targetCommit: commit,
    baselineCommit,
    baselineTreeHash,
    promptSha256: sha256(`${task.prompt}${FIXED_PROMPT_SUFFIX}\n`),
    model: options.model,
    status: invocation.timedOut ? "timeout" : invocation.exitCode === 0 && !error ? "completed" : "failed",
    exitCode: invocation.exitCode,
    durationMs: invocation.durationMs,
    tokens: parsed.tokens,
    estimatedCostUsd: estimateCost(parsed.tokens, pricing.pricing ?? undefined),
    commands: parsed.commands,
    commandCount: parsed.commands.length,
    failedCommandCount: parsed.commands.filter((command) => command.failed).length,
    navigation: analyzeNavigation(parsed.commands),
    finalResponse,
    filesChanged,
    fileCount: filesChanged.length,
    hiddenGrader: grader,
    checks,
    artifactDirectory: path.relative(resultsRoot, artifactDirectory).split(path.sep).join("/"),
    workspaceKept: options.keepWorkspaces,
    isolation: {
      freshProcess: true,
      resumedSession: false,
      ephemeralSession: true,
      freshWorkspace: true,
      codexHome: "fresh-auth-only",
      initialCodexHomeFiles: codexHome.initialFiles,
      codexHomeRemoved: true,
    },
    ...(options.keepWorkspaces ? { workspace } : {}),
    ...(error ? { error } : {}),
  };
  await Promise.all([
    fs.writeFile(path.join(artifactDirectory, "events.jsonl"), events, "utf8"),
    fs.writeFile(path.join(artifactDirectory, "stderr.log"), invocation.stderr, "utf8"),
    fs.writeFile(path.join(artifactDirectory, "final-message.md"), finalResponse, "utf8"),
    fs.writeFile(path.join(artifactDirectory, "changes.patch"), patch, "utf8"),
    writeJson(path.join(artifactDirectory, "grader.json"), grader),
    writeJson(path.join(artifactDirectory, "result.json"), result),
    ...(options.debugUsage ? [writeJson(path.join(artifactDirectory, "usage-events.json"), parsed.usageEvents)] : []),
  ]);
  if (!options.keepWorkspaces) await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(codexHome.directory, { recursive: true, force: true });
  return result;
}

export interface PlanItem {
  pairId: string;
  taskId: string;
  taskPrompt: string;
  condition: string;
  run: number;
  workspace: string;
  codexCommand: string[];
  graderCommand: string[];
}

async function validateNegativeControl(
  options: BenchmarkOptions,
  commit: string,
  task: LoadedTask,
  workspaceParent: string,
): Promise<GraderResult> {
  const workspace = await createWorkspace(options.repo, commit, `preflight-${task.id}`, workspaceParent);
  const answer = path.join(workspaceParent, `preflight-${task.id}-answer.md`);
  const events = path.join(workspaceParent, `preflight-${task.id}-events.jsonl`);
  try {
    await removePrivateTaskFromWorkspace(workspace, options.repo, options.tasksRoot);
    await assertGraderOutsideWorkspace(workspace, task.graderDirectory);
    await Promise.all([fs.writeFile(answer, "", "utf8"), fs.writeFile(events, "", "utf8")]);
    const result = await runHiddenGrader(task, workspace, answer, events);
    const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : null;
    if (!details || typeof details.score !== "number" || typeof details.maxScore !== "number" || typeof details.passed !== "boolean") {
      throw new Error(`Task ${task.id} grader did not emit a JSON result for the empty-answer negative control.`);
    }
    if (typeof details.configurationError === "string") {
      throw new Error(`Task ${task.id} grader configuration error: ${details.configurationError}`);
    }
    if (result.passed || details.passed !== false) {
      throw new Error(`Task ${task.id} grader accepted an empty answer. Fix the grader before spending tokens.`);
    }
    return result;
  } finally {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(answer, { force: true }),
      fs.rm(events, { force: true }),
    ]);
  }
}

export async function runBenchmark(options: BenchmarkOptions): Promise<{ resultsRoot: string; plan: PlanItem[]; runs: RunResult[]; pricing: PricingResolution }> {
  if (options.runs !== BENCHMARK_REPETITIONS) {
    throw new Error(`Benchmark repetitions are fixed at ${BENCHMARK_REPETITIONS}; received ${options.runs}.`);
  }
  const repo = path.resolve(options.repo);
  const outputRoot = path.resolve(options.outputRoot);
  const pricing = options.pricingMode === "off"
    ? disabledPricing(options.model)
    : await fetchOpenRouterPricing(options.model, options.pricingModel);
  const commit = await resolveCommit(repo);
  const tasks = await Promise.all(options.taskIds.map((id) => loadTask(options.tasksRoot, id)));
  const timestamp = slugTimestamp();
  const resultsRoot = path.join(outputRoot, timestamp);
  const workspaceParent = path.join(os.tmpdir(), `project-outline-benchmark-${timestamp}`);
  const seed = options.seed ?? `${commit}:${options.taskIds.join(",")}:${options.runs}`;
  const ordered: Array<{ task: LoadedTask; condition: BenchmarkOptions["conditions"][number]; run: number; pairId: string }> = [];
  for (const task of tasks) for (let run = 1; run <= options.runs; run += 1) {
    const pairId = `${task.id}:run-${String(run).padStart(3, "0")}`;
    for (const condition of seededShuffle(options.conditions, `${seed}:${pairId}`)) ordered.push({ task, condition, run, pairId });
  }
  const plan: PlanItem[] = ordered.map(({ task, condition, run, pairId }) => {
    const workspace = path.join(workspaceParent, `${task.id}-${run}-${condition}`);
    const artifact = path.join(resultsRoot, condition, task.id, `run-${String(run).padStart(3, "0")}`);
    return {
      pairId, taskId: task.id, taskPrompt: task.prompt, condition, run, workspace,
      codexCommand: codexCommand(workspace, options.model, path.join(artifact, "final-message.md")),
      graderCommand: task.grader.command.map((part) => part
        .replaceAll("{workspace}", workspace)
        .replaceAll("{grader}", task.graderDirectory)
        .replaceAll("{answer}", path.join(artifact, "final-message.md"))
        .replaceAll("{events}", path.join(artifact, "events.jsonl"))),
    };
  });
  if (options.dryRun) return { resultsRoot, plan, runs: [], pricing };
  await fs.mkdir(resultsRoot, { recursive: true });
  await fs.mkdir(workspaceParent, { recursive: true });
  const graderPreflight: Record<string, GraderResult> = {};
  for (const task of tasks) graderPreflight[task.id] = await validateNegativeControl(options, commit, task, workspaceParent);
  await writeJson(path.join(resultsRoot, "config.json"), {
    schemaVersion: 2, createdAt: new Date().toISOString(), repo, targetCommit: commit,
    tasksRoot: path.resolve(options.tasksRoot),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      grader: task.grader,
      checks: task.checks ?? {},
    })),
    conditions: options.conditions,
    conditionFactors: Object.fromEntries(options.conditions.map((condition) => [condition, CONDITION_FACTORS[condition]])),
    conditionLabels: Object.fromEntries(options.conditions.map((condition) => [condition, CONDITION_LABELS[condition]])),
    conditionComponents: Object.fromEntries(options.conditions.map((condition) => [condition, COMPONENTS[condition]])),
    runs: options.runs, aggregation: "arithmetic-mean", model: options.model, reasoningEffort: DEFAULT_BENCHMARK_REASONING_EFFORT,
    timeoutMs: options.timeoutMs, seed, executionOrder: plan.map(({ pairId, condition }) => ({ pairId, condition })),
    graderPreflight,
    workspaceRoot: options.keepWorkspaces ? workspaceParent : null,
    pricing,
    codex: {
      jsonl: true,
      ephemeral: true,
      ignoreUserConfig: true,
      ignoreRules: true,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      promptSuffix: FIXED_PROMPT_SUFFIX.trim(),
      debugUsage: options.debugUsage,
      isolation: {
        process: "new codex exec process per run; resume is never used",
        session: "--ephemeral",
        workspace: "fresh detached clone at targetCommit with a verified condition tree hash",
        codexHome: "fresh directory containing only auth.json when file-based authentication is used",
        inheritedThreadId: false,
      },
    },
  });
  const runs: RunResult[] = [];
  const startingTrees = new Map<string, string>();
  const promptHashes = new Map<string, string>();
  for (const item of ordered) {
    process.stdout.write(`[${runs.length + 1}/${ordered.length}] ${item.pairId} ${item.condition}\n`);
    const result = await executeRun(options, resultsRoot, commit, item.task, item.condition, item.run, item.pairId, workspaceParent, pricing);
    const cell = `${result.taskId}:${result.condition}`;
    const priorTree = startingTrees.get(cell);
    if (priorTree && priorTree !== result.baselineTreeHash) {
      throw new Error(`Starting workspace drift for ${cell}: ${priorTree} != ${result.baselineTreeHash}`);
    }
    startingTrees.set(cell, result.baselineTreeHash);
    const priorPrompt = promptHashes.get(result.taskId);
    if (priorPrompt && priorPrompt !== result.promptSha256) {
      throw new Error(`Prompt drift for ${result.taskId}: ${priorPrompt} != ${result.promptSha256}`);
    }
    promptHashes.set(result.taskId, result.promptSha256);
    runs.push(result);
  }
  const summary = buildSummary(runs);
  await writeJson(path.join(resultsRoot, "summary.json"), summary);
  await generateReport(resultsRoot, summary);
  if (!options.keepWorkspaces) await fs.rm(workspaceParent, { recursive: true, force: true });
  return { resultsRoot, plan, runs, pricing };
}
