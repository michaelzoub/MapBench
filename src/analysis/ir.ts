import path from "node:path";
import type { DetectedProject } from "../detection.js";
import type { CallGraph, CallGraphEntry } from "../types.js";
import { createLinkedCallGraph } from "./linker.js";
import type {
  NormalizedProject,
  ParsedFile,
  StructuralEdge,
  StructuralEdgeType,
  StructuralIR,
  StructuralManifest,
  StructuralResolution,
  StructuralSymbol,
  StructuralUnresolved,
} from "./types.js";
import { compare } from "./utils.js";

export const STRUCTURAL_SCHEMA_VERSION = 1;
export const TOOL_NAME = "cartograph";

function moduleId(file: string): string {
  return `${file}#<module>`;
}

function moduleTarget(origin: ParsedFile, source: string, files: Map<string, ParsedFile>): ParsedFile | undefined {
  const candidates = new Set<string>();
  if (origin.language === "typescript" || origin.language === "javascript") {
    if (source.startsWith(".")) candidates.add(path.posix.normalize(path.posix.join(path.posix.dirname(origin.file), source)));
    else if (source.startsWith("@/")) candidates.add(`src/${source.slice(2)}`);
  } else if (origin.language === "python") {
    const dots = source.match(/^\.+/)?.[0].length ?? 0;
    const tail = source.slice(dots).replace(/\./g, "/");
    let directory = path.posix.dirname(origin.file);
    for (let index = 1; index < dots; index += 1) directory = path.posix.dirname(directory);
    candidates.add(path.posix.join(dots ? directory : "", tail));
  } else if (origin.language === "rust") {
    const parts = source.split("::").filter((item) => !["crate", "self", "super"].includes(item));
    if (source.startsWith("crate::") || source.startsWith("self::") || source.startsWith("super::")) {
      candidates.add(`src/${parts.slice(0, -1).join("/")}`);
    }
  } else if (origin.language === "go") {
    const suffix = source.split("/").filter(Boolean).at(-1);
    if (suffix) {
      for (const file of files.values()) if (file.language === "go" && path.posix.basename(path.posix.dirname(file.file)) === suffix) return file;
    }
  }
  for (const candidate of candidates) {
    const clean = candidate.replace(/\.(?:[cm]?[jt]sx?|py|go|rs)$/, "").replace(/\/(?:index|mod)$/, "");
    const direct = [...files.values()].find((file) => {
      const stem = file.file.replace(/\.(?:[cm]?[jt]sx?|py|go|rs)$/, "").replace(/\/(?:index|mod)$/, "");
      return stem === clean || file.file.replace(/\.(?:[cm]?[jt]sx?|py|go|rs)$/, "") === candidate;
    });
    if (direct) return direct;
  }
  return undefined;
}

function locationFor(symbol: StructuralSymbol | undefined, fallback: ParsedFile): { file: string; line: number; column: number } {
  return symbol
    ? { file: symbol.file, line: symbol.startLine, column: symbol.startColumn }
    : { file: fallback.file, line: 1, column: 1 };
}

function edgeId(type: StructuralEdgeType, source: string, target: string | undefined, file: string, line: number, column: number, order: number): string {
  return [type, source, target ?? "?", file, line, column, order].join(":");
}

function addEdge(
  edges: StructuralEdge[],
  unresolved: StructuralUnresolved[],
  edge: Omit<StructuralEdge, "id">,
): void {
  const complete = { ...edge, id: edgeId(edge.type, edge.source, edge.target ?? edge.targetLabel, edge.file, edge.line, edge.column, edge.sourceOrder ?? 0) };
  edges.push(complete);
  if (edge.resolution === "unresolved" || edge.resolution === "ambiguous") {
    unresolved.push({
      source: edge.source,
      type: edge.type,
      text: edge.targetLabel ?? edge.target ?? "",
      file: edge.file,
      line: edge.line,
      column: edge.column,
      sourceOrder: edge.sourceOrder,
      reason: edge.provenance,
    });
  }
}

