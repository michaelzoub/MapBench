import { promises as fs } from "node:fs";
import path from "node:path";
import { createArchitectureSummary } from "./architecture.js";
import { createCallGraph } from "./callgraph.js";
import { detectProject } from "./detection.js";
import {
  assertOutputIsManaged,
  assertOutputPathHasNoSymlinks,
  listFiles,
  removeEmptyDirectories,
} from "./files.js";
import { createOutlineInstructions, outputReference } from "./instructions.js";
import { createArchitectureMermaid } from "./mermaid.js";
import { createProjectContext } from "./project.js";
import { parsePythonProject } from "./python.js";
import { createEmbeddedQueryScript } from "./query.js";
import { outlineSourceFile } from "./transform.js";
import type { CallGraph, GenerationResult, OutlineOptions } from "./types.js";

function combineCallGraphs(graphs: readonly CallGraph[]): CallGraph {
  const combined: CallGraph = {};
  graphs.forEach((graph) => {
    for (const [id, entry] of Object.entries(graph)) {
      if (combined[id]) throw new Error(`Duplicate call graph symbol: ${id}`);
      combined[id] = {
        ...entry,
        calledBy: [],
      };
    }
  });
  for (const [caller, entry] of Object.entries(combined)) {
    for (const callee of entry.calls) combined[callee]?.calledBy.push(caller);
  }
  for (const entry of Object.values(combined)) entry.calledBy.sort();
  return Object.fromEntries(Object.entries(combined).sort(([left], [right]) => left.localeCompare(right)));
}

export async function generateOutline(options: OutlineOptions = {}): Promise<GenerationResult> {
  const detected = await detectProject(options);
  await assertOutputPathHasNoSymlinks(detected.root, detected.out);
  await assertOutputIsManaged(detected.out, detected.root);

  const generated = new Map<string, string>();
  const graphs: CallGraph[] = [];
  if (detected.languages.includes("typescript")) {
    const context = await createProjectContext(options, detected.files.typescript);
    const graph = createCallGraph(context);
    for (const fileName of context.fileNames) {
      const sourceFile = context.program.getSourceFile(fileName);
      if (!sourceFile) continue;
      const destination = path.join(context.out, path.relative(context.root, fileName));
      generated.set(destination, outlineSourceFile(sourceFile, context, graph));
    }
    graphs.push(graph);
  }
  if (detected.languages.includes("python")) {
    const parsed = await parsePythonProject(detected.root, detected.files.python);
    for (const [relative, contents] of Object.entries(parsed.outlines)) {
      generated.set(path.join(detected.out, relative), contents);
    }
    graphs.push(parsed.callgraph);
  }
  const graph = combineCallGraphs(graphs);
  generated.set(path.join(detected.out, "architecture.md"), createArchitectureSummary(graph));
  generated.set(path.join(detected.out, "architecture.mmd"), createArchitectureMermaid(graph));
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
