import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateOutline } from "../src/generate.js";
import { MANAGED_SECTION_END, MANAGED_SECTION_START } from "../src/instructions.js";
import { runProcess } from "./process.js";
import { CONDITION_FACTORS, type Condition } from "./types.js";

export const COMPONENTS: Record<Condition, { skeleton: boolean; callgraph: boolean; architecture: boolean }> = {
  "regular-code": { skeleton: false, callgraph: false, architecture: false },
  "outline-only": { skeleton: false, callgraph: false, architecture: true },
  "skeleton-only": { skeleton: true, callgraph: false, architecture: false },
  "callgraph-only": { skeleton: false, callgraph: true, architecture: false },
  "outline-skeleton": { skeleton: true, callgraph: false, architecture: true },
  "outline-callgraph": { skeleton: false, callgraph: true, architecture: true },
  "skeleton-callgraph": { skeleton: true, callgraph: true, architecture: false },
  "all-outline-aids": { skeleton: true, callgraph: true, architecture: true },
};

for (const condition of Object.keys(COMPONENTS) as Condition[]) {
  const factors = CONDITION_FACTORS[condition];
  const components = COMPONENTS[condition];
  if (components.architecture !== factors.outline || components.skeleton !== factors.skeleton || components.callgraph !== factors.callgraph) {
    throw new Error(`Condition component mapping drifted for ${condition}.`);
  }
}

export function conditionInstructions(condition: Condition): string {
  const components = COMPONENTS[condition];
  const lines = ["Work from the complete real repository source, which remains available for inspection."];
  if (components.architecture) lines.push("- Read `.mapbench/architecture.md` for the deterministic hierarchical architecture view.");
  if (components.skeleton) lines.push("- Read `.mapbench/skeleton/` for language-native declarations, signatures, and structural relationship comments without implementation bodies.");
  if (components.callgraph) lines.push("- Use the `mapbench_query` tool for deterministic source-anchored call-graph queries.");
  if (!components.architecture && !components.skeleton && !components.callgraph) lines.push("No additional generated repository reference is provided.");
  lines.push("Verify conclusions in the real source when implementation behavior matters.");
  return lines.join("\n");
}

async function copySkeletons(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, { recursive: true });
  for (const name of ["architecture.md", "architecture.mmd", "callgraph.json", "query.mjs", "AGENTS.md"]) {
    await fs.rm(path.join(destination, name), { force: true, recursive: true });
  }
}

export interface PreparedCondition {
  callgraphHelper: string | null;
}

export async function prepareCondition(workspace: string, condition: Condition, privateDirectory?: string): Promise<PreparedCondition> {
  await Promise.all([".cartograph", ".project-outline", ".mapbench", ".mapbench-private", ".mapbench-cartograph-analysis"]
    .map((name) => fs.rm(path.join(workspace, name), { recursive: true, force: true })));
  const internal = path.join(workspace, ".mapbench-cartograph");
  await fs.rm(internal, { recursive: true, force: true });
  if (condition === "regular-code") return { callgraphHelper: null };

  await generateOutline({ root: workspace, out: ".mapbench-cartograph" });
  const components = COMPONENTS[condition];
  const mapbench = path.join(workspace, ".mapbench");
  if (components.architecture || components.skeleton) await fs.mkdir(mapbench, { recursive: true });
  if (components.architecture) await fs.copyFile(path.join(internal, "architecture.md"), path.join(mapbench, "architecture.md"));
  if (components.skeleton) await copySkeletons(internal, path.join(mapbench, "skeleton"));
  let callgraphHelper: string | null = null;
  if (components.callgraph) {
    if (!privateDirectory) throw new Error(`Condition ${condition} requires a private treatment directory.`);
    await fs.mkdir(privateDirectory, { recursive: true });
    await Promise.all([
      fs.copyFile(path.join(internal, "callgraph.json"), path.join(privateDirectory, "callgraph.json")),
      fs.copyFile(path.join(internal, "query.mjs"), path.join(privateDirectory, "query.mjs")),
    ]);
    callgraphHelper = path.join(privateDirectory, "query.mjs");
  }
  await fs.rm(internal, { recursive: true, force: true });
  return { callgraphHelper };
}

