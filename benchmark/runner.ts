import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { estimateCost, parsePiEvents } from "./events.js";
import { loadDeepSweTasks } from "./deepswe.js";
import { DEEPSWE_SOURCE } from "./deepswe-manifest.js";
import { analyzeNavigation } from "./navigation.js";
import { runCheck, runHiddenGrader, unavailableCheck } from "./grader.js";
import { generateReport } from "./report.js";
import { runProcess } from "./process.js";
import { buildSummary } from "./summary.js";
import { expandCommand, loadTask } from "./task-loader.js";
import { disabledPricing, fetchOpenRouterPricing } from "./pricing.js";
import type { BenchmarkOptions, GraderResult, LoadedTask, PricingResolution, RunResult } from "./types.js";
import { CONDITION_FACTORS, CONDITION_LABELS } from "./types.js";
import { seededShuffle, slugTimestamp, writeJson } from "./util.js";
import {
  assertGraderOutsideWorkspace,
  captureChanges,
  commitBaseline,
  COMPONENTS,
  createDockerImageWorkspace,
  createWorkspace,
  conditionInstructions,
  prepareCondition,
  removeDockerWorkspace,
  removePrivateTaskFromWorkspace,
  resolveCommit,
  resolveTreeHash,
  startDockerWorkspace,
} from "./workspace.js";

const ANSWER_PROMPT_SUFFIX = `\n\nWork only in this repository. Complete the requested task and inspect the real source as needed. This benchmark is read-only. Return only the requested answer format.`;
const CODE_PROMPT_SUFFIX = `\n\nWork only in this repository. Implement the requested change in the source tree. Use the available tools to inspect, edit, and verify the code. Do not only describe the solution.`;
export const DEFAULT_BENCHMARK_PROVIDER = "openai-codex";
export const DEFAULT_BENCHMARK_MODEL = "gpt-5.6-terra";
export const DEFAULT_BENCHMARK_THINKING = "low";
export const BENCHMARK_REPETITIONS = 3;
export type PiWorkspaceMode = "read-only" | "isolated-read-write";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createIsolatedPiHome(parent: string, label: string): Promise<{ directory: string; initialFiles: string[] }> {
  const directory = path.join(parent, `${label}-pi-home`);
  await fs.mkdir(directory, { recursive: false });
  const sourceHome = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
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

export function piToolsExtension(): string {
  const source = path.join(import.meta.dirname, "pi-tools.ts");
  const compiled = path.join(import.meta.dirname, "pi-tools.js");
  return process.argv[1]?.includes(`${path.sep}dist${path.sep}`) ? compiled : source;
}

export function piCommand(provider: string, model: string, condition: BenchmarkOptions["conditions"][number], prompt: string, workspaceMode: PiWorkspaceMode = "read-only"): string[] {
  const baseTools = workspaceMode === "isolated-read-write" ? "read,grep,find,ls,edit,write,bash" : "read,grep,find,ls";
  const tools = COMPONENTS[condition].callgraph ? `${baseTools},mapbench_query` : baseTools;
  return [
    process.env.MAPBENCH_PI ?? "pi", "--mode", "json", "--no-session", "--offline",
    "--no-extensions", "--extension", piToolsExtension(), "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-approve", "--no-builtin-tools", "--tools", tools,
    "--provider", provider, "--model", model, "--thinking", DEFAULT_BENCHMARK_THINKING,
    "--append-system-prompt", conditionInstructions(condition), prompt,
  ];
}

export function isolatedPiEnvironment(piHome: string, queryHelper: string | null, dockerContainer?: string): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const env = Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (/_API_KEY$|_AUTH_TOKEN$|_OAUTH_TOKEN$/.test(name) || name.startsWith("AWS_"))) env[name] = value;
  }
  return {
    ...env,
    PI_CODING_AGENT_DIR: piHome,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    ...(queryHelper ? { MAPBENCH_QUERY_HELPER: queryHelper } : {}),
    ...(dockerContainer ? {
      MAPBENCH_DOCKER_CONTAINER: dockerContainer,
      ...(process.env.MAPBENCH_DOCKER ? { MAPBENCH_DOCKER: process.env.MAPBENCH_DOCKER } : {}),
    } : {}),
  };
}
function promptForTask(task: LoadedTask): string {
  const suffix = task.execution.kind === "repository-edit" ? CODE_PROMPT_SUFFIX : ANSWER_PROMPT_SUFFIX;
  return `${task.prompt}${suffix}\n`;
}

function targetCommitForTask(task: LoadedTask, defaultCommit: string): string {
  return task.execution.kind === "repository-edit" ? task.execution.baseCommit : defaultCommit;
}

