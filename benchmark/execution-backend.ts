import { promises as fs } from "node:fs";
import path from "node:path";
import type { Sandbox } from "modal";
import { MODAL_SDK_VERSION, ModalSandboxRuntime, downloadDirectoryFromModal, uploadDirectoryToModal } from "./modal-sandbox.js";
import { runProcess } from "./process.js";
import type {
  BenchmarkOptions,
  DeepSweTaskExecution,
  ExecutionBackendKind,
  ExecutionBackendMetadata,
  ModalBackendOptions,
} from "./types.js";
import {
  createDockerImageWorkspace,
  removeDockerWorkspace,
  sanitizeImageWorkspace,
  startDockerWorkspace,
} from "./workspace.js";

const MAX_MODAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface AgentSandbox {
  metadata: ExecutionBackendMetadata;
  piEnvironment: NodeJS.ProcessEnv;
  recoverAfterTimeout(): Promise<void>;
  stop(): Promise<void>;
}

export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  readonly concurrency: number;
  readonly descriptor: Record<string, unknown>;
  materializeWorkspace(execution: DeepSweTaskExecution, commit: string, label: string, parent: string): Promise<string>;
  startAgentSandbox(execution: DeepSweTaskExecution, workspace: string, label: string): Promise<AgentSandbox>;
  metadata(execution: DeepSweTaskExecution): ExecutionBackendMetadata;
  graderEnvironment(): NodeJS.ProcessEnv;
  close(): void;
}

function backendEnvironment(kind: ExecutionBackendKind, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MAPBENCH_EXECUTION_BACKEND: kind, ...additions };
}

class DockerExecutionBackend implements ExecutionBackend {
  readonly kind = "docker" as const;
  readonly concurrency = 1;
  readonly descriptor: Record<string, unknown>;

  constructor(runtimeVersion: string | null) {
    this.descriptor = {
      kind: this.kind,
      runtime: "docker-engine",
      runtimeVersion,
      concurrency: 1,
      networkMode: "no-network",
    };
  }

  metadata(execution: DeepSweTaskExecution): ExecutionBackendMetadata {
    return {
      kind: "docker",
      runtime: "docker-engine",
      runtimeVersion: typeof this.descriptor.runtimeVersion === "string" ? this.descriptor.runtimeVersion : null,
      taskImage: execution.environment.dockerImage,
      networkMode: "no-network",
      cpus: execution.environment.cpus,
      memoryMb: execution.environment.memoryMb,
      storageMb: execution.environment.storageMb,
      gpus: execution.environment.gpus,
    };
  }

  async materializeWorkspace(execution: DeepSweTaskExecution, commit: string, label: string, parent: string): Promise<string> {
    return await createDockerImageWorkspace(execution.environment.dockerImage, commit, label, parent);
  }

  async startAgentSandbox(execution: DeepSweTaskExecution, workspace: string): Promise<AgentSandbox> {
    const container = await startDockerWorkspace(execution.environment.dockerImage, workspace, execution.environment);
    let stopped = false;
    return {
      metadata: { ...this.metadata(execution), sandboxId: container },
      piEnvironment: { MAPBENCH_DOCKER_CONTAINER: container },
      async recoverAfterTimeout() {},
      async stop() {
        if (stopped) return;
        stopped = true;
        await removeDockerWorkspace(container);
      },
    };
  }

  graderEnvironment(): NodeJS.ProcessEnv {
    return backendEnvironment("docker", process.env.MAPBENCH_DOCKER ? { MAPBENCH_DOCKER: process.env.MAPBENCH_DOCKER } : {});
  }

  close(): void {}
}

function modalHelperPath(): string {
  const source = path.join(import.meta.dirname, "modal-shell.ts");
  const compiled = path.join(import.meta.dirname, "modal-shell.js");
  return process.argv[1]?.includes(`${path.sep}dist${path.sep}`) ? compiled : source;
}

function serializedModalSettings(settings: ModalBackendOptions): string {
  return JSON.stringify(settings);
}

export class ModalExecutionBackend implements ExecutionBackend {
  readonly kind = "modal" as const;
  readonly concurrency: number;
  readonly descriptor: Record<string, unknown>;
  private readonly runtime: ModalSandboxRuntime;

  constructor(settings: ModalBackendOptions, concurrency: number, runtime = new ModalSandboxRuntime(settings)) {
    this.runtime = runtime;
    this.concurrency = concurrency;
    this.descriptor = {
      kind: this.kind,
      runtime: "modal-sandbox",
      runtimeVersion: runtime.runtimeVersion(),
      sdkVersion: MODAL_SDK_VERSION,
      appName: settings.appName,
      environment: settings.environment ?? null,
      cloud: settings.cloud ?? null,
      region: settings.region ?? null,
      concurrency,
      networkMode: "no-network",
      filesystemTransport: "tar-over-sandbox-filesystem-api",
    };
  }

