import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { runProcess } from "./process.js";
import { DEEPSWE_SOURCE } from "./deepswe-manifest.js";
import type { DeepSweTaskExecution, LoadedTask } from "./types.js";

export interface DeepSweSourceConfig {
  name: string;
  version: "1.1";
  schemaVersion: "1.3";
  repository: string;
  revision: string;
  tasksDirectory: string;
  sets: Readonly<Record<string, readonly string[]>>;
}

interface DeepSweToml {
  schema_version?: unknown;
  artifacts?: unknown;
  task?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  verifier?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  environment?: Record<string, unknown>;
}

function requiredString(record: Record<string, unknown> | undefined, field: string, taskId: string): string {
  const value = record?.[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`DeepSWE task ${taskId} is missing ${field}.`);
  return value.trim();
}

function requiredNumber(record: Record<string, unknown> | undefined, field: string, taskId: string): number {
  const value = record?.[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`DeepSWE task ${taskId} has invalid ${field}.`);
  }
  return value;
}

async function requiredFile(file: string, taskId: string, label: string): Promise<void> {
  const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`DeepSWE task ${taskId} is missing ${label}: ${file}`);
    throw error;
  });
  if (!stat.isFile()) throw new Error(`DeepSWE task ${taskId} ${label} is not a file: ${file}`);
}

