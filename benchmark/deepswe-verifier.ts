#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  downloadDirectoryFromModal,
  execModalCommand,
  modalOptionsFromEnvironment,
  ModalSandboxRuntime,
} from "./modal-sandbox.js";
import { runProcess } from "./process.js";

export interface VerifierOptions {
  workspace: string;
  tests: string;
  output: string;
  patch: string;
  cpus: number;
  memoryMb: number;
  storageMb: number;
  image: string;
  timeoutMs: number;
  docker?: string;
  backend?: "docker" | "modal";
}

interface DeepSweReward {
  reward: number;
  f2p_total?: number;
  f2p_passed?: number;
  p2p_total?: number;
  p2p_passed?: number;
  f2p?: number;
  p2p?: number;
  partial?: number;
  apply_failed?: number;
}

function parseReward(value: unknown): DeepSweReward {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reward.json must contain an object.");
  const record = value as Record<string, unknown>;
  if (record.reward !== 0 && record.reward !== 1) throw new Error("reward must be 0 or 1.");
  const reward: DeepSweReward = { reward: record.reward };
  for (const field of ["f2p_total", "f2p_passed", "p2p_total", "p2p_passed", "f2p", "p2p", "partial", "apply_failed"] as const) {
    const entry = record[field];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) throw new Error(`${field} must be a finite number.`);
    if (typeof entry === "number") reward[field] = entry;
  }
  return reward;
}

async function checkedFile(file: string, label: string): Promise<void> {
  const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Missing DeepSWE ${label}: ${file}`);
    throw error;
  });
  if (!stat.isFile()) throw new Error(`DeepSWE ${label} is not a file: ${file}`);
}

function lastLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

async function validateVerifierDockerfile(tests: string, image: string): Promise<void> {
  const lines = (await fs.readFile(path.join(tests, "Dockerfile"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const expected = [
    `FROM ${image}`,
    "COPY test.sh /tests/test.sh",
    "COPY test.patch /tests/test.patch",
    "COPY grader.py /tests/grader.py",
    "COPY config.json /tests/config.json",
    "RUN chmod +x /tests/test.sh",
  ];
  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    throw new Error("DeepSWE Modal verification requires the pinned v1.1 tests/Dockerfile layout.");
  }
}

async function runDockerVerifier(options: VerifierOptions, workspace: string, tests: string, output: string): Promise<{ output: string; metadata: Record<string, unknown> }> {
  const docker = options.docker ?? process.env.MAPBENCH_DOCKER ?? "docker";
  const build = await runProcess([docker, "build", "--quiet", tests], { cwd: tests, timeoutMs: 1_800_000 });
  if (build.exitCode !== 0) throw new Error(`Unable to build the DeepSWE verifier image: ${build.stderr || build.stdout}`);
  const verifierImage = lastLine(build.stdout);
  if (!verifierImage) throw new Error("DeepSWE verifier build returned no image ID.");
  const verify = await runProcess([
    docker, "run", "--rm", "--network", "none",
    "--cpus", String(options.cpus), "--memory", `${options.memoryMb}m`,
    "--mount", `type=bind,source=${output},target=/logs`,
    verifierImage, "/tests/test.sh",
  ], { cwd: workspace, timeoutMs: options.timeoutMs });
  return {
    output: [verify.stdout, verify.stderr].filter(Boolean).join("\n"),
    metadata: {
      kind: "docker",
      runtime: "docker-engine",
      taskImage: options.image,
      verifierImage,
      networkMode: "no-network",
      cpus: options.cpus,
      memoryMb: options.memoryMb,
      storageMb: options.storageMb,
    },
  };
}

async function runModalVerifier(options: VerifierOptions, tests: string, output: string, providedRuntime?: ModalSandboxRuntime): Promise<{ output: string; metadata: Record<string, unknown> }> {
  const runtime = providedRuntime ?? new ModalSandboxRuntime(modalOptionsFromEnvironment());
  let sandbox;
  try {
    sandbox = await runtime.create({
      image: options.image,
      resources: { cpus: options.cpus, memoryMb: options.memoryMb, storageMb: options.storageMb, gpus: 0 },
      timeoutMs: Math.min(24 * 60 * 60 * 1000, options.timeoutMs + 300_000),
      name: `mapbench-verifier-${process.pid}-${Date.now()}`.slice(0, 64),
      tags: { mapbench: "verifier" },
    });
    const setup = await execModalCommand(sandbox, ["mkdir", "-p", "/tests", "/logs/artifacts", "/logs/verifier"], 120_000);
    if (setup.exitCode !== 0) throw new Error(`Unable to initialize Modal verifier directories: ${setup.stderr || setup.stdout}`);
    await Promise.all([
      sandbox.filesystem.copyFromLocal(path.join(tests, "test.sh"), "/tests/test.sh"),
      sandbox.filesystem.copyFromLocal(path.join(tests, "test.patch"), "/tests/test.patch"),
      sandbox.filesystem.copyFromLocal(path.join(tests, "grader.py"), "/tests/grader.py"),
      sandbox.filesystem.copyFromLocal(path.join(tests, "config.json"), "/tests/config.json"),
      sandbox.filesystem.copyFromLocal(path.resolve(options.patch), "/logs/artifacts/model.patch"),
    ]);
    const chmod = await execModalCommand(sandbox, ["chmod", "+x", "/tests/test.sh"], 120_000);
    if (chmod.exitCode !== 0) throw new Error(`Unable to prepare Modal verifier: ${chmod.stderr || chmod.stdout}`);
    const verify = await execModalCommand(sandbox, ["/tests/test.sh"], options.timeoutMs);
    await downloadDirectoryFromModal(sandbox, "/logs", output);
    return {
      output: [verify.stdout, verify.stderr].filter(Boolean).join("\n"),
      metadata: {
        kind: "modal",
        runtime: "modal-sandbox",
        runtimeVersion: runtime.runtimeVersion(),
        sandboxId: sandbox.sandboxId,
        taskImage: options.image,
        networkMode: "no-network",
        cpus: options.cpus,
        memoryMb: options.memoryMb,
        storageMb: options.storageMb,
        appName: runtime.settings.appName,
        environment: runtime.settings.environment,
        cloud: runtime.settings.cloud,
        region: runtime.settings.region,
      },
    };
  } finally {
    if (sandbox) await sandbox.terminate({ wait: true }).catch(() => undefined);
    runtime.close();
  }
}

export async function runDeepSweVerifier(options: VerifierOptions, modalRuntime?: ModalSandboxRuntime): Promise<Record<string, unknown>> {
  const workspace = path.resolve(options.workspace);
  const tests = path.resolve(options.tests);
  const output = path.resolve(options.output);
  await Promise.all([
    checkedFile(path.join(tests, "Dockerfile"), "tests/Dockerfile"),
    checkedFile(path.join(tests, "test.sh"), "tests/test.sh"),
    checkedFile(path.join(tests, "grader.py"), "tests/grader.py"),
    checkedFile(path.join(tests, "config.json"), "tests/config.json"),
    checkedFile(path.join(tests, "test.patch"), "tests/test.patch"),
    checkedFile(path.resolve(options.patch), "model.patch"),
  ]);
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, "artifacts"), { recursive: true });
  await fs.mkdir(path.join(output, "verifier"), { recursive: true });
  await fs.copyFile(path.resolve(options.patch), path.join(output, "artifacts", "model.patch"));

  const backend = options.backend ?? (process.env.MAPBENCH_EXECUTION_BACKEND === "modal" ? "modal" : "docker");
  const verified = backend === "modal"
    ? await runModalVerifier(options, tests, output, modalRuntime)
    : await runDockerVerifier(options, workspace, tests, output);
  await fs.mkdir(path.join(output, "verifier"), { recursive: true });
  await fs.writeFile(path.join(output, "verifier", "test-stdout.txt"), verified.output, "utf8");

  const rewardFile = path.join(output, "verifier", "reward.json");
  let reward: DeepSweReward;
  try {
    reward = parseReward(JSON.parse(await fs.readFile(rewardFile, "utf8")));
  } catch (error) {
    throw new Error(`DeepSWE verifier produced no valid reward.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = (await fs.readdir(path.join(output, "verifier"))).sort();
  return {
    score: reward.reward,
    maxScore: 1,
    passed: reward.reward === 1,
    reward,
    verifierArtifacts: files,
    executionBackend: verified.metadata,
  };
}

