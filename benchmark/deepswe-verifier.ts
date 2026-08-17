#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runProcess } from "./process.js";

interface VerifierOptions {
  workspace: string;
  tests: string;
  output: string;
  patch: string;
  cpus: number;
  memoryMb: number;
  docker?: string;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reward.json must contain an object.");
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (record.reward !== 0 && record.reward !== 1) throw new Error("reward must be 0 or 1.");
  const reward: DeepSweReward = { reward: record.reward };
  for (const field of ["f2p_total", "f2p_passed", "p2p_total", "p2p_passed", "f2p", "p2p", "partial", "apply_failed"] as const) {
    const entry = record[field];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) {
      throw new Error(`${field} must be a finite number.`);
    }
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

export async function runDeepSweVerifier(options: VerifierOptions): Promise<Record<string, unknown>> {
  const workspace = path.resolve(options.workspace);
  const tests = path.resolve(options.tests);
  const output = path.resolve(options.output);
  const docker = options.docker ?? process.env.MAPBENCH_DOCKER ?? "docker";
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

  const build = await runProcess([docker, "build", "--quiet", tests], {
    cwd: tests,
    timeoutMs: 1_800_000,
  });
  if (build.exitCode !== 0) throw new Error(`Unable to build the DeepSWE verifier image: ${build.stderr || build.stdout}`);
  const verifierImage = lastLine(build.stdout);
  if (!verifierImage) throw new Error("DeepSWE verifier build returned no image ID.");

  const verify = await runProcess([
    docker, "run", "--rm", "--network", "none",
    "--cpus", String(options.cpus), "--memory", `${options.memoryMb}m`,
    "--mount", `type=bind,source=${output},target=/logs`,
    verifierImage, "/tests/test.sh",
  ], {
    cwd: workspace,
    timeoutMs: 1_800_000,
  });
  const verifierOutput = [verify.stdout, verify.stderr].filter(Boolean).join("\n");
  await fs.writeFile(path.join(output, "verifier", "test-stdout.txt"), verifierOutput, "utf8");

  const rewardFile = path.join(output, "verifier", "reward.json");
  let reward: DeepSweReward;
  try {
    reward = parseReward(JSON.parse(await fs.readFile(rewardFile, "utf8")));
  } catch (error) {
    throw new Error(`DeepSWE verifier produced no valid reward.json (exit ${String(verify.exitCode)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = (await fs.readdir(path.join(output, "verifier"))).sort();
  return {
    score: reward.reward,
    maxScore: 1,
    passed: reward.reward === 1,
    reward,
    verifierArtifacts: files,
  };
}

function parseArgs(args: string[]): VerifierOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--workspace", "--tests", "--output", "--patch", "--cpus", "--memory-mb"].includes(flag) || !value) throw new Error(`Invalid DeepSWE verifier option: ${flag ?? "<missing>"}`);
    values.set(flag, value);
  }
  const workspace = values.get("--workspace");
  const tests = values.get("--tests");
  const output = values.get("--output");
  const patch = values.get("--patch");
  const cpus = Number(values.get("--cpus"));
  const memoryMb = Number(values.get("--memory-mb"));
  if (!workspace || !tests || !output || !patch || !Number.isFinite(cpus) || cpus <= 0 || !Number.isFinite(memoryMb) || memoryMb <= 0) {
    throw new Error("DeepSWE verifier requires --workspace, --tests, --output, --patch, --cpus, and --memory-mb.");
  }
  return { workspace, tests, output, patch, cpus, memoryMb };
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
