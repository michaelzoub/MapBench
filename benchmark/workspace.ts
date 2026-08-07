import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateOutline } from "../src/generate.js";
import { MANAGED_SECTION_END, MANAGED_SECTION_START } from "../src/instructions.js";
import { runProcess } from "./process.js";
import { CONDITION_FACTORS, type Condition } from "./types.js";

export const COMPONENTS: Record<Condition, { skeleton: boolean; callgraph: boolean; architecture: boolean; rootAgents: boolean }> = {
  "regular-code": { skeleton: false, callgraph: false, architecture: false, rootAgents: false },
  "outline-only": { skeleton: false, callgraph: false, architecture: true, rootAgents: true },
  "skeleton-only": { skeleton: true, callgraph: false, architecture: false, rootAgents: true },
  "callgraph-only": { skeleton: false, callgraph: true, architecture: false, rootAgents: true },
  "outline-skeleton": { skeleton: true, callgraph: false, architecture: true, rootAgents: true },
  "outline-callgraph": { skeleton: false, callgraph: true, architecture: true, rootAgents: true },
  "skeleton-callgraph": { skeleton: true, callgraph: true, architecture: false, rootAgents: true },
  "all-outline-aids": { skeleton: true, callgraph: true, architecture: true, rootAgents: true },
};

for (const condition of Object.keys(COMPONENTS) as Condition[]) {
  const factors = CONDITION_FACTORS[condition];
  const components = COMPONENTS[condition];
  const hasGeneratedComponent = factors.outline || factors.skeleton || factors.callgraph;
  if (components.architecture !== factors.outline || components.rootAgents !== hasGeneratedComponent || components.skeleton !== factors.skeleton ||
      components.callgraph !== factors.callgraph) {
    throw new Error(`Condition component mapping drifted for ${condition}.`);
  }
}

function rootSection(condition: Condition): string {
  const refs: string[] = [];
  if (COMPONENTS[condition].skeleton) refs.push("- `.project-outline/` for declarations and signatures");
  if (COMPONENTS[condition].architecture) refs.push("- `.project-outline/architecture.md` for the module map and representative execution chains");
  if (COMPONENTS[condition].callgraph) refs.push("- `.project-outline/callgraph.json` for symbol relationships");
  if (COMPONENTS[condition].callgraph) refs.push("- `node .project-outline/query.mjs \"<symbol>\"` for compact symbol queries");
  return `${MANAGED_SECTION_START}\n## Project Outline\n\nAvailable generated benchmark resources:\n\n${refs.join("\n")}\n\nThis managed section only announces the generated artifact paths; it supplies no navigation strategy.\n${MANAGED_SECTION_END}`;
}

async function stripManagedRootSection(workspace: string): Promise<void> {
  const file = path.join(workspace, "AGENTS.md");
  let contents: string;
  try { contents = await fs.readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const start = contents.indexOf(MANAGED_SECTION_START);
  const end = contents.indexOf(MANAGED_SECTION_END);
  if (start === -1 && end === -1) return;
  if (start === -1 || end < start) throw new Error(`Malformed managed project-outline section in ${file}`);
  const next = `${contents.slice(0, start).trimEnd()}\n${contents.slice(end + MANAGED_SECTION_END.length).trimStart()}`.trim();
  if (next) await fs.writeFile(file, `${next}\n`, "utf8");
  else await fs.rm(file);
}

export async function prepareCondition(workspace: string, condition: Condition): Promise<void> {
  await stripManagedRootSection(workspace);
  await fs.rm(path.join(workspace, ".project-outline"), { recursive: true, force: true });
  if (condition === "regular-code") return;
  await generateOutline({ root: workspace });
  const components = COMPONENTS[condition];
  if (!components.skeleton) {
    const outline = path.join(workspace, ".project-outline");
    for (const entry of await fs.readdir(outline)) {
      if (entry !== "architecture.md" && entry !== "callgraph.json" && entry !== "query.mjs" && entry !== "AGENTS.md") {
        await fs.rm(path.join(outline, entry), { recursive: true, force: true });
      }
    }
  }
  if (!components.callgraph) {
    await fs.rm(path.join(workspace, ".project-outline", "callgraph.json"), { force: true });
    await fs.rm(path.join(workspace, ".project-outline", "query.mjs"), { force: true });
  }
  if (!components.architecture) await fs.rm(path.join(workspace, ".project-outline", "architecture.md"), { force: true });
  // Mermaid is the human visualization, not one of the agent benchmark treatments.
  await fs.rm(path.join(workspace, ".project-outline", "architecture.mmd"), { force: true });
  await fs.rm(path.join(workspace, ".project-outline", "AGENTS.md"), { force: true });
  if (components.rootAgents) {
    const file = path.join(workspace, "AGENTS.md");
    let existing = "";
    try { existing = await fs.readFile(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.writeFile(file, `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${rootSection(condition)}\n`, "utf8");
  }
}

async function git(workspace: string, args: string[]): Promise<string> {
  const result = await runProcess(["git", ...args], { cwd: workspace, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function resolveCommit(repo: string): Promise<string> {
  return await git(path.resolve(repo), ["rev-parse", "HEAD"]);
}

export async function createWorkspace(repo: string, commit: string, label: string, parent?: string): Promise<string> {
  const root = parent ?? await fs.mkdtemp(path.join(os.tmpdir(), "project-outline-benchmark-"));
  await fs.mkdir(root, { recursive: true });
  const workspace = path.join(root, label.replace(/[^a-zA-Z0-9_.-]/g, "-"));
  const cloned = await runProcess(["git", "clone", "--quiet", "--no-checkout", path.resolve(repo), workspace], { cwd: root, timeoutMs: 120_000 });
  if (cloned.exitCode !== 0) throw new Error(`Unable to clone target repository: ${cloned.stderr}`);
  await git(workspace, ["checkout", "--quiet", "--detach", commit]);
  const actual = await git(workspace, ["rev-parse", "HEAD"]);
  if (actual !== commit) throw new Error(`Workspace commit ${actual} does not match target ${commit}.`);
  return workspace;
}

export async function removePrivateTaskFromWorkspace(workspace: string, repo: string, taskDirectory: string): Promise<string | null> {
  const relative = path.relative(path.resolve(repo), path.resolve(taskDirectory));
  if (relative === "" || relative === ".") {
    throw new Error("A custom eval task directory cannot be the repository root.");
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const target = path.resolve(workspace, relative);
  const workspaceRoot = `${path.resolve(workspace)}${path.sep}`;
  if (!target.startsWith(workspaceRoot)) throw new Error("Refusing to remove a private task path outside the benchmark workspace.");
  await fs.rm(target, { recursive: true, force: true });
  return relative.split(path.sep).join("/");
}

export async function commitBaseline(workspace: string): Promise<string> {
  await git(workspace, ["config", "user.name", "project-outline benchmark"]);
  await git(workspace, ["config", "user.email", "benchmark@invalid.local"]);
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "--quiet", "--allow-empty", "-m", "benchmark condition baseline"]);
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
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Private grader must remain outside the Codex workspace.");
  }
}