function parseArgs(args: string[]): VerifierOptions {
  const values = new Map<string, string>();
  const allowed = new Set(["--workspace", "--tests", "--output", "--patch", "--cpus", "--memory-mb", "--storage-mb", "--image", "--timeout-ms"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || !value) throw new Error(`Invalid DeepSWE verifier option: ${flag ?? "<missing>"}`);
    values.set(flag, value);
  }
  const workspace = values.get("--workspace");
  const tests = values.get("--tests");
  const output = values.get("--output");
  const patch = values.get("--patch");
  const image = values.get("--image");
  const cpus = Number(values.get("--cpus"));
  const memoryMb = Number(values.get("--memory-mb"));
  const storageMb = Number(values.get("--storage-mb"));
  const timeoutMs = Number(values.get("--timeout-ms"));
  if (!workspace || !tests || !output || !patch || !image || !Number.isFinite(cpus) || cpus <= 0 || !Number.isFinite(memoryMb) || memoryMb <= 0 || !Number.isFinite(storageMb) || storageMb <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DeepSWE verifier requires workspace, tests, output, patch, image, timeout, CPU, memory, and storage options.");
  }
  return { workspace, tests, output, patch, image, cpus, memoryMb, storageMb, timeoutMs };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runDeepSweVerifier(parseArgs(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }, (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ score: 0, maxScore: 1, passed: false, configurationError: message })}\n`);
    process.exitCode = 1;
  });
}
