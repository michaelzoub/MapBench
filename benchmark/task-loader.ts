import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { LoadedTask, TaskManifest } from "./types.js";

export function resolveBundledTasksRoot(moduleDirectory: string): string {
  const packaged = path.resolve(moduleDirectory, "tasks");
  return existsSync(packaged) ? packaged : path.resolve(moduleDirectory, "../tasks");
}

function validateCommand(value: unknown, field: string): void {
  if (!value || typeof value !== "object" || !Array.isArray((value as { command?: unknown }).command) ||
      !(value as { command: unknown[] }).command.every((item) => typeof item === "string")) {
    throw new Error(`${field}.command must be an array of strings.`);
  }
}

export async function loadTask(tasksRoot: string, id: string): Promise<LoadedTask> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid task id: ${id}`);
  const directory = path.resolve(tasksRoot, id);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "task.json"), "utf8")) as TaskManifest;
  if (manifest.version !== 1 || manifest.id !== id || !manifest.title || !manifest.promptFile) {
    throw new Error(`Invalid task manifest for ${id}.`);
  }
  validateCommand(manifest.grader, "grader");
  for (const [name, spec] of Object.entries(manifest.checks ?? {})) validateCommand(spec, `checks.${name}`);
  const prompt = (await fs.readFile(path.join(directory, manifest.promptFile), "utf8")).trim();
  if (!prompt) throw new Error(`Task ${id} has an empty prompt.`);
  const graderDirectory = path.join(directory, "grader");
  const entries = await fs.readdir(graderDirectory);
  if (entries.length === 0) throw new Error(`Task ${id} has no private grader files.`);
  return { ...manifest, directory, prompt, graderDirectory };
}

export async function listTasks(tasksRoot: string): Promise<string[]> {
  const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
  const tasks: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      try {
        if ((await fs.stat(path.join(tasksRoot, entry.name, "task.json"))).isFile()) tasks.push(entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return tasks.sort();
}

export function expandCommand(command: string[], workspace: string, grader: string, answer = "", events = ""): string[] {
  return command.map((part) => part
    .replaceAll("{workspace}", workspace)
    .replaceAll("{grader}", grader)
    .replaceAll("{sharedGraders}", path.resolve(import.meta.dirname, "graders"))
    .replaceAll("{answer}", answer)
    .replaceAll("{events}", events));
}
