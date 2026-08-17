import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { estimateCost, parsePiEvents } from "./events.js";
import { loadDeepSweTasks } from "./deepswe.js";
import { DEEPSWE_SOURCE } from "./deepswe-manifest.js";
import { createExecutionBackend, validateExecutionBackendOptions, type AgentSandbox, type ExecutionBackend } from "./execution-backend.js";
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

  createWorkspace,
  conditionInstructions,
  prepareCondition,

  removePrivateTaskFromWorkspace,
  resolveCommit,
  resolveTreeHash,

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

export function isolatedPiEnvironment(piHome: string, queryHelper: string | null, sandboxEnvironment: NodeJS.ProcessEnv | string = {}): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_PROFILE"];
  const env = Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (/_API_KEY$|_AUTH_TOKEN$|_OAUTH_TOKEN$/.test(name) || name.startsWith("AWS_"))) env[name] = value;
  }
  const backendEnvironment = typeof sandboxEnvironment === "string"
    ? { MAPBENCH_DOCKER_CONTAINER: sandboxEnvironment }
    : sandboxEnvironment;
  return {
    ...env,
    PI_CODING_AGENT_DIR: piHome,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    ...(queryHelper ? { MAPBENCH_QUERY_HELPER: queryHelper } : {}),
    ...backendEnvironment,
  };
}
async function copyModalProfile(piHome: { directory: string; initialFiles: string[] }): Promise<void> {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) return;
  const source = process.env.MODAL_CONFIG_PATH
    ? path.resolve(process.env.MODAL_CONFIG_PATH)
    : path.join(os.homedir(), ".modal.toml");
  const stat = await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isFile()) throw new Error(`Modal configuration is not a file: ${source}`);
  const destination = path.join(piHome.directory, ".modal.toml");
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o600);
  piHome.initialFiles.push(".modal.toml");
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
  backend: ExecutionBackend,
): Promise<string> {
  if (task.execution.kind === "repository-edit") {
    return await backend.materializeWorkspace(task.execution, commit, label, parent);
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
  backend: ExecutionBackend,
): Promise<RunResult> {
  const label = `${task.id}-${run}-${condition}`;
  const artifactDirectory = path.join(resultsRoot, condition, task.id, `run-${String(run).padStart(3, "0")}`);
  await fs.mkdir(artifactDirectory, { recursive: true });
  let workspace = "";
  let piHome: { directory: string; initialFiles: string[] } | undefined;
  let sandbox: AgentSandbox | undefined;
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
  try {
    workspace = await createTaskWorkspace(options, task, commit, label, workspaceParent, backend);
    piHome = await createIsolatedPiHome(workspaceParent, label);
    if (backend.kind === "modal") await copyModalProfile(piHome);
    if (task.execution.kind === "answer") await removePrivateTaskFromWorkspace(workspace, options.repo, options.tasksRoot);
    await assertGraderOutsideWorkspace(workspace, task.graderDirectory);
    const treatment = await prepareCondition(workspace, condition, path.join(workspaceParent, "private-treatments", label));
    baselineCommit = await commitBaseline(workspace);
    baselineTreeHash = await resolveTreeHash(workspace, baselineCommit);
    const finalMessageFile = path.join(artifactDirectory, "final-message.md");
    const prompt = promptForTask(task);
    const execution = task.execution;
    const workspaceMode: PiWorkspaceMode = execution.kind === "repository-edit" ? "isolated-read-write" : "read-only";
    if (execution.kind === "repository-edit") sandbox = await backend.startAgentSandbox(execution, workspace, label);
    const command = piCommand(options.provider, options.model, condition, prompt, workspaceMode);
    const invocationTimeoutMs = execution.kind === "repository-edit"
      ? Math.min(options.timeoutMs, execution.environment.timeoutMs)
      : options.timeoutMs;
    const processResult = await runProcess(command, {
      cwd: workspace,
      timeoutMs: invocationTimeoutMs,
      env: isolatedPiEnvironment(piHome.directory, treatment.callgraphHelper, sandbox?.piEnvironment),
      replaceEnv: true,
    });
    invocation = {
      exitCode: processResult.exitCode,
      durationMs: processResult.durationMs,
      stdoutLineElapsedMs: processResult.stdoutLineElapsedMs,
      timedOut: processResult.timedOut,
      stderr: processResult.stderr || processResult.error || "",
    };
    events = processResult.stdout;
    if (processResult.timedOut) await sandbox?.recoverAfterTimeout();
    const eventsFile = path.join(artifactDirectory, "events.jsonl");
    await fs.writeFile(eventsFile, events, "utf8");
    finalResponse = parsePiEvents(events, processResult.stdoutLineElapsedMs).finalResponse;
    await fs.writeFile(finalMessageFile, finalResponse, "utf8");
    const changes = await captureChanges(workspace, baselineCommit);
    patch = changes.patch;
    filesChanged = changes.files;
    await fs.writeFile(path.join(artifactDirectory, "changes.patch"), patch, "utf8");
    await sandbox?.stop();
    const graderEnvironment = execution.kind === "repository-edit" ? backend.graderEnvironment() : undefined;
    grader = await runHiddenGrader(task, workspace, finalMessageFile, eventsFile, artifactDirectory, graderEnvironment);
    checks = {
      regression: await runCheck(task.checks?.regression, workspace, task.graderDirectory, "", "", "", graderEnvironment),
      typecheck: await runCheck(task.checks?.typecheck, workspace, task.graderDirectory, "", "", "", graderEnvironment),
      build: await runCheck(task.checks?.build, workspace, task.graderDirectory, "", "", "", graderEnvironment),
    };
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    await sandbox?.stop().catch(() => undefined);
  }
  const parsed = parsePiEvents(events, invocation.stdoutLineElapsedMs);
  parsed.tokens.provenance.rawEventFile = options.debugUsage ? "usage-events.json" : null;
  const executionBackend = task.execution.kind === "repository-edit"
    ? (sandbox?.metadata ?? backend.metadata(task.execution))
    : undefined;
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
    ...(executionBackend ? { executionBackend } : {}),
    workspaceKept: options.keepWorkspaces && Boolean(workspace),
    isolation: {
      harness: "pi",
      freshProcess: true,
      resumedSession: false,
      ephemeralSession: true,
      freshWorkspace: true,
      originalGitObjectsRemoved: true,
      piHome: "fresh-auth-only",
      initialPiHomeFiles: piHome?.initialFiles ?? [],
      piHomeRemoved: true,
      contextFiles: "disabled",
      resources: task.execution.kind === "repository-edit" ? "task-environment-limits" : "explicit-extension-only",
      tools: task.execution.kind === "repository-edit"
        ? backend.kind === "modal" ? "workspace-read-write-modal-isolated" : "workspace-read-write-docker-isolated"
        : "workspace-read-only",
    },
    ...(options.keepWorkspaces && workspace ? { workspace } : {}),
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
  if (!options.keepWorkspaces && workspace) await fs.rm(workspace, { recursive: true, force: true });
  if (piHome) await fs.rm(piHome.directory, { recursive: true, force: true });
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
  backend: "docker" | "modal";
  piCommand: string[];
  graderCommand: string[];
}

async function validateNegativeControl(
  options: BenchmarkOptions,
  commit: string,
  task: LoadedTask,
  workspaceParent: string,
  backend: ExecutionBackend,
): Promise<GraderResult> {
  let workspace = "";
  const answer = path.join(workspaceParent, `preflight-${task.id}-answer.md`);
  const events = path.join(workspaceParent, `preflight-${task.id}-events.jsonl`);
  const artifacts = path.join(workspaceParent, `preflight-${task.id}-artifacts`);
  try {
    workspace = await createTaskWorkspace(options, task, commit, `preflight-${task.id}`, workspaceParent, backend);
    if (task.execution.kind === "answer") {
      await removePrivateTaskFromWorkspace(workspace, options.repo, options.tasksRoot);
    } else {
      await commitBaseline(workspace);
    }
    await assertGraderOutsideWorkspace(workspace, task.graderDirectory);
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, "changes.patch"), "", "utf8");
    await Promise.all([fs.writeFile(answer, "", "utf8"), fs.writeFile(events, "", "utf8")]);
    const result = await runHiddenGrader(
      task,
      workspace,
      answer,
      events,
      artifacts,
      task.execution.kind === "repository-edit" ? backend.graderEnvironment() : undefined,
    );
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
      ...(workspace ? [fs.rm(workspace, { recursive: true, force: true })] : []),
      fs.rm(answer, { force: true }),
      fs.rm(events, { force: true }),
      fs.rm(artifacts, { recursive: true, force: true }),
    ]);
  }
}
export async function mapConcurrent<T, R>(items: T[], limit: number, execute: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: unknown[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await execute(items[index], index);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(workers);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} concurrent benchmark operations failed.`);
  return results;
}


export async function runBenchmark(
  options: BenchmarkOptions,
  preloadedTasks?: LoadedTask[],
  backendOverride?: ExecutionBackend,
): Promise<{ resultsRoot: string; plan: PlanItem[]; runs: RunResult[]; pricing: PricingResolution }> {
  if (options.runs !== BENCHMARK_REPETITIONS) {
    throw new Error(`Benchmark repetitions are fixed at ${BENCHMARK_REPETITIONS}; received ${options.runs}.`);
  }
  const backendConfiguration = validateExecutionBackendOptions(options);
  const deepSwe = Boolean(options.deepSweCheckout);
  if (deepSwe && options.repo) throw new Error("DeepSWE task repositories come from pinned task metadata; do not pass options.repo.");
  if (!deepSwe && !options.repo) throw new Error("A target repository is required for bundled tasks.");
  if (!deepSwe && backendConfiguration.kind === "modal") throw new Error("Modal execution is available for DeepSWE repository-edit tasks.");
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
      backend: backendConfiguration.kind,
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
  let backend: ExecutionBackend | undefined;
  try {
    const activeBackend = backendOverride ?? await createExecutionBackend(options);
    backend = activeBackend;
    const preflightResults = await mapConcurrent(tasks, activeBackend.concurrency, async (task) => {
      const result = await validateNegativeControl(
        options,
        targetCommitForTask(task, commit),
        task,
        workspaceParent,
        activeBackend,
      );
      return [task.id, result] as const;
    });
    const graderPreflight: Record<string, GraderResult> = Object.fromEntries(preflightResults);
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
      executionBackend: activeBackend.descriptor,
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
      aggregation: "per-task paired arithmetic mean, then equal-weight task mean",
      pairingKey: "(taskId, repetition)",
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
        tools: deepSwe ? `workspace-confined file tools plus ${activeBackend.kind}-sandboxed bash` : "explicit workspace-confined read-only extension",
        promptSuffix: deepSwe ? CODE_PROMPT_SUFFIX.trim() : ANSWER_PROMPT_SUFFIX.trim(),
        debugUsage: options.debugUsage,
        isolation: {
          process: "new pi process per run; resume is never used",
          session: "--no-session",
          workspace: "sanitized exact-commit export reinitialized without the original Git object database",
          piHome: "fresh directory containing only required provider auth and Modal profile credentials",
        },
      },
    });

    let started = 0;
    const runs = await mapConcurrent(ordered, activeBackend.concurrency, async (item) => {
      started += 1;
      process.stdout.write(`[${started}/${ordered.length}] ${item.pairId} ${item.condition}\n`);
      return await executeRun(
        options,
        resultsRoot,
        item.commit,
        item.task,
        item.condition,
        item.run,
        item.pairId,
        workspaceParent,
        pricing,
        activeBackend,
      );
    });
    const startingTrees = new Map<string, string>();
    const promptHashes = new Map<string, string>();
    for (const result of runs) {
      const cell = `${result.taskId}:${result.condition}`;
      const priorTree = startingTrees.get(cell);
      if (result.baselineTreeHash && priorTree && priorTree !== result.baselineTreeHash) {
        throw new Error(`Starting workspace drift for ${cell}: ${priorTree} != ${result.baselineTreeHash}`);
      }
      if (result.baselineTreeHash) startingTrees.set(cell, result.baselineTreeHash);
      const priorPrompt = promptHashes.get(result.taskId);
      if (priorPrompt && priorPrompt !== result.promptSha256) {
        throw new Error(`Prompt drift for ${result.taskId}: ${priorPrompt} != ${result.promptSha256}`);
      }
      promptHashes.set(result.taskId, result.promptSha256);
    }
    const summary = buildSummary(runs);
    await writeJson(path.join(resultsRoot, "summary.json"), summary);
    await generateReport(resultsRoot, summary);
    return { resultsRoot, plan, runs, pricing };
  } finally {
    backend?.close();
    if (!options.keepWorkspaces) await fs.rm(workspaceParent, { recursive: true, force: true });
  }
}