function referenceLocation(file: ParsedFile, source: string, kind: string, text: string, used: Set<number>): { line: number; column: number; order: number } {
  const candidate = file.references.find((item) => item.sourceSymbol === source && item.kind === kind && item.text === text && !used.has(item.order))
    ?? file.references.find((item) => item.sourceSymbol === source && item.kind === kind && !used.has(item.order));
  if (!candidate) return { line: 1, column: 1, order: 0 };
  used.add(candidate.order);
  return { line: candidate.line, column: candidate.column, order: candidate.order };
}

export function createStructuralIR(
  project: NormalizedProject,
  options: { detected?: DetectedProject; gitCommit?: string; filesSkipped?: string[] } = {},
): StructuralIR {
  const graph = createLinkedCallGraph(project);
  const files = new Map(project.files.map((file) => [file.file, file]));
  const nodes: StructuralSymbol[] = project.files.flatMap((file) => [{
    id: moduleId(file.file),
    name: path.posix.basename(file.file),
    qualifiedName: moduleId(file.file),
    kind: "module" as const,
    file: file.file,
    startLine: 1,
    startColumn: 1,
    endLine: Math.max(1, file.source.split("\n").length),
    endColumn: 1,
    startByte: 0,
    endByte: Buffer.byteLength(file.source, "utf8"),
    signature: `module ${file.file}`,
    exported: true,
    visibility: "public" as const,
  }, ...file.symbols.map((symbol) => ({
    ...symbol,
    visibility: symbol.exported ? "public" as const : symbol.name.startsWith("_") ? "private" as const : "unknown" as const,
  }))]).sort((left, right) => compare(left.id, right.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: StructuralEdge[] = [];
  const unresolved: StructuralUnresolved[] = [];
  const usedReferences = new Set<number>();

  for (const file of project.files) {
    for (const [sourceOrder, binding] of file.imports.entries()) {
      const targetFile = moduleTarget(file, binding.source, files);
      const source = moduleId(file.file);
      const target = targetFile ? moduleId(targetFile.file) : undefined;
      const location = { file: file.file, line: 1, column: 1, sourceOrder };
      addEdge(edges, unresolved, {
        type: "import", source, target, targetLabel: target ? undefined : binding.source,
        ...location, resolution: target ? "resolved" : "external", provenance: target ? "module-resolution" : "unresolved-module",
      });
    }
  }
  for (const [source, entry] of Object.entries(graph).sort(([left], [right]) => compare(left, right))) {
    const file = files.get(entry.file);
    if (!file) continue;
    const sourceSymbol = byId.get(source);
    const orderedCalls = entry.callsInSourceOrder ?? entry.calls;
    for (const [order, target] of orderedCalls.entries()) {
      const location = referenceLocation(file, source, "call", target.split("#").at(-1) ?? target, usedReferences);
      addEdge(edges, unresolved, {
        type: "call", source, target, file: file.file, line: location.line, column: location.column, sourceOrder: order,
        resolution: "resolved", provenance: "tree-sitter-reference/name-resolution",
      });
    }
    for (const [order, target] of (entry.instantiates ?? []).entries()) {
      const location = referenceLocation(file, source, "construct", target.split("#").at(-1) ?? target, usedReferences);
      addEdge(edges, unresolved, {
        type: "instantiate", source, target, file: file.file, line: location.line, column: location.column, sourceOrder: order,
        resolution: "resolved", provenance: "tree-sitter-reference/name-resolution",
      });
    }
    for (const [order, text] of (entry.externalCalls ?? []).entries()) {
      const location = referenceLocation(file, source, "call", text.split("#").at(-1) ?? text, usedReferences);
      addEdge(edges, unresolved, {
        type: "call", source, targetLabel: text, file: file.file, line: location.line, column: location.column, sourceOrder: order,
        resolution: "external", provenance: "imported or external API",
      });
    }
    for (const [order, text] of (entry.unresolvedProjectCalls ?? []).entries()) {
      const location = referenceLocation(file, source, "call", text, usedReferences);
      addEdge(edges, unresolved, {
        type: "call", source, targetLabel: text, file: file.file, line: location.line, column: location.column, sourceOrder: order,
        resolution: "unresolved", provenance: "dynamic, callback, or ambiguous resolution",
      });
    }
  }

  for (const reference of project.references.filter((item) => item.kind === "inherit")) {
    const source = reference.sourceSymbol;
    if (!source) continue;
    const target = nodes.find((node) => node.kind !== "module" && node.name === reference.text && node.file === reference.file)
      ?? nodes.find((node) => node.kind !== "module" && node.name === reference.text);
    const type = target?.kind === "interface" || target?.kind === "trait" ? "implement" : "inherit";
    addEdge(edges, unresolved, {
      type, source, target: target?.id, targetLabel: target ? undefined : reference.text, file: reference.file,
      line: reference.line, column: reference.column, sourceOrder: reference.order,
      resolution: target ? "resolved" : "unresolved", provenance: target ? "heritage-clause/name-resolution" : "unresolved heritage target",
    });
  }

  edges.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || compare(left.id, right.id));
  unresolved.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || compare(left.text, right.text));
  const filesScanned = options.detected
    ? options.detected.languages.flatMap((language) => options.detected!.files[language].map((file) => path.relative(project.root, file).split(path.sep).join("/")))
    : [...files.keys()];
  const manifest: StructuralManifest = {
    tool: TOOL_NAME,
    schemaVersion: STRUCTURAL_SCHEMA_VERSION,
    toolVersion: "0.1.0",
    ...(options.gitCommit ? { gitCommit: options.gitCommit } : {}),
    languages: options.detected?.languages ?? [...new Set(project.files.map((file) => file.language))].sort(),
    filesScanned: [...new Set([...filesScanned, ...project.parseFailures.map((failure) => failure.file)])].sort(compare),
    filesSkipped: [...(options.filesSkipped ?? [])].sort(compare),
    parseFailures: project.parseFailures,
    symbolCount: nodes.filter((node) => node.kind !== "module").length,
    edgeCount: edges.length,
    unresolvedCount: unresolved.length,
  };
  return { nodes, edges, unresolved, manifest };
}