function targetRepositoryForTask(task: LoadedTask, options: BenchmarkOptions): string {
  return task.execution.kind === "repository-edit" ? task.execution.repositoryUrl : path.resolve(options.repo);
}

async function createTaskWorkspace(
  options: BenchmarkOptions,
  task: LoadedTask,
  commit: string,
  label: string,
  parent: string,
): Promise<string> {
  if (task.execution.kind === "repository-edit") {
    return await createDockerImageWorkspace(task.execution.environment.dockerImage, commit, label, parent);
  }
  return await createWorkspace(options.repo, commit, label, parent);
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
  const workspace = await createTaskWorkspace(options, task, commit, `${task.id}-${run}-${condition}`, workspaceParent);
  const piHome = await createIsolatedPiHome(workspaceParent, `${task.id}-${run}-${condition}`);
  if (task.execution.kind === "answer") await removePrivateTaskFromWorkspace(workspace, options.repo, options.tasksRoot);
  await assertGraderOutsideWorkspace(workspace, task.graderDirectory);
  let baselineCommit = commit;
  let baselineTreeHash = "";
  let events = "";
  let finalResponse = "";
  let patch = "";
  let filesChanged: string[] = [];
  let error: string | undefined;
  let invocation = { exitCode: null as number | null, durationMs: 0, stdoutLineElapsedMs: [] as number[], timedOut: false, stderr: "" };
  let grader: GraderResult = { ...unavailableCheck(), score: 0, maxScore: 1, passed: false, details: null };
  let checks = { regression: unavailableCheck(), typecheck: unavailableCheck(), build: unavailableCheck() };
  let dockerContainer: string | undefined;
  try {
    const treatment = await prepareCondition(workspace, condition, path.join(workspaceParent, "private-treatments", `${task.id}-${run}-${condition}`));
    baselineCommit = await commitBaseline(workspace);
    baselineTreeHash = await resolveTreeHash(workspace, baselineCommit);
    const finalMessageFile = path.join(artifactDirectory, "final-message.md");
    const prompt = promptForTask(task);
    const execution = task.execution;
    const workspaceMode: PiWorkspaceMode = execution.kind === "repository-edit" ? "isolated-read-write" : "read-only";
    if (execution.kind === "repository-edit") {
      dockerContainer = await startDockerWorkspace(
        execution.environment.dockerImage,
        workspace,
        execution.environment,
      );
    }
    const command = piCommand(options.provider, options.model, condition, prompt, workspaceMode);
    const invocationTimeoutMs = execution.kind === "repository-edit"
      ? Math.min(options.timeoutMs, execution.environment.timeoutMs)
      : options.timeoutMs;
    const result = await runProcess(command, {
      cwd: workspace,
      timeoutMs: invocationTimeoutMs,
      env: isolatedPiEnvironment(piHome.directory, treatment.callgraphHelper, dockerContainer),
      replaceEnv: true,
    });
    invocation = { exitCode: result.exitCode, durationMs: result.durationMs, stdoutLineElapsedMs: result.stdoutLineElapsedMs,
      timedOut: result.timedOut, stderr: result.stderr || result.error || "" };
    events = result.stdout;
    const eventsFile = path.join(artifactDirectory, "events.jsonl");
    await fs.writeFile(eventsFile, events, "utf8");
    const parsedOutput = parsePiEvents(events, result.stdoutLineElapsedMs);
    finalResponse = parsedOutput.finalResponse;
    await fs.writeFile(finalMessageFile, finalResponse, "utf8");
    const changes = await captureChanges(workspace, baselineCommit);
    patch = changes.patch;
    filesChanged = changes.files;
    await fs.writeFile(path.join(artifactDirectory, "changes.patch"), patch, "utf8");
    if (dockerContainer) {
      await removeDockerWorkspace(dockerContainer);
      dockerContainer = undefined;
    }
    grader = await runHiddenGrader(task, workspace, finalMessageFile, eventsFile, artifactDirectory);
    checks = {
      regression: await runCheck(task.checks?.regression, workspace, task.graderDirectory),
      typecheck: await runCheck(task.checks?.typecheck, workspace, task.graderDirectory),
      build: await runCheck(task.checks?.build, workspace, task.graderDirectory),
    };
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  }
  if (dockerContainer) await removeDockerWorkspace(dockerContainer);
  const parsed = parsePiEvents(events, invocation.stdoutLineElapsedMs);
  const usageEventFile = options.debugUsage ? "usage-events.json" : null;
  parsed.tokens.provenance.rawEventFile = usageEventFile;
  const result: RunResult = {
    schemaVersion: 3,
    pairId,
    taskId: task.id,
    condition,
    run,
    targetCommit: commit,
    baselineCommit,
    baselineTreeHash,
    promptSha256: sha256(promptForTask(task)),
    provider: options.provider,
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
    editNavigation: { ...parsed.editNavigation, censoredAtMs: invocation.durationMs },
    finalResponse,
    filesChanged,
    fileCount: filesChanged.length,
    hiddenGrader: grader,
    checks,
    artifactDirectory: path.relative(resultsRoot, artifactDirectory).split(path.sep).join("/"),
    workspaceKept: options.keepWorkspaces,
    isolation: {
      harness: "pi",
      freshProcess: true,
      resumedSession: false,
      ephemeralSession: true,
      freshWorkspace: true,
      originalGitObjectsRemoved: true,
      piHome: "fresh-auth-only",
      initialPiHomeFiles: piHome.initialFiles,
      piHomeRemoved: true,
      contextFiles: "disabled",
      resources: task.execution.kind === "repository-edit" ? "task-docker-limits" : "explicit-extension-only",
      tools: task.execution.kind === "repository-edit" ? "workspace-read-write-docker-isolated" : "workspace-read-only",
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
  await fs.rm(piHome.directory, { recursive: true, force: true });
  return result;
}

export interface PlanItem {
  pairId: string;
  taskId: string;
  taskPrompt: string;
  repository: string;
  targetCommit: string;
  condition: string;
  run: number;
  workspace: string;
  piCommand: string[];
  graderCommand: string[];
}

async function validateNegativeControl(
  options: BenchmarkOptions,
  commit: string,
  task: LoadedTask,
  workspaceParent: string,
): Promise<GraderResult> {
  const workspace = await createTaskWorkspace(options, task, commit, `preflight-${task.id}`, workspaceParent);
  const answer = path.join(workspaceParent, `preflight-${task.id}-answer.md`);
  const events = path.join(workspaceParent, `preflight-${task.id}-events.jsonl`);
  const artifacts = path.join(workspaceParent, `preflight-${task.id}-artifacts`);
  try {
    if (task.execution.kind === "answer") {
      await removePrivateTaskFromWorkspace(workspace, options.repo, options.tasksRoot);
    } else {
      await commitBaseline(workspace);
    }
    await assertGraderOutsideWorkspace(workspace, task.graderDirectory);
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, "changes.patch"), "", "utf8");
    await Promise.all([fs.writeFile(answer, "", "utf8"), fs.writeFile(events, "", "utf8")]);
    const result = await runHiddenGrader(task, workspace, answer, events, artifacts);
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
      fs.rm(artifacts, { recursive: true, force: true }),
    ]);
  }
}

