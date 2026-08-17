import { realpath } from "node:fs/promises";
import path from "node:path";

const PRIVATE_SEGMENTS = new Set([
  ".git",
  ".cartograph",
  ".project-outline",
  ".mapbench-private",
  ".mapbench-cartograph",
  ".mapbench-cartograph-analysis",
]);

export function relativeInsideWorkspace(root: string, candidate: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative === ".") return "";
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("MapBench tools may only access the benchmark workspace.");
  }
  if (relative.split(path.sep).some((segment) => PRIVATE_SEGMENTS.has(segment))) {
    throw new Error("That path is private to the MapBench harness.");
  }
  return relative;
}

export async function assertWorkspacePath(root: string, input = "."): Promise<void> {
  const logicalRoot = path.resolve(root);
  const absolute = path.resolve(logicalRoot, input);
  relativeInsideWorkspace(logicalRoot, absolute);
  const resolvedRoot = await realpath(logicalRoot);
  const resolved = await realpath(absolute);
  relativeInsideWorkspace(resolvedRoot, resolved);
}
export async function assertWorkspaceOutputPath(root: string, input: string): Promise<void> {
  const logicalRoot = path.resolve(root);
  const absolute = path.resolve(logicalRoot, input);
  relativeInsideWorkspace(logicalRoot, absolute);
  const resolvedRoot = await realpath(logicalRoot);
  let ancestor = absolute;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      relativeInsideWorkspace(resolvedRoot, resolved);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}


export function assertWorkspacePattern(pattern: string, label: string): void {
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must remain inside the workspace.`);
  }
}