export function createCallGraphFromIR(ir: StructuralIR): CallGraph {
  const graph: CallGraph = {};
  for (const node of ir.nodes.filter((candidate) => candidate.kind !== "module")) {
    const outgoing = ir.edges.filter((edge) => edge.source === node.id && edge.resolution === "resolved");
    const calls = outgoing.filter((edge) => edge.type === "call" && edge.target).map((edge) => edge.target!);
    const instantiates = outgoing.filter((edge) => edge.type === "instantiate" && edge.target).map((edge) => edge.target!);
    const unresolvedProjectCalls = ir.edges.filter((edge) => edge.source === node.id && edge.type === "call" && edge.resolution === "unresolved").map((edge) => edge.targetLabel!).filter(Boolean);
    const externalCalls = ir.edges.filter((edge) => edge.source === node.id && edge.type === "call" && edge.resolution === "external").map((edge) => edge.targetLabel!).filter(Boolean);
    const callsInSourceOrder = [...outgoing]
      .filter((edge) => edge.type === "call" && edge.target)
      .sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0))
      .map((edge) => edge.target!);
    graph[node.id] = {
      file: node.file, line: node.startLine, column: node.startColumn, endLine: node.endLine, endColumn: node.endColumn,
      startByte: node.startByte, endByte: node.endByte, kind: node.kind as CallGraphEntry["kind"], signature: node.signature ?? `${node.kind} ${node.name}`,
      calls: [...new Set(calls)].sort(compare),
      ...(callsInSourceOrder.join("\0") !== [...new Set(calls)].sort(compare).join("\0") ? { callsInSourceOrder } : {}),
      calledBy: [], ...(instantiates.length ? { instantiates: [...new Set(instantiates)].sort(compare) } : {}),
      ...(unresolvedProjectCalls.length ? { unresolvedProjectCalls: [...new Set(unresolvedProjectCalls)].sort(compare) } : {}),
      ...(externalCalls.length ? { externalCalls: [...new Set(externalCalls)].sort(compare) } : {}),
    };
  }
  for (const [source, entry] of Object.entries(graph)) for (const target of entry.calls) if (graph[target] && !graph[target].calledBy.includes(source)) graph[target].calledBy.push(source);
  for (const entry of Object.values(graph)) entry.calledBy.sort(compare);
  return graph;
}

export function createStructuralIRFromDetected(
  project: NormalizedProject,
  detected: DetectedProject,
  options: { gitCommit?: string; filesSkipped?: string[] } = {},
): StructuralIR {
  return createStructuralIR(project, { ...options, detected });
}