async function git(workspace: string, args: string[]): Promise<string> {
  const result = await runProcess(["git", ...args], { cwd: workspace, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function removeManagedCartographGuidance(workspace: string): Promise<void> {
  const agents = path.join(workspace, "AGENTS.md");
  let contents: string;
  try { contents = await fs.readFile(agents, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let sanitized = contents;
  while (sanitized.includes(MANAGED_SECTION_START) || sanitized.includes(MANAGED_SECTION_END)) {
    const start = sanitized.indexOf(MANAGED_SECTION_START);
    const end = sanitized.indexOf(MANAGED_SECTION_END);
    if (start === -1 || end < start) throw new Error("Target AGENTS.md contains malformed Cartograph guidance markers.");
    const after = end + MANAGED_SECTION_END.length;
    sanitized = `${sanitized.slice(0, start)}${sanitized.slice(after)}`;
  }
  if (sanitized === contents) return;
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n").trim();
  if (sanitized) await fs.writeFile(agents, `${sanitized}\n`, "utf8");
  else await fs.rm(agents, { force: true });
}

export async function resolveCommit(repo: string): Promise<string> {
  return await git(path.resolve(repo), ["rev-parse", "HEAD"]);
}

export async function createWorkspace(repo: string, commit: string, label: string, parent?: string): Promise<string> {
  const root = parent ?? await fs.mkdtemp(path.join(os.tmpdir(), "mapbench-"));
  await fs.mkdir(root, { recursive: true });
  const workspace = path.join(root, label.replace(/[^a-zA-Z0-9_.-]/g, "-"));
  const cloned = await runProcess(["git", "clone", "--quiet", "--no-checkout", path.resolve(repo), workspace], { cwd: root, timeoutMs: 120_000 });
  if (cloned.exitCode !== 0) throw new Error(`Unable to clone target repository: ${cloned.stderr}`);
  await git(workspace, ["checkout", "--quiet", "--detach", commit]);
  const actual = await git(workspace, ["rev-parse", "HEAD"]);
  if (actual !== commit) throw new Error(`Workspace commit ${actual} does not match target commit.`);
  // The original object database can retain removed private tasks and generated
  // artifacts. Reinitialize before any benchmark baseline is committed.
  await fs.rm(path.join(workspace, ".git"), { recursive: true, force: true });
  const initialized = await runProcess(["git", "init", "--quiet"], { cwd: workspace, timeoutMs: 120_000 });
  if (initialized.exitCode !== 0) throw new Error(`Unable to initialize sanitized benchmark repository: ${initialized.stderr}`);
  await removeManagedCartographGuidance(workspace);
  return workspace;
}
async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const executable = process.env.MAPBENCH_DOCKER ?? "docker";
  const result = await runProcess([executable, ...args], { cwd: process.cwd(), timeoutMs });
  if (result.exitCode !== 0) throw new Error(`docker ${args[0] ?? ""} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function ensureDockerImage(image: string): Promise<void> {
  const executable = process.env.MAPBENCH_DOCKER ?? "docker";
  const inspected = await runProcess([executable, "image", "inspect", image], { cwd: process.cwd(), timeoutMs: 120_000 });
  if (inspected.exitCode === 0) return;
  const pulled = await runProcess([executable, "pull", image], { cwd: process.cwd(), timeoutMs: 1_800_000 });
  if (pulled.exitCode !== 0) throw new Error(`Unable to pull DeepSWE environment image ${image}: ${pulled.stderr || pulled.stdout}`);
}
export async function sanitizeImageWorkspace(workspace: string, expectedCommit: string): Promise<void> {
  const actual = await git(workspace, ["rev-parse", "HEAD"]);
  if (!actual.startsWith(expectedCommit)) {
    throw new Error(`DeepSWE environment commit mismatch: expected ${expectedCommit}, found ${actual}.`);
  }
  await fs.rm(path.join(workspace, ".git"), { recursive: true, force: true });
  const initialized = await runProcess(["git", "init", "--quiet"], { cwd: workspace, timeoutMs: 120_000 });
  if (initialized.exitCode !== 0) throw new Error(`Unable to initialize sanitized DeepSWE workspace: ${initialized.stderr}`);
  await removeManagedCartographGuidance(workspace);
}


export async function createDockerImageWorkspace(
  image: string,
  expectedCommit: string,
  label: string,
  parent: string,
): Promise<string> {
  await ensureDockerImage(image);
  await fs.mkdir(parent, { recursive: true });
  const workspace = path.join(parent, label.replace(/[^a-zA-Z0-9_.-]/g, "-"));
  await fs.mkdir(workspace, { recursive: false });
  const container = await docker(["create", image]);
  if (!container) throw new Error(`Unable to create a container from ${image}.`);
  try {
    await docker(["cp", `${container}:/app/.`, workspace], 1_800_000);
  } finally {
    await docker(["rm", "--force", container]).catch(() => undefined);
  }
  await sanitizeImageWorkspace(workspace, expectedCommit);
  return workspace;
}

export async function startDockerWorkspace(
  image: string,
  workspace: string,
  resources: { cpus: number; memoryMb: number; storageMb: number; gpus: number },
): Promise<string> {
  const args = [
    "create", "--network", "none", "--workdir", "/app",
    "--cpus", String(resources.cpus), "--memory", `${resources.memoryMb}m`,
    "--mount", `type=bind,source=${path.resolve(workspace)},target=/app`,
  ];
  if (resources.gpus > 0) args.push("--gpus", String(resources.gpus));
  args.push(image, "/bin/sh", "-c", "while :; do sleep 3600; done");
  const container = await docker(args);
  if (!container) throw new Error("Unable to create the DeepSWE agent sandbox.");
  try {
    await docker(["start", container]);
    return container;
  } catch (error) {
    await docker(["rm", "--force", container]).catch(() => undefined);
    throw error;
  }
}

export async function removeDockerWorkspace(container: string): Promise<void> {
  await docker(["exec", container, "chmod", "-R", "a+rwX", "/app"], 300_000).catch(() => undefined);
  await docker(["rm", "--force", container]).catch(() => undefined);
}

export async function removePrivateTaskFromWorkspace(workspace: string, repo: string, taskDirectory: string): Promise<string | null> {
  const relative = path.relative(path.resolve(repo), path.resolve(taskDirectory));
  if (relative === "" || relative === ".") throw new Error("A custom eval task directory cannot be the repository root.");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const target = path.resolve(workspace, relative);
  const workspaceRoot = `${path.resolve(workspace)}${path.sep}`;
  if (!target.startsWith(workspaceRoot)) throw new Error("Refusing to remove a private task path outside the benchmark workspace.");
  await fs.rm(target, { recursive: true, force: true });
  return relative.split(path.sep).join("/");
}

export async function commitBaseline(workspace: string): Promise<string> {
  await git(workspace, ["config", "user.name", "MapBench"]);
  await git(workspace, ["config", "user.email", "mapbench@invalid.local"]);
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "--quiet", "--allow-empty", "-m", "MapBench condition baseline"]);
  return await git(workspace, ["rev-parse", "HEAD"]);
}

export async function resolveTreeHash(workspace: string, revision = "HEAD"): Promise<string> {
  return await git(workspace, ["rev-parse", `${revision}^{tree}`]);
}

export async function captureChanges(workspace: string, baselineCommit: string): Promise<{ patch: string; files: string[] }> {
  await git(workspace, ["add", "--intent-to-add", "-A"]);
  const patchResult = await runProcess(["git", "diff", "--binary", baselineCommit], { cwd: workspace, timeoutMs: 120_000 });
  const filesResult = await runProcess(["git", "diff", "--name-only", baselineCommit], { cwd: workspace, timeoutMs: 120_000 });
  if (patchResult.exitCode !== 0 || filesResult.exitCode !== 0) throw new Error("Unable to capture workspace changes.");
  return { patch: patchResult.stdout, files: filesResult.stdout.split(/\r?\n/).filter(Boolean).sort() };
}

export async function assertGraderOutsideWorkspace(workspace: string, graderDirectory: string): Promise<void> {
  const relative = path.relative(path.resolve(workspace), path.resolve(graderDirectory));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("Private grader must remain outside the Pi workspace.");
}