export async function runBenchmark(
  options: BenchmarkOptions,
  preloadedTasks?: LoadedTask[],
): Promise<{ resultsRoot: string; plan: PlanItem[]; runs: RunResult[]; pricing: PricingResolution }> {
  if (options.runs !== BENCHMARK_REPETITIONS) {
    throw new Error(`Benchmark repetitions are fixed at ${BENCHMARK_REPETITIONS}; received ${options.runs}.`);
  }
  const deepSwe = Boolean(options.deepSweCheckout);
  if (deepSwe && options.repo) throw new Error("DeepSWE task repositories come from pinned task metadata; do not pass options.repo.");
  if (!deepSwe && !options.repo) throw new Error("A target repository is required for bundled tasks.");
  const repo = deepSwe ? "" : path.resolve(options.repo);
  const outputRoot = path.resolve(options.outputRoot);
  const tasks = preloadedTasks ?? (options.deepSweCheckout
    ? await loadDeepSweTasks(options.deepSweCheckout, options.taskIds)
    : await Promise.all(options.taskIds.map((id) => loadTask(options.tasksRoot, id))));
  const commit = deepSwe ? "" : await resolveCommit(repo);
  const pricing = options.pricingMode === "off"
    ? disabledPricing(options.model)
    : await fetchOpenRouterPricing(options.model, options.pricingModel);
  const timestamp = slugTimestamp();
  const resultsRoot = path.join(outputRoot, timestamp);
  const workspaceParent = path.join(os.tmpdir(), `mapbench-${timestamp}`);
  const taskCommits = tasks.map((task) => `${task.id}:${targetCommitForTask(task, commit)}`).join(",");
  const seed = options.seed ?? `${taskCommits}:${options.runs}`;
  const ordered: Array<{
    task: LoadedTask;
    commit: string;
    condition: BenchmarkOptions["conditions"][number];
    run: number;
    pairId: string;
  }> = [];
  for (const task of tasks) for (let run = 1; run <= options.runs; run += 1) {
    const pairId = `${task.id}:run-${String(run).padStart(3, "0")}`;
    const taskCommit = targetCommitForTask(task, commit);
    for (const condition of seededShuffle(options.conditions, `${seed}:${pairId}`)) {
      ordered.push({ task, commit: taskCommit, condition, run, pairId });
    }
  }
  const plan: PlanItem[] = ordered.map(({ task, commit: taskCommit, condition, run, pairId }) => {
    const workspace = path.join(workspaceParent, `${task.id}-${run}-${condition}`);
    const artifact = path.join(resultsRoot, condition, task.id, `run-${String(run).padStart(3, "0")}`);
    const workspaceMode: PiWorkspaceMode = task.execution.kind === "repository-edit" ? "isolated-read-write" : "read-only";
    return {
      pairId,
      taskId: task.id,
      taskPrompt: task.prompt,
      repository: targetRepositoryForTask(task, options),
      targetCommit: taskCommit,
      condition,
      run,
      workspace,
      piCommand: piCommand(options.provider, options.model, condition, promptForTask(task), workspaceMode),
      graderCommand: expandCommand(
        task.grader.command,
        workspace,
        task.graderDirectory,
        path.join(artifact, "final-message.md"),
        path.join(artifact, "events.jsonl"),
        artifact,
      ),
    };
  });
  if (options.dryRun) return { resultsRoot, plan, runs: [], pricing };
  await fs.mkdir(resultsRoot, { recursive: true });
  await fs.mkdir(workspaceParent, { recursive: true });
  const graderPreflight: Record<string, GraderResult> = {};
  for (const task of tasks) {
    graderPreflight[task.id] = await validateNegativeControl(
      options,
      targetCommitForTask(task, commit),
      task,
      workspaceParent,
    );
  }
  await writeJson(path.join(resultsRoot, "config.json"), {
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    repo: repo || null,
    targetCommit: commit || null,
    tasksRoot: deepSwe ? null : path.resolve(options.tasksRoot),
    deepSwe: deepSwe ? {
      version: tasks[0]?.execution.kind === "repository-edit" ? tasks[0].execution.sourceVersion : DEEPSWE_SOURCE.version,
      revision: tasks[0]?.execution.kind === "repository-edit" ? tasks[0].execution.sourceRevision : DEEPSWE_SOURCE.revision,
      checkout: path.resolve(options.deepSweCheckout!),
    } : null,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      grader: task.grader,
      checks: task.checks ?? {},
      execution: task.execution,
    })),
    conditions: options.conditions,
    conditionFactors: Object.fromEntries(options.conditions.map((condition) => [condition, CONDITION_FACTORS[condition]])),
    conditionLabels: Object.fromEntries(options.conditions.map((condition) => [condition, CONDITION_LABELS[condition]])),
    conditionComponents: Object.fromEntries(options.conditions.map((condition) => [condition, COMPONENTS[condition]])),
    runs: options.runs,
    aggregation: "arithmetic-mean",
    provider: options.provider,
    model: options.model,
    thinking: DEFAULT_BENCHMARK_THINKING,
    timeoutMs: options.timeoutMs,
    seed,
    executionOrder: plan.map(({ pairId, condition }) => ({ pairId, condition })),
    graderPreflight,
    workspaceRoot: options.keepWorkspaces ? workspaceParent : null,
    pricing,
    pi: {
      jsonl: true,
      ephemeral: true,
      contextFiles: false,
      discoveredResources: false,
      projectTrust: false,
      tools: deepSwe ? "workspace-confined file tools plus Docker-sandboxed bash" : "explicit workspace-confined read-only extension",
      promptSuffix: deepSwe ? CODE_PROMPT_SUFFIX.trim() : ANSWER_PROMPT_SUFFIX.trim(),
      debugUsage: options.debugUsage,
      isolation: {
        process: "new pi process per run; resume is never used",
        session: "--no-session",
        workspace: "sanitized exact-commit export reinitialized without the original Git object database",
        piHome: "fresh directory containing only auth.json when file-based authentication is used",
      },
    },
  });
  const runs: RunResult[] = [];
  const startingTrees = new Map<string, string>();
  const promptHashes = new Map<string, string>();
  for (const item of ordered) {
    process.stdout.write(`[${runs.length + 1}/${ordered.length}] ${item.pairId} ${item.condition}\n`);
    const result = await executeRun(options, resultsRoot, item.commit, item.task, item.condition, item.run, item.pairId, workspaceParent, pricing);
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
