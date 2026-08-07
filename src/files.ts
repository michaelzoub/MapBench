import { promises as fs } from "node:fs";
import path from "node:path";
import { isManagedOutlineInstructions, outputReference } from "./instructions.js";
import { isManagedEmbeddedQueryScript } from "./query.js";
import { ARCHITECTURE_HEADER } from "./architecture.js";
import { MERMAID_HEADER } from "./mermaid.js";

export const GENERATED_HEADER = "// @ts-nocheck";
export const PYTHON_GENERATED_HEADER = "# @project-outline generated";

export const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".idea",
  ".next",
  ".nuxt",
  ".output",
  ".project-outline",
  ".project-outline-evals",
  ".turbo",
  ".vscode",
  "build",
  "ci",
  "coverage",
  "deploy",
  "deployment",
  "dist",
  "docker",
  "generated",
  "infra",
  "infrastructure",
  "migrations",
  "node_modules",
  "out",
  "public",
  "scripts",
  "target",
  "tools",
  "vendor",
]);

const EXCLUDED_FILE_PATTERNS = [
  /(?:^|\.)config\.(?:[cm]?[jt]s|[jt]sx)$/i,
  /(?:^|\.)generated\.(?:[cm]?[jt]s|[jt]sx)$/i,
  /(?:^|\.)(?:spec|test)\.(?:[cm]?[jt]s|[jt]sx)$/i,
  /\.d\.(?:ts|tsx)$/i,
];

const PYTHON_EXCLUDED_FILE_PATTERNS = [
  /^(?:config|settings)\.py$/i,
  /^conftest\.py$/i,
  /^setup\.py$/i,
  /^test_.+\.py$/i,
  /_test\.py$/i,
  /(?:^|[._-])generated(?:[._-]|$)/i,
];

export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isMeaningfulTypeScriptFile(fileName: string, root: string, out: string): boolean {
  const absolute = path.resolve(fileName);
  if (!isInside(root, absolute) || isInside(out, absolute)) return false;

  const relative = path.relative(root, absolute);
  const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return false;

  const baseName = path.basename(absolute);
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(baseName)) return false;
  return !EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(baseName));
}

export function isMeaningfulPythonFile(fileName: string, root: string, out: string): boolean {
  const absolute = path.resolve(fileName);
  if (!isInside(root, absolute) || isInside(out, absolute)) return false;
  const relative = path.relative(root, absolute);
  const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return false;
  const baseName = path.basename(absolute);
  if (path.extname(baseName).toLowerCase() !== ".py") return false;
  return !PYTHON_EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(baseName));
}

export async function discoverTypeScriptFiles(root: string, out: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    if (isInside(out, directory)) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(absolute);
      } else if (entry.isFile() && isMeaningfulTypeScriptFile(absolute, root, out)) {
        files.push(absolute);
      }
    }
  }

  await visit(root);
  return files.sort();
}

export async function discoverPythonFiles(root: string, out: string): Promise<string[]> {
  return discoverFiles(root, out, isMeaningfulPythonFile);
}

async function discoverFiles(
  root: string,
  out: string,
  predicate: (fileName: string, root: string, out: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (isInside(out, directory)) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(absolute);
      } else if (entry.isFile() && predicate(absolute, root, out)) {
        files.push(absolute);
      }
    }
  }
  await visit(root);
  return files.sort();
}

export function assertSafeOutput(root: string, out: string): void {
  if (!isInside(root, out) || path.resolve(root) === path.resolve(out)) {
    throw new Error("The output directory must be a child of the repository root.");
  }
}

export async function assertOutputPathHasNoSymlinks(root: string, out: string): Promise<void> {
  let current = path.resolve(root);
  for (const segment of path.relative(root, out).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`The output path must not contain symbolic links: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to modify output containing a symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }

  await visit(directory);
  return files.sort();
}

function isCallGraph(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    const stringArray = (items: unknown): boolean =>
      Array.isArray(items) && items.every((item) => typeof item === "string");
    const common = (
      typeof candidate.file === "string" &&
      typeof candidate.line === "number" && Number.isInteger(candidate.line) && candidate.line > 0 &&
      (candidate.kind === "function" || candidate.kind === "method" || candidate.kind === "constructor") &&
      typeof candidate.signature === "string" &&
      stringArray(candidate.calls) && stringArray(candidate.calledBy)
    );
    const optionalStringArray = (items: unknown): boolean => items === undefined || stringArray(items);
    const current = typeof candidate.column === "number" && Number.isInteger(candidate.column) && candidate.column > 0 &&
      [candidate.instantiates, candidate.unresolvedProjectCalls, candidate.externalCalls].every(optionalStringArray) &&
      (candidate.callsInSourceOrder === undefined || stringArray(candidate.callsInSourceOrder));
    // Accept the previous format so a generation can safely replace its own managed output.
    const legacy = stringArray(candidate.constructs) && stringArray(candidate.unresolvedCalls) &&
      (candidate.callSequence === undefined || stringArray(candidate.callSequence));
    return common && (current || legacy);
  });
}

export async function assertOutputIsManaged(out: string, root = path.dirname(out)): Promise<void> {
  for (const fileName of await listFiles(out)) {
    const relative = path.relative(out, fileName).split(path.sep).join("/");
    const contents = await fs.readFile(fileName, "utf8");
    let managed = false;
    if (relative === "query.mjs") managed = isManagedEmbeddedQueryScript(contents);
    else if (relative === "architecture.md") managed = contents.startsWith(ARCHITECTURE_HEADER);
    else if (relative === "architecture.mmd") managed = contents.startsWith(MERMAID_HEADER);
    else if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(fileName)) managed = contents.startsWith(GENERATED_HEADER);
    else if (path.extname(fileName).toLowerCase() === ".py") managed = contents.startsWith(PYTHON_GENERATED_HEADER);
    else if (relative === "AGENTS.md") managed = isManagedOutlineInstructions(contents, outputReference(root, out));
    else if (relative === "callgraph.json") {
      try {
        managed = isCallGraph(JSON.parse(contents));
      } catch {
        managed = false;
      }
    }
    if (!managed) {
      throw new Error(`Refusing to modify output containing an unmanaged file: ${fileName}`);
    }
  }
}

export async function removeEmptyDirectories(directory: string, keepRoot = true): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name), false);
  }

  if (!keepRoot && (await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
}