  metadata(execution: DeepSweTaskExecution): ExecutionBackendMetadata {
    return {
      kind: "modal",
      runtime: "modal-sandbox",
      runtimeVersion: this.runtime.runtimeVersion(),
      taskImage: execution.environment.dockerImage,
      networkMode: "no-network",
      cpus: execution.environment.cpus,
      memoryMb: execution.environment.memoryMb,
      storageMb: execution.environment.storageMb,
      gpus: execution.environment.gpus,
      appName: this.runtime.settings.appName,
      environment: this.runtime.settings.environment,
      cloud: this.runtime.settings.cloud,
      region: this.runtime.settings.region,
    };
  }

  async materializeWorkspace(execution: DeepSweTaskExecution, commit: string, label: string, parent: string): Promise<string> {
    await fs.mkdir(parent, { recursive: true });
    const workspace = path.join(parent, label.replace(/[^a-zA-Z0-9_.-]/g, "-"));
    await fs.mkdir(workspace, { recursive: false });
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await this.runtime.create({
        image: execution.environment.dockerImage,
        resources: execution.environment,
        timeoutMs: Math.min(MAX_MODAL_TIMEOUT_MS, execution.environment.buildTimeoutMs + 300_000),
        name: `${label}-source`.slice(0, 64),
        tags: { mapbench: "workspace-source", task: execution.externalId },
      });
      await downloadDirectoryFromModal(sandbox, "/app", workspace);
      await sanitizeImageWorkspace(workspace, commit);
      return workspace;
    } catch (error) {
      await fs.rm(workspace, { recursive: true, force: true });
      throw error;
    } finally {
      if (sandbox) await sandbox.terminate({ wait: true }).catch(() => undefined);
    }
  }

  async startAgentSandbox(execution: DeepSweTaskExecution, workspace: string, label: string): Promise<AgentSandbox> {
    const sandbox = await this.runtime.create({
      image: execution.environment.dockerImage,
      resources: execution.environment,
      timeoutMs: Math.min(MAX_MODAL_TIMEOUT_MS, execution.environment.timeoutMs + 300_000),
      name: label.slice(0, 64),
      tags: { mapbench: "agent", task: execution.externalId },
    });
    try {
      await uploadDirectoryToModal(sandbox, workspace, "/app");
    } catch (error) {
      await sandbox.terminate({ wait: true }).catch(() => undefined);
      throw error;
    }
    let stopped = false;
    return {
      metadata: { ...this.metadata(execution), sandboxId: sandbox.sandboxId },
      piEnvironment: {
        MAPBENCH_MODAL_SANDBOX_ID: sandbox.sandboxId,
        MAPBENCH_MODAL_CONFIG: serializedModalSettings(this.runtime.settings),
        MAPBENCH_MODAL_HELPER: modalHelperPath(),
        MAPBENCH_MODAL_HELPER_RUNTIME: process.execPath,
      },
      async recoverAfterTimeout() {
        await downloadDirectoryFromModal(sandbox, "/app", workspace).catch(() => undefined);
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await sandbox.terminate({ wait: true }).catch(() => undefined);
      },
    };
  }

  graderEnvironment(): NodeJS.ProcessEnv {
    return backendEnvironment("modal", { MAPBENCH_MODAL_CONFIG: serializedModalSettings(this.runtime.settings) });
  }

  close(): void {
    this.runtime.close();
  }
}

async function dockerVersion(): Promise<string | null> {
  const executable = process.env.MAPBENCH_DOCKER ?? "docker";
  const result = await runProcess([executable, "version", "--format", "{{.Server.Version}}"], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
export function validateExecutionBackendOptions(options: BenchmarkOptions): {
  kind: ExecutionBackendKind;
  concurrency: number;
  modal: ModalBackendOptions;
} {
  const kind = options.backend ?? "docker";
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > 32) {
    throw new Error("Benchmark concurrency must be an integer from 1 to 32.");
  }
  if (kind === "docker" && concurrency !== 1) {
    throw new Error("Docker execution uses concurrency 1; use --backend modal for concurrent task cells.");
  }
  const modal = options.modal ?? { appName: "mapbench" };
  if (!modal.appName.trim()) throw new Error("Modal app name must not be empty.");
  return { kind, concurrency, modal };
}


export async function createExecutionBackend(options: BenchmarkOptions): Promise<ExecutionBackend> {
  const resolved = validateExecutionBackendOptions(options);
  if (resolved.kind === "docker") return new DockerExecutionBackend(await dockerVersion());
  return new ModalExecutionBackend(resolved.modal, resolved.concurrency);
}