async function git(checkout: string, args: string[]): Promise<string> {
  const result = await runProcess(["git", ...args], { cwd: checkout, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`Invalid DeepSWE checkout at ${checkout}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function validateDeepSweCheckout(
  checkoutInput: string,
  source: DeepSweSourceConfig = DEEPSWE_SOURCE,
): Promise<string> {
  const checkout = path.resolve(checkoutInput);
  const stat = await fs.stat(checkout).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`DeepSWE checkout does not exist: ${checkout}`);
    throw error;
  });
  if (!stat.isDirectory()) throw new Error(`DeepSWE checkout is not a directory: ${checkout}`);
  const revision = await git(checkout, ["rev-parse", "HEAD"]);
  if (revision !== source.revision) {
    throw new Error(`DeepSWE revision mismatch: expected ${source.revision} for v${source.version}, found ${revision}.`);
  }
  const status = await git(checkout, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error(`DeepSWE checkout at ${checkout} has local changes; a clean pinned checkout is required.`);
  const tasksRoot = path.join(checkout, source.tasksDirectory);
  const tasksStat = await fs.stat(tasksRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`DeepSWE checkout is missing its task directory: ${tasksRoot}`);
    throw error;
  });
  if (!tasksStat.isDirectory()) throw new Error(`DeepSWE task root is not a directory: ${tasksRoot}`);
  return checkout;
}

async function listValidatedTasks(checkout: string, source: DeepSweSourceConfig): Promise<string[]> {
  const entries = await fs.readdir(path.join(checkout, source.tasksDirectory), { withFileTypes: true });
  const taskIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(checkout, source.tasksDirectory, entry.name, "task.toml");
    if (await fs.stat(manifest).then((value) => value.isFile(), () => false)) taskIds.push(entry.name);
  }
  return taskIds.sort();
}

export async function listDeepSweTasks(
  checkoutInput: string,
  source: DeepSweSourceConfig = DEEPSWE_SOURCE,
): Promise<string[]> {
  const checkout = await validateDeepSweCheckout(checkoutInput, source);
  return await listValidatedTasks(checkout, source);
}

function verifierScript(): string {
  const extension = path.extname(fileURLToPath(import.meta.url));
  return path.join(import.meta.dirname, `deepswe-verifier${extension}`);
}

async function adaptTask(checkout: string, id: string, source: DeepSweSourceConfig): Promise<LoadedTask> {
  const directory = path.join(checkout, source.tasksDirectory, id);
  const manifestFile = path.join(directory, "task.toml");
  const instructionFile = path.join(directory, "instruction.md");
  const testsDirectory = path.join(directory, "tests");
  const verifierConfigFile = path.join(testsDirectory, "config.json");
  await Promise.all([
    requiredFile(manifestFile, id, "task.toml"),
    requiredFile(instructionFile, id, "instruction.md"),
    requiredFile(path.join(directory, "environment", "Dockerfile"), id, "environment/Dockerfile"),
    requiredFile(path.join(testsDirectory, "Dockerfile"), id, "tests/Dockerfile"),
    requiredFile(path.join(testsDirectory, "test.sh"), id, "tests/test.sh"),
    requiredFile(path.join(testsDirectory, "grader.py"), id, "tests/grader.py"),
    requiredFile(verifierConfigFile, id, "tests/config.json"),
    requiredFile(path.join(testsDirectory, "test.patch"), id, "tests/test.patch"),
  ]);

  let document: DeepSweToml;
  try {
    document = parse(await fs.readFile(manifestFile, "utf8")) as DeepSweToml;
  } catch (error) {
    throw new Error(`Malformed DeepSWE task metadata for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document.schema_version !== source.schemaVersion) {
    throw new Error(`DeepSWE task ${id} schema mismatch: expected ${source.schemaVersion}, found ${String(document.schema_version)}.`);
  }

  const metadata = document.metadata;
  const taskId = requiredString(metadata, "task_id", id);
  if (taskId !== id) throw new Error(`DeepSWE task ID mismatch: directory ${id}, metadata ${taskId}.`);
  const repositoryUrl = requiredString(metadata, "repository_url", id);
  const baseCommit = requiredString(metadata, "base_commit_hash", id);
  if (!/^[0-9a-f]{7,40}$/i.test(baseCommit)) throw new Error(`DeepSWE task ${id} has invalid base_commit_hash.`);
  let verifierConfig: unknown;
  try {
    verifierConfig = JSON.parse(await fs.readFile(verifierConfigFile, "utf8"));
  } catch (error) {
    throw new Error(`Malformed DeepSWE verifier config for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!verifierConfig || typeof verifierConfig !== "object" || Array.isArray(verifierConfig)) {
    throw new Error(`DeepSWE task ${id} has an invalid verifier config.`);
  }
  const verifierConfigRecord: Record<string, unknown> = Object.fromEntries(Object.entries(verifierConfig));
  if (verifierConfigRecord.base_commit !== baseCommit) {
    throw new Error(`DeepSWE task ${id} verifier base commit does not match task.toml.`);
  }
  if (!Array.isArray(verifierConfigRecord.f2p_node_ids) || verifierConfigRecord.f2p_node_ids.length === 0 ||
      !Array.isArray(verifierConfigRecord.p2p_node_ids) ||
      !verifierConfigRecord.grade || typeof verifierConfigRecord.grade !== "object" || Array.isArray(verifierConfigRecord.grade)) {
    throw new Error(`DeepSWE task ${id} has an incomplete verifier config.`);
  }
  const externalId = requiredString(metadata, "ext_id", id);
  const language = requiredString(metadata, "language", id);
  const title = requiredString(metadata, "display_title", id);
  const taskName = requiredString(document.task, "name", id);
  if (taskName !== `datacurve/${id}`) throw new Error(`DeepSWE task ${id} has unexpected task.name ${taskName}.`);

  const environment = document.environment;
  const dockerImage = requiredString(environment, "docker_image", id);
  if (!dockerImage.endsWith(`-v${source.version}`)) {
    throw new Error(`DeepSWE task ${id} environment version mismatch: expected a v${source.version} image, found ${dockerImage}.`);
  }
  if (environment?.os !== "linux") throw new Error(`DeepSWE task ${id} must use a linux environment.`);
  if (typeof environment.gpus !== "number" || !Number.isFinite(environment.gpus) || environment.gpus < 0) {
    throw new Error(`DeepSWE task ${id} has invalid gpus.`);
  }
  if (!Array.isArray(environment.mcp_servers) || environment.mcp_servers.length !== 0) {
    throw new Error(`DeepSWE task ${id} must not expose MCP servers to the agent.`);
  }
  if (!environment.env || typeof environment.env !== "object" || Array.isArray(environment.env) || Object.keys(environment.env).length !== 0) {
    throw new Error(`DeepSWE task ${id} has unsupported environment variables.`);
  }
  if (environment.gpus !== 0) throw new Error(`DeepSWE task ${id} requires unsupported GPU resources.`);
  const agent = document.agent;
  const verifier = document.verifier;
  if (agent?.network_mode !== "no-network") throw new Error(`DeepSWE task ${id} agent must use no-network mode.`);
  if (verifier?.network_mode !== "no-network") throw new Error(`DeepSWE task ${id} verifier must use no-network mode.`);
  if (verifier?.environment_mode !== "separate") throw new Error(`DeepSWE task ${id} verifier must use a separate environment.`);
  const artifacts = document.artifacts;
  if (!Array.isArray(artifacts) || !artifacts.includes("/logs/artifacts/model.patch")) {
    throw new Error(`DeepSWE task ${id} is missing the model.patch artifact declaration.`);
  }
  const collect = verifier.collect;
  if (!Array.isArray(collect) || collect.length !== 1 || typeof collect[0] !== "object" || collect[0] === null) {
    throw new Error(`DeepSWE task ${id} has an invalid verifier.collect hook.`);
  }
  const collectCommand = requiredString(collect[0] as Record<string, unknown>, "command", id);
  if (!collectCommand.includes(baseCommit) || !collectCommand.includes("/logs/artifacts/model.patch")) {
    throw new Error(`DeepSWE task ${id} verifier.collect does not produce the pinned model patch.`);
  }

  const instruction = (await fs.readFile(instructionFile, "utf8")).trim();
  if (!instruction) throw new Error(`DeepSWE task ${id} has an empty instruction.`);
  const verifierEnvironment = verifier.environment as Record<string, unknown> | undefined;
  const execution: DeepSweTaskExecution = {
    kind: "repository-edit",
    source: "deep-swe",
    sourceVersion: source.version,
    sourceRevision: source.revision,
    sourceCheckout: checkout,
    externalId,
    language,
    repositoryUrl,
    baseCommit,
    environment: {
      dockerImage,
      os: "linux",
      cpus: requiredNumber(environment, "cpus", id),
      memoryMb: requiredNumber(environment, "memory_mb", id),
      storageMb: requiredNumber(environment, "storage_mb", id),
      gpus: environment.gpus,
      networkMode: "no-network",
      buildTimeoutMs: requiredNumber(environment, "build_timeout_sec", id) * 1000,
      timeoutMs: requiredNumber(agent, "timeout_sec", id) * 1000,
    },
    verifier: {
      environmentMode: "separate",
      networkMode: "no-network",
      timeoutMs: requiredNumber(verifier, "timeout_sec", id) * 1000,
      buildTimeoutMs: requiredNumber(verifierEnvironment, "build_timeout_sec", id) * 1000,
      cpus: requiredNumber(verifierEnvironment, "cpus", id),
      memoryMb: requiredNumber(verifierEnvironment, "memory_mb", id),
      storageMb: requiredNumber(verifierEnvironment, "storage_mb", id),
    },
  };
  return {
    version: 1,
    id,
    title,
    promptFile: "instruction.md",
    grader: {
      command: [
        process.execPath,
        verifierScript(),
        "--workspace", "{workspace}",
        "--tests", "{grader}",
        "--output", "{artifacts}/deepswe",
        "--patch", "{artifacts}/changes.patch",
        "--cpus", String(execution.verifier.cpus),
        "--memory-mb", String(execution.verifier.memoryMb),
        "--image", execution.environment.dockerImage,
        "--timeout-ms", String(execution.verifier.timeoutMs),
        "--storage-mb", String(execution.verifier.storageMb),
      ],
      timeoutMs: execution.verifier.buildTimeoutMs + execution.verifier.timeoutMs + 300_000,
    },
    directory,
    prompt: instruction,
    graderDirectory: testsDirectory,
    execution,
  };
}

export async function loadDeepSweTasks(
  checkoutInput: string,
  ids: readonly string[],
  source: DeepSweSourceConfig = DEEPSWE_SOURCE,
): Promise<LoadedTask[]> {
  const checkout = await validateDeepSweCheckout(checkoutInput, source);
  const available = await listValidatedTasks(checkout, source);
  const known = new Set(available);
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Unknown DeepSWE v${source.version} task ID: ${id}`);
  }
  return await Promise.all(ids.map((id) => adaptTask(checkout, id, source)));
}

export function resolveDeepSweTaskSet(name: string, source: DeepSweSourceConfig = DEEPSWE_SOURCE): string[] {
  const taskIds = source.sets[name];
  if (!taskIds) throw new Error(`Unknown DeepSWE task set: ${name}. Available sets: ${Object.keys(source.sets).sort().join(", ")}`);
  return [...taskIds];
}
