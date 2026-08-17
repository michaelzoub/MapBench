import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModalClient, type App, type Sandbox } from "modal";
import { runProcess } from "./process.js";
import type { ModalBackendOptions } from "./types.js";

export const MODAL_SDK_VERSION = "0.9.0";
const MAX_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface SandboxResources {
  cpus: number;
  memoryMb: number;
  storageMb: number;
  gpus: number;
}

export interface ModalSandboxSpec {
  image: string;
  resources: SandboxResources;
  timeoutMs: number;
  name: string;
  tags: Record<string, string>;
}

export interface ModalCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function modalOptionsFromEnvironment(): ModalBackendOptions {
  const serialized = process.env.MAPBENCH_MODAL_CONFIG;
  if (!serialized) throw new Error("MAPBENCH_MODAL_CONFIG is required for Modal execution.");
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MAPBENCH_MODAL_CONFIG must contain an object.");
  const record = value as Record<string, unknown>;
  if (typeof record.appName !== "string" || !record.appName) throw new Error("MAPBENCH_MODAL_CONFIG.appName is required.");
  for (const field of ["environment", "cloud", "region"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "string" || !record[field])) {
      throw new Error(`MAPBENCH_MODAL_CONFIG.${field} must be a non-empty string.`);
    }
  }
  return {
    appName: record.appName,
    ...(typeof record.environment === "string" ? { environment: record.environment } : {}),
    ...(typeof record.cloud === "string" ? { cloud: record.cloud } : {}),
    ...(typeof record.region === "string" ? { region: record.region } : {}),
  };
}

function validateSandboxSpec(spec: ModalSandboxSpec): void {
  if (!spec.image) throw new Error("A Modal Sandbox requires an existing container image.");
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > MAX_SANDBOX_TIMEOUT_MS) {
    throw new Error("Modal Sandbox timeout must be positive and no greater than 24 hours.");
  }
  if (!Number.isFinite(spec.resources.cpus) || spec.resources.cpus <= 0) throw new Error("Modal Sandbox CPU limit must be positive.");
  if (!Number.isFinite(spec.resources.memoryMb) || spec.resources.memoryMb <= 0) throw new Error("Modal Sandbox memory limit must be positive.");
  if (spec.resources.gpus !== 0) throw new Error("DeepSWE v1.1 Modal tasks must declare zero GPUs.");
}

async function consumeStream(stream: ReadableStream<string>, onData?: (data: Buffer) => void): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += value;
      onData?.(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return output;
}

export async function execModalCommand(
  sandbox: Sandbox,
  command: string[],
  timeoutMs: number,
  onStdout?: (data: Buffer) => void,
  onStderr?: (data: Buffer) => void,
): Promise<ModalCommandResult> {
  const child = await sandbox.exec(command, { timeoutMs });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.wait(),
    consumeStream(child.stdout, onStdout),
    consumeStream(child.stderr, onStderr),
  ]);
  return { exitCode, stdout, stderr };
}

async function checkedModalCommand(sandbox: Sandbox, command: string[], timeoutMs: number): Promise<void> {
  const result = await execModalCommand(sandbox, command, timeoutMs);
  if (result.exitCode !== 0) throw new Error(`Modal Sandbox command failed (${result.exitCode}): ${result.stderr || result.stdout}`);
}

export async function terminateModalSandbox(sandbox: Sandbox, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await sandbox.terminate({ wait: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        const delay = Promise.withResolvers<void>();
        setTimeout(delay.resolve, 100 * (attempt + 1));
        await delay.promise;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function temporaryArchive(label: string): Promise<{ directory: string; file: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `mapbench-modal-${label}-`));
  return { directory, file: path.join(directory, "workspace.tar") };
}

export async function uploadDirectoryToModal(sandbox: Sandbox, localDirectory: string, remoteDirectory: string): Promise<void> {
  const archive = await temporaryArchive("upload");
  try {
    const packed = await runProcess(["tar", "-cf", archive.file, "-C", path.resolve(localDirectory), "."], {
      cwd: localDirectory,
      timeoutMs: 1_800_000,
    });
    if (packed.exitCode !== 0) throw new Error(`Unable to archive Modal workspace: ${packed.stderr || packed.stdout}`);
    await sandbox.filesystem.copyFromLocal(archive.file, "/tmp/mapbench-workspace-upload.tar");
    await checkedModalCommand(sandbox, [
      "/bin/sh", "-c",
      `mkdir -p ${remoteDirectory} && find ${remoteDirectory} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xf /tmp/mapbench-workspace-upload.tar -C ${remoteDirectory} && rm -f /tmp/mapbench-workspace-upload.tar`,
    ], 1_800_000);
  } finally {
    await fs.rm(archive.directory, { recursive: true, force: true });
  }
}

export async function downloadDirectoryFromModal(sandbox: Sandbox, remoteDirectory: string, localDirectory: string): Promise<void> {
  const archive = await temporaryArchive("download");
  try {
    await checkedModalCommand(sandbox, [
      "/bin/sh", "-c",
      `tar -cf /tmp/mapbench-workspace-download.tar -C ${remoteDirectory} .`,
    ], 1_800_000);
    await sandbox.filesystem.copyToLocal("/tmp/mapbench-workspace-download.tar", archive.file);
    await checkedModalCommand(sandbox, ["rm", "-f", "/tmp/mapbench-workspace-download.tar"], 120_000);
    await fs.mkdir(localDirectory, { recursive: true });
    const entries = await fs.readdir(localDirectory);
    await Promise.all(entries.map((entry) => fs.rm(path.join(localDirectory, entry), { recursive: true, force: true })));
    const extracted = await runProcess(["tar", "-xf", archive.file, "-C", path.resolve(localDirectory)], {
      cwd: localDirectory,
      timeoutMs: 1_800_000,
    });
    if (extracted.exitCode !== 0) throw new Error(`Unable to extract Modal workspace: ${extracted.stderr || extracted.stdout}`);
  } finally {
    await fs.rm(archive.directory, { recursive: true, force: true });
  }
}

export class ModalSandboxRuntime {
  readonly settings: ModalBackendOptions;
  readonly client: ModalClient;
  private appPromise: Promise<App> | undefined;

  constructor(settings: ModalBackendOptions, client = new ModalClient({ environment: settings.environment })) {
    this.settings = settings;
    this.client = client;
  }

  runtimeVersion(): string {
    return this.client.version() || MODAL_SDK_VERSION;
  }

  private app(): Promise<App> {
    this.appPromise ??= this.client.apps.fromName(this.settings.appName, {
      createIfMissing: true,
      ...(this.settings.environment ? { environment: this.settings.environment } : {}),
    });
    return this.appPromise;
  }

  async create(spec: ModalSandboxSpec): Promise<Sandbox> {
    validateSandboxSpec(spec);
    const app = await this.app();
    const image = this.client.images.fromRegistry(spec.image);
    return await this.client.sandboxes.create(app, image, {
      cpu: spec.resources.cpus,
      cpuLimit: spec.resources.cpus,
      memoryMiB: spec.resources.memoryMb,
      memoryLimitMiB: spec.resources.memoryMb,
      timeoutMs: spec.timeoutMs,
      workdir: "/app",
      blockNetwork: true,
      name: spec.name,
      tags: spec.tags,
      ...(this.settings.cloud ? { cloud: this.settings.cloud } : {}),
      ...(this.settings.region ? { regions: [this.settings.region] } : {}),
    });
  }

  async fromId(id: string): Promise<Sandbox> {
    return await this.client.sandboxes.fromId(id);
  }

  close(): void {
    this.client.close();
  }
}
