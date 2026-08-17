import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createArchitectureSummary } from "./architecture.js";
import { createCallGraphFromIR, createStructuralIRFromDetected } from "./analysis/ir.js";
import { parseProject } from "./analysis/parser.js";
import { createSkeleton } from "./analysis/skeleton.js";
import { detectProject } from "./detection.js";
import {
  assertOutputIsManaged,
  assertOutputPathHasNoSymlinks,
  listFiles,
  removeEmptyDirectories,
} from "./files.js";
import { createOutlineInstructions, outputReference } from "./instructions.js";
import { createArchitectureMermaid } from "./mermaid.js";
import { createEmbeddedQueryScript } from "./query.js";
import type { GenerationResult, OutlineOptions } from "./types.js";

const execFileAsync = promisify(execFile);

async function currentGitCommit(root: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
export async function generateOutline(options: OutlineOptions = {}): Promise<GenerationResult> {
  const detected = await detectProject(options);
  await assertOutputPathHasNoSymlinks(detected.root, detected.out);
  await assertOutputIsManaged(detected.out, detected.root);

  const generated = new Map<string, string>();
  const project = await parseProject(detected);
  const ir = createStructuralIRFromDetected(project, detected, { gitCommit: await currentGitCommit(detected.root) });
  const graph = createCallGraphFromIR(ir);
  for (const file of project.files) {
    generated.set(path.join(detected.out, file.file), createSkeleton(file, ir));
  }
  generated.set(path.join(detected.out, "architecture.md"), createArchitectureSummary(ir));
  generated.set(path.join(detected.out, "architecture.mmd"), createArchitectureMermaid(ir));
  generated.set(path.join(detected.out, "callgraph.json"), `${JSON.stringify(graph, null, 2)}\n`);
  generated.set(path.join(detected.out, "query.mjs"), createEmbeddedQueryScript());
  generated.set(
    path.join(detected.out, "AGENTS.md"),
    createOutlineInstructions(outputReference(detected.root, detected.out)),
  );

  const previousFiles = await listFiles(detected.out);
  const staleFiles = previousFiles.filter((fileName) => !generated.has(fileName));
  for (const fileName of staleFiles) await fs.unlink(fileName);

  for (const [fileName, contents] of [...generated.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    await fs.mkdir(path.dirname(fileName), { recursive: true });
    await fs.writeFile(fileName, contents, "utf8");
  }
  await removeEmptyDirectories(detected.out);

  return {
    root: detected.root,
    out: detected.out,
    filesWritten: generated.size,
    staleFilesRemoved: staleFiles.length,
    languages: detected.languages,
  };
}
