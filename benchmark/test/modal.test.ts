import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Sandbox } from "modal";
import { runDeepSweVerifier } from "../deepswe-verifier.js";
import { ModalExecutionBackend } from "../execution-backend.js";
import {
  downloadDirectoryFromModal,
  ModalSandboxRuntime,
  uploadDirectoryToModal,
  type ModalSandboxSpec,
} from "../modal-sandbox.js";
import { runSynchronizedModalCommand } from "../modal-shell.js";
import { runProcess } from "../process.js";
import { mapConcurrent, runBenchmark } from "../runner.js";
import type { BenchmarkOptions, DeepSweTaskExecution, LoadedTask } from "../types.js";

function textStream(value: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      if (value) controller.enqueue(value);
      controller.close();
    },
  });
}

function completedProcess(exitCode = 0, stdout = "", stderr = "") {
  return {
    stdout: textStream(stdout),
    stderr: textStream(stderr),
    async wait() { return exitCode; },
  };
}

class LocalSandbox {
  readonly sandboxId: string;
  readonly root: string;
  terminated = 0;
  terminateFailures = 0;
  readonly copiedIn: string[] = [];
  readonly filesystem: {
    copyFromLocal: (local: string, remote: string) => Promise<void>;
    copyToLocal: (remote: string, local: string) => Promise<void>;
  };

  constructor(root: string, id: string, private readonly failUpload = false) {
    this.root = root;
    this.sandboxId = id;
    this.filesystem = {
      copyFromLocal: async (local, remote) => {
        if (this.failUpload) throw new Error("injected upload failure");
        this.copiedIn.push(remote);
        const destination = this.remote(remote);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(local, destination);
      },
      copyToLocal: async (remote, local) => {
        await fs.mkdir(path.dirname(local), { recursive: true });
        await fs.copyFile(this.remote(remote), local);
      },
    };
  }

  private remote(value: string): string {
    assert.equal(path.isAbsolute(value), true);
    return path.join(this.root, value.slice(1));
  }

  private mapShell(value: string): string {
    return value
      .replaceAll("/tmp/mapbench-workspace-upload.tar", this.remote("/tmp/mapbench-workspace-upload.tar"))
      .replaceAll("/tmp/mapbench-workspace-download.tar", this.remote("/tmp/mapbench-workspace-download.tar"))
      .replaceAll("/logs", this.remote("/logs"))
      .replaceAll("/tests", this.remote("/tests"))
      .replaceAll("/app", this.remote("/app"));
  }

  async exec(command: string[], options?: { timeoutMs?: number }) {
    if (command[0] === "/tests/test.sh") {
      const patch = this.remote("/logs/artifacts/model.patch");
      const passed = (await fs.stat(patch)).size > 0;
      const verifier = this.remote("/logs/verifier");
      await fs.mkdir(verifier, { recursive: true });
      await fs.writeFile(path.join(verifier, "reward.json"), JSON.stringify({
        reward: passed ? 1 : 0,
        f2p_total: 1,
        f2p_passed: passed ? 1 : 0,
        p2p_total: 1,
        p2p_passed: 1,
        f2p: passed ? 1 : 0,
        p2p: 1,
        partial: passed ? 1 : 0.5,
      }));
      await fs.writeFile(path.join(verifier, "ctrf.json"), JSON.stringify({ results: { tests: [] } }));
      return completedProcess(0, passed ? "verified\n" : "empty patch\n");
    }
    const isShell = (command[0] === "/bin/sh" || command[0] === "/bin/bash")
      && (command[1] === "-c" || command[1] === "-lc");
    const mapped = isShell
      ? [command[0], command[1], this.mapShell(command[2])]
      : command.map((part) => part.startsWith("/") ? this.remote(part) : part);
    const result = await runProcess(mapped, {
      cwd: command[0] === "/bin/bash" ? this.remote("/app") : this.root,
      timeoutMs: options?.timeoutMs ?? 120_000,
    });
    return completedProcess(result.exitCode ?? 125, result.stdout, result.stderr);
  }

  async terminate(): Promise<number> {
    if (this.terminateFailures > 0) {
      this.terminateFailures -= 1;
      throw new Error("injected termination failure");
    }
    this.terminated += 1;
    return 0;
  }
}

class LocalModalRuntime {
  readonly settings = { appName: "mapbench-tests", environment: "test", region: "us-east-1" };
  readonly sandboxes: LocalSandbox[] = [];
  readonly specs: ModalSandboxSpec[] = [];
  closed = false;
  failNextUpload = false;

  runtimeVersion(): string { return "test-modal-sdk"; }

