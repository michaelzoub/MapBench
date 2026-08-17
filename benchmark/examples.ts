import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.js";

const EXAMPLES_ROOT = path.resolve(import.meta.dirname, "examples");

export async function listExamples(): Promise<string[]> {
  const entries = await fs.readdir(EXAMPLES_ROOT, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function materializeExampleRepository(name: string): Promise<{ repo: string; cleanupRoot: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid example name: ${name}`);
  const available = await listExamples();
  if (!available.includes(name)) throw new Error(`Unknown example ${name}. Available examples: ${available.join(", ")}`);
  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), `cartograph-example-${name}-`));
  const repo = path.join(cleanupRoot, name);
  await fs.cp(path.join(EXAMPLES_ROOT, name), repo, { recursive: true });
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "MapBench"],
    ["config", "user.email", "mapbench@invalid.local"],
    ["add", "-A"],
    ["commit", "--quiet", "-m", "MapBench snapshot"],
  ]) {
    const result = await runProcess(["git", ...args], { cwd: repo, timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      throw new Error(`Unable to prepare example repository: ${result.stderr || result.stdout}`);
    }
  }
  return { repo, cleanupRoot };
}