  async create(spec: ModalSandboxSpec): Promise<Sandbox> {
    this.specs.push(spec);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-sandbox-"));
    const sandbox = new LocalSandbox(root, `sb-${this.sandboxes.length + 1}`, this.failNextUpload);
    await Promise.all([
      fs.mkdir(path.join(root, "app"), { recursive: true }),
      fs.mkdir(path.join(root, "tmp"), { recursive: true }),
    ]);
    this.sandboxes.push(sandbox);
    return sandbox as unknown as Sandbox;
  }

  close(): void { this.closed = true; }
}

const execution: DeepSweTaskExecution = {
  kind: "repository-edit",
  source: "deep-swe",
  sourceVersion: "1.1",
  sourceRevision: "a".repeat(40),
  sourceCheckout: "/private/deep-swe",
  externalId: "external-task",
  language: "typescript",
  repositoryUrl: "https://github.com/example/project",
  baseCommit: "b".repeat(40),
  environment: {
    dockerImage: "public.example/task-v1.1",
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    storageMb: 8192,
    gpus: 0,
    networkMode: "no-network",
    buildTimeoutMs: 30_000,
    timeoutMs: 60_000,
  },
  verifier: {
    environmentMode: "separate",
    networkMode: "no-network",
    timeoutMs: 30_000,
    buildTimeoutMs: 30_000,
    cpus: 1,
    memoryMb: 2048,
    storageMb: 4096,
  },
};

function loadedTask(id: string): LoadedTask {
  return {
    version: 1,
    id,
    title: id,
    promptFile: "instruction.md",
    prompt: `Implement ${id}.`,
    directory: `/private/tasks/${id}`,
    graderDirectory: `/private/tasks/${id}/tests`,
    grader: { command: ["true"] },
    execution: { ...execution, externalId: `external-${id}` },
  };
}

function dryOptions(
  backend: "docker" | "modal",
  outputRoot: string,
  smoke = false,
  conditions: BenchmarkOptions["conditions"] = ["regular-code", "outline-only", "callgraph-only", "skeleton-only", "all-outline-aids"],
): BenchmarkOptions {
  return {
    repo: "",
    deepSweCheckout: "/unused/pinned-deepswe",
    taskIds: ["task-a", "task-b"],
    runs: smoke ? 1 : 3,
    smoke,
    conditions,
    provider: "openai-codex",
    model: "fixed",
    timeoutMs: 60_000,
    dryRun: true,
    keepWorkspaces: false,
    outputRoot,
    tasksRoot: "/unused/tasks",
    backend,
    concurrency: backend === "modal" ? 4 : 1,
    modal: { appName: "mapbench-tests", region: "us-east-1" },
    pricingMode: "off",
    debugUsage: false,
    seed: "backend-parity",
  };
}

test("Modal Sandbox creation maps pinned images, limits, networking, placement, and freshness", async () => {
  const creates: Array<{ app: unknown; image: unknown; options: Record<string, unknown> }> = [];
  let nextId = 0;
  const client = {
    apps: { fromName: async (name: string, options: unknown) => ({ name, options }) },
    images: { fromRegistry: (tag: string) => ({ tag }) },
    sandboxes: {
      create: async (app: unknown, image: unknown, options: Record<string, unknown>) => {
        creates.push({ app, image, options });
        nextId += 1;
        return { sandboxId: `sb-${nextId}` };
      },
    },
    version: () => "0.9.0",
    close() {},
  };
  const runtime = new ModalSandboxRuntime(
    { appName: "mapbench-tests", environment: "staging", cloud: "aws", region: "us-east-1" },
    client as never,
  );
  const spec: ModalSandboxSpec = {
    image: execution.environment.dockerImage,
    resources: execution.environment,
    timeoutMs: execution.environment.timeoutMs,
    name: "run-one",
    tags: { mapbench: "agent" },
  };
  const first = await runtime.create(spec);
  const second = await runtime.create({ ...spec, name: "run-two" });
  assert.notEqual(first.sandboxId, second.sandboxId);
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].image, { tag: execution.environment.dockerImage });
  assert.deepEqual(creates[0].options, {
    cpu: 2,
    cpuLimit: 2,
    memoryMiB: 4096,
    memoryLimitMiB: 4096,
    timeoutMs: 60_000,
    workdir: "/app",
    blockNetwork: true,
    name: "run-one",
    tags: { mapbench: "agent" },
    cloud: "aws",
    regions: ["us-east-1"],
  });
});

test("Modal Pi shell bridge synchronizes source and selected treatment bidirectionally", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-transport-"));
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-remote-"));
  try {
    await Promise.all([
      fs.mkdir(path.join(root, ".mapbench"), { recursive: true }),
      fs.mkdir(path.join(remoteRoot, "app"), { recursive: true }),
      fs.mkdir(path.join(remoteRoot, "tmp"), { recursive: true }),
    ]);
    await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(root, ".mapbench", "architecture.md"), "selected treatment\n");
    const sandbox = new LocalSandbox(remoteRoot, "sb-transport");
    const firstExit = await runSynchronizedModalCommand(
      sandbox as unknown as Sandbox,
      root,
      30_000,
      "printf 'export const value = 2;\\n' > source.ts && printf 'remote build\\n' > generated.txt",
    );
    assert.equal(firstExit, 0);
    assert.equal(await fs.readFile(path.join(root, "source.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await fs.readFile(path.join(root, "generated.txt"), "utf8"), "remote build\n");

    await fs.writeFile(path.join(root, ".mapbench", "architecture.md"), "updated treatment\n");
    let output = "";
    const secondExit = await runSynchronizedModalCommand(
      sandbox as unknown as Sandbox,
      root,
      30_000,
      "cat .mapbench/architecture.md",
      (data) => { output += data.toString("utf8"); },
    );
    assert.equal(secondExit, 0);
    assert.equal(output, "updated treatment\n");
    assert.equal(await fs.readFile(path.join(remoteRoot, "app", ".mapbench", "architecture.md"), "utf8"), "updated treatment\n");
    await assert.rejects(fs.stat(path.join(remoteRoot, "tests")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(remoteRoot, { recursive: true, force: true });
  }
});

test("Modal agent and verifier use separate no-network sandboxes and hide verifier files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-boundary-"));
  const runtime = new LocalModalRuntime();
  try {
    const workspace = path.join(root, "workspace");
    const tests = path.join(root, "tests");
    const output = path.join(root, "output");
    const patch = path.join(root, "model.patch");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(tests, { recursive: true });
    await fs.writeFile(path.join(workspace, "source.ts"), "export const fixed = true;\n");
    await fs.writeFile(patch, "diff --git a/source.ts b/source.ts\n+fixed\n");
    await fs.writeFile(path.join(tests, "Dockerfile"), [
      `FROM ${execution.environment.dockerImage}`,
      "COPY test.sh /tests/test.sh",
      "COPY test.patch /tests/test.patch",
      "COPY grader.py /tests/grader.py",
      "COPY config.json /tests/config.json",
      "RUN chmod +x /tests/test.sh",
      "",
    ].join("\n"));
    await Promise.all([
      fs.writeFile(path.join(tests, "test.sh"), "#!/bin/sh\n"),
      fs.writeFile(path.join(tests, "test.patch"), "hidden patch\n"),
      fs.writeFile(path.join(tests, "grader.py"), "# hidden grader\n"),
      fs.writeFile(path.join(tests, "config.json"), "{}\n"),
    ]);

    const backend = new ModalExecutionBackend(runtime.settings, 2, runtime as unknown as ModalSandboxRuntime);
    const agent = await backend.startAgentSandbox(execution, workspace, "task-run-condition");
    const agentSandbox = runtime.sandboxes[0];
    await assert.rejects(fs.stat(path.join(agentSandbox.root, "tests")));
    await agent.stop();

    const result = await runDeepSweVerifier({
      workspace,
      tests,
      output,
      patch,
      image: execution.environment.dockerImage,
      cpus: execution.verifier.cpus,
      memoryMb: execution.verifier.memoryMb,
      storageMb: execution.verifier.storageMb,
      timeoutMs: execution.verifier.timeoutMs,
      backend: "modal",
    }, runtime as unknown as ModalSandboxRuntime);
    assert.equal(result.passed, true);
    assert.equal(runtime.sandboxes.length, 2);
    assert.notEqual(runtime.sandboxes[0].sandboxId, runtime.sandboxes[1].sandboxId);
    assert.deepEqual(runtime.specs.map((spec) => spec.tags.mapbench), ["agent", "verifier"]);
    assert.equal(runtime.sandboxes[0].terminated, 1);
    assert.equal(runtime.sandboxes[1].terminated, 1);
    assert.equal(runtime.sandboxes[1].copiedIn.includes("/tests/grader.py"), true);
    assert.equal(runtime.sandboxes[0].copiedIn.includes("/tests/grader.py"), false);
    assert.equal((result.executionBackend as { kind: string }).kind, "modal");
  } finally {
    await Promise.all(runtime.sandboxes.map((sandbox) => fs.rm(sandbox.root, { recursive: true, force: true })));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Docker and Modal verifiers emit equivalent normalized outcomes for the same patch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-parity-"));
  const runtime = new LocalModalRuntime();
  try {
    const workspace = path.join(root, "workspace");
    const tests = path.join(root, "tests");
    const patch = path.join(root, "model.patch");
    const dockerOutput = path.join(root, "docker-output");
    const modalOutput = path.join(root, "modal-output");
    const docker = path.join(root, "fake-docker.ts");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(tests, { recursive: true }),
    ]);
    await fs.writeFile(patch, "diff --git a/source.ts b/source.ts\n+fixed\n");
    await fs.writeFile(path.join(tests, "Dockerfile"), [
      `FROM ${execution.environment.dockerImage}`,
      "COPY test.sh /tests/test.sh",
      "COPY test.patch /tests/test.patch",
      "COPY grader.py /tests/grader.py",
      "COPY config.json /tests/config.json",
      "RUN chmod +x /tests/test.sh",
      "",
    ].join("\n"));
    await Promise.all([
      fs.writeFile(path.join(tests, "test.sh"), "#!/bin/sh\n"),
      fs.writeFile(path.join(tests, "test.patch"), "hidden patch\n"),
      fs.writeFile(path.join(tests, "grader.py"), "# hidden grader\n"),
      fs.writeFile(path.join(tests, "config.json"), "{}\n"),
      fs.writeFile(docker, `#!/usr/bin/env bun
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "build") {
  console.log("verifier-image");
  process.exit(0);
}
if (args[0] === "run") {
  const mount = args[args.indexOf("--mount") + 1];
  const prefix = "type=bind,source=";
  const suffix = ",target=/logs";
  if (!mount.startsWith(prefix) || !mount.endsWith(suffix)) process.exit(3);
  const logs = mount.slice(prefix.length, -suffix.length);
  const patchFile = path.join(logs, "artifacts", "model.patch");
  const passed = existsSync(patchFile) && statSync(patchFile).size > 0;
  const verifier = path.join(logs, "verifier");
  mkdirSync(verifier, { recursive: true });
  writeFileSync(path.join(verifier, "reward.json"), JSON.stringify({
    reward: passed ? 1 : 0,
    f2p_total: 1,
    f2p_passed: passed ? 1 : 0,
    p2p_total: 1,
    p2p_passed: 1,
    f2p: passed ? 1 : 0,
    p2p: 1,
    partial: passed ? 1 : 0.5,
  }));
  writeFileSync(path.join(verifier, "ctrf.json"), JSON.stringify({ results: { tests: [] } }));
  console.log(passed ? "verified" : "empty patch");
  process.exit(0);
}
process.exit(4);
`),
    ]);
    await fs.chmod(docker, 0o755);
    const common = {
      workspace,
      tests,
      patch,
      image: execution.environment.dockerImage,
      cpus: execution.verifier.cpus,
      memoryMb: execution.verifier.memoryMb,
      storageMb: execution.verifier.storageMb,
      timeoutMs: execution.verifier.timeoutMs,
    };
    const dockerResult = await runDeepSweVerifier({ ...common, output: dockerOutput, backend: "docker", docker });
    const modalResult = await runDeepSweVerifier(
      { ...common, output: modalOutput, backend: "modal" },
      runtime as unknown as ModalSandboxRuntime,
    );
    const normalized = (result: Record<string, unknown>) => ({
      score: result.score,
      maxScore: result.maxScore,
      passed: result.passed,
      reward: result.reward,
      verifierArtifacts: result.verifierArtifacts,
    });
    assert.deepEqual(normalized(modalResult), normalized(dockerResult));
    assert.equal((dockerResult.executionBackend as { kind: string }).kind, "docker");
    assert.equal((modalResult.executionBackend as { kind: string }).kind, "modal");
  } finally {
    await Promise.all(runtime.sandboxes.map((sandbox) => fs.rm(sandbox.root, { recursive: true, force: true })));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Modal backend terminates an allocated sandbox when workspace upload fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-cleanup-"));
  const runtime = new LocalModalRuntime();
  runtime.failNextUpload = true;
  try {
    await fs.writeFile(path.join(root, "source.ts"), "source\n");
    const backend = new ModalExecutionBackend(runtime.settings, 2, runtime as unknown as ModalSandboxRuntime);
    await assert.rejects(backend.startAgentSandbox(execution, root, "failure"), /injected upload failure/);
    assert.equal(runtime.sandboxes.length, 1);
    assert.equal(runtime.sandboxes[0].terminated, 1);
  } finally {
    await Promise.all(runtime.sandboxes.map((sandbox) => fs.rm(sandbox.root, { recursive: true, force: true })));
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("Modal agent cleanup retries transient termination failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-retry-"));
  const runtime = new LocalModalRuntime();
  try {
    await fs.writeFile(path.join(root, "source.ts"), "source\n");
    const backend = new ModalExecutionBackend(runtime.settings, 1, runtime as unknown as ModalSandboxRuntime);
    const agent = await backend.startAgentSandbox(execution, root, "retry");
    const sandbox = runtime.sandboxes[0];
    sandbox.terminateFailures = 1;
    await agent.stop();
    assert.equal(sandbox.terminated, 1);
    await agent.stop();
    assert.equal(sandbox.terminated, 1);
  } finally {
    await Promise.all(runtime.sandboxes.map((sandbox) => fs.rm(sandbox.root, { recursive: true, force: true })));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Docker and Modal dry plans preserve treatment, task pairing, and task-centric grouping", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-modal-plan-"));
  try {
    const tasks = [loadedTask("task-a"), loadedTask("task-b")];
    const docker = await runBenchmark(dryOptions("docker", root), tasks);
    const modal = await runBenchmark(dryOptions("modal", root), tasks);
    assert.equal(docker.plan.length, 30);
    assert.equal(modal.plan.length, 30);
    assert.deepEqual(
      modal.plan.map(({ backend: _backend, workspace: _workspace, ...item }) => item),
      docker.plan.map(({ backend: _backend, workspace: _workspace, ...item }) => item),
    );
    assert.equal(modal.plan.every((item) => item.backend === "modal"), true);
    const pairCounts = new Map<string, number>();
    const cellCounts = new Map<string, number>();
    for (const item of modal.plan) {
      pairCounts.set(item.pairId, (pairCounts.get(item.pairId) ?? 0) + 1);
      const cell = `${item.taskId}:${item.condition}`;
      cellCounts.set(cell, (cellCounts.get(cell) ?? 0) + 1);
    }
    assert.equal([...pairCounts.values()].every((count) => count === 5), true);

    assert.equal([...cellCounts.values()].every((count) => count === 3), true);
    assert.equal(await fs.stat(modal.resultsRoot).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("smoke plans one repetition per selected condition and supports explicit factorial", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-smoke-plan-"));
  try {
    const task = loadedTask("task-a");
    const targeted = await runBenchmark({ ...dryOptions("modal", root, true), taskIds: ["task-a"] }, [task]);
    assert.equal(targeted.plan.length, 5);
    assert.equal(new Set(targeted.plan.map((item) => item.condition)).size, 5);
    assert.equal(new Set(targeted.plan.map((item) => item.run)).size, 1);
    const factorial = await runBenchmark(
      { ...dryOptions("modal", root, true, ["regular-code", "outline-only", "skeleton-only", "callgraph-only", "outline-skeleton", "outline-callgraph", "skeleton-callgraph", "all-outline-aids"]), taskIds: ["task-a"] },
      [task],
    );
    assert.equal(factorial.plan.length, 8);
    assert.equal(new Set(factorial.plan.map((item) => item.condition)).size, 8);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("benchmark repetition validation preserves normal three-run mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-repetition-validation-"));
  try {
    await assert.rejects(
      runBenchmark({ ...dryOptions("modal", root), runs: 1 }, [loadedTask("task-a")]),
      /Benchmark repetitions are fixed at 3/,
    );
    await assert.rejects(
      runBenchmark({ ...dryOptions("modal", root, true), runs: 3 }, [loadedTask("task-a")]),
      /Smoke benchmarks require exactly 1 repetition/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Modal concurrency limiter bounds independent work and retains plan order", async () => {
  let active = 0;
  let maximum = 0;
  const gate = Promise.withResolvers<void>();
  const saturated = Promise.withResolvers<void>();
  const pending = mapConcurrent([0, 1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    if (maximum === 3) saturated.resolve();
    await gate.promise;
    active -= 1;
    return value * 2;
  });
  await saturated.promise;
  assert.equal(maximum, 3);
  gate.resolve();
  assert.deepEqual(await pending, [0, 2, 4, 6, 8, 10, 12]);
});

test("Modal concurrency waits for successful peers before surfacing an isolated failure", async () => {
  const bothStarted = Promise.withResolvers<void>();
  let started = 0;
  let peerFinished = false;
  const pending = mapConcurrent(["failure", "peer"], 2, async (value) => {
    started += 1;
    if (started === 2) bothStarted.resolve();
    await bothStarted.promise;
    if (value === "failure") throw new Error("injected cell failure");
    await Promise.resolve();
    peerFinished = true;
    return value;
  });
  await assert.rejects(pending, /injected cell failure/);
  assert.equal(peerFinished, true);
});
