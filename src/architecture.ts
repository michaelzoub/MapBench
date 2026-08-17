import type { CallGraph } from "./types.js";
import type { StructuralEdge, StructuralIR, StructuralSymbol } from "./analysis/types.js";

export const ARCHITECTURE_HEADER = "<!-- @cartograph generated -->";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bounded(lines: readonly string[], limit: number, label: string): string[] {
  if (lines.length <= limit) return [...lines];
  return [...lines.slice(0, limit), `- … ${lines.length - limit} additional ${label} omitted; query the graph CLI for detail.`];
}

function isCallable(node: StructuralSymbol): boolean {
  return node.kind === "function" || node.kind === "method" || node.kind === "constructor";
}


function legacyIR(graph: CallGraph): StructuralIR {
  const nodes = Object.entries(graph).map(([id, entry]) => ({
    id,
    name: id.split("#").at(-1) ?? id,
    qualifiedName: id.split("#").at(-1) ?? id,
    kind: entry.kind,
    file: entry.file,
    startLine: entry.line,
    startColumn: entry.column,
    endLine: entry.endLine,
    endColumn: entry.endColumn,
    startByte: entry.startByte,
    endByte: entry.endByte,
    signature: entry.signature,
    exported: false,
    visibility: "unknown" as const,
  }));
  const edges: StructuralEdge[] = [];
  for (const [source, entry] of Object.entries(graph)) {
    for (const [order, target] of (entry.callsInSourceOrder ?? entry.calls).entries()) {
      edges.push({ id: `call:${source}:${target}:${order}`, type: "call", source, target, file: entry.file, line: entry.line, column: entry.column, sourceOrder: order, resolution: "resolved", provenance: "legacy-callgraph" });
    }
    for (const target of entry.instantiates ?? []) edges.push({ id: `instantiate:${source}:${target}`, type: "instantiate", source, target, file: entry.file, line: entry.line, column: entry.column, resolution: "resolved", provenance: "legacy-callgraph" });
    for (const targetLabel of entry.externalCalls ?? []) edges.push({ id: `external:${source}:${targetLabel}`, type: "call", source, targetLabel, file: entry.file, line: entry.line, column: entry.column, resolution: "external", provenance: "legacy-callgraph" });
    for (const targetLabel of entry.unresolvedProjectCalls ?? []) edges.push({ id: `unresolved:${source}:${targetLabel}`, type: "call", source, targetLabel, file: entry.file, line: entry.line, column: entry.column, resolution: "unresolved", provenance: "legacy-callgraph" });
  }
  return {
    nodes,
    edges,
    unresolved: edges.filter((edge) => edge.resolution === "unresolved").map((edge) => ({ source: edge.source, type: edge.type, text: edge.targetLabel ?? "", file: edge.file, line: edge.line, column: edge.column, reason: edge.provenance })),
    manifest: { tool: "cartograph", schemaVersion: 1, toolVersion: "0.1.0", languages: [], filesScanned: [...new Set(nodes.map((node) => node.file))].sort(compare), filesSkipped: [], parseFailures: [], symbolCount: nodes.length, edgeCount: edges.length, unresolvedCount: edges.filter((edge) => edge.resolution === "unresolved").length },
  };
}
function asIR(input: StructuralIR | CallGraph): StructuralIR {
  if (Array.isArray((input as StructuralIR).nodes)) return input as StructuralIR;
  return legacyIR(input as CallGraph);
}

function flowLines(ir: StructuralIR): string[] {
  const nodes = new Map(ir.nodes.filter(isCallable).map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const edge of ir.edges.filter((candidate) => candidate.type === "call" && candidate.resolution === "resolved" && candidate.target)) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target!);
    outgoing.set(edge.source, list);
    incoming.set(edge.target!, (incoming.get(edge.target!) ?? 0) + 1);
  }
  const roots = [...nodes.keys()].filter((id) => !incoming.has(id) && (outgoing.get(id)?.length ?? 0)).sort(compare);
  const lines: string[] = [];
  for (const root of roots) {
    const visit = (id: string, path: string[], depth: number): void => {
      const nextPath = [...path, id];
      const next = [...new Set(outgoing.get(id) ?? [])].filter((candidate) => nodes.has(candidate) && !nextPath.includes(candidate)).sort(compare);
      if (!next.length || depth >= 8) {
        lines.push(`- ${nextPath.map((item) => `\`${item}\``).join(" → ")}`);
        return;
      }
      for (const candidate of next) visit(candidate, nextPath, depth + 1);
    };
    visit(root, [], 0);
    if (lines.length >= 40) break;
  }
  return bounded(lines, 40, "execution flows");
}

/** Create a bounded, deterministic hierarchical architecture view from the canonical IR. */
export function createArchitectureSummary(input: StructuralIR | CallGraph): string {
  const ir = asIR(input);
  const modules = ir.nodes.filter((node) => node.kind === "module").sort((left, right) => compare(left.id, right.id));
  const symbols = ir.nodes.filter((node) => node.kind !== "module").sort((left, right) => compare(left.id, right.id));
  const byComponent = new Map<string, StructuralSymbol[]>();
  for (const module of modules) {
    const component = module.file.split("/")[0] || ".";
    const list = byComponent.get(component) ?? [];
    list.push(module);
    byComponent.set(component, list);
  }
  const componentLines = [...byComponent].sort(([left], [right]) => compare(left, right)).flatMap(([component, componentModules]) => [
    `### ${component}/`,
    ...componentModules.sort((left, right) => compare(left.file, right.file)).map((module) => {
      const declarations = symbols.filter((node) => node.file === module.file);
      const exported = declarations.filter((node) => node.exported).length;
      const callableCount = declarations.filter((node) => isCallable(node)).length;
      const typeCount = declarations.length - callableCount;
      const details = [
        callableCount ? `${callableCount} callable${callableCount === 1 ? "" : "s"}` : "",
        typeCount ? `${typeCount} type declaration${typeCount === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      return `- \`${module.file}\` — ${details || "no declarations"}${exported ? `; ${exported} public` : ""}`;
    }),
  ]);
  const dependencyLines = new Map<string, Set<string>>();
  for (const edge of ir.edges.filter((candidate) => candidate.resolution === "resolved" && candidate.target)) {
    const source = ir.nodes.find((node) => node.id === edge.source);
    const target = ir.nodes.find((node) => node.id === edge.target);
    if (!source || !target || source.file === target.file) continue;
    const key = `${source.file} → ${target.file}`;
    const kinds = dependencyLines.get(key) ?? new Set<string>();
    kinds.add(edge.type);
    dependencyLines.set(key, kinds);
  }
  const dependencies = [...dependencyLines].sort(([left], [right]) => compare(left, right)).map(([pair, kinds]) => `- \`${pair}\` — ${[...kinds].sort(compare).join(", ")}`);
  const publicLines = bounded(symbols.filter((node) => node.exported).map((node) => `- \`${node.id}\` — ${node.signature ?? `${node.kind} ${node.name}`} (${node.file}:${node.startLine}:${node.startColumn})`), 100, "public surfaces");
  const externalLines = bounded(ir.edges.filter((edge) => edge.resolution === "external").map((edge) => `- \`${edge.source}\` — ${edge.type} ${edge.targetLabel ?? "external"} (${edge.file}:${edge.line}:${edge.column})`), 100, "external boundaries");
  const unresolvedLines = bounded(ir.unresolved.map((item) => `- \`${item.source ?? "unknown"}\` — ${item.type} \`${item.text}\` (${item.file}:${item.line}:${item.column})${item.reason ? ` — ${item.reason}` : ""}`), 100, "unresolved boundaries");
  const coverage = [
    `- Tool/schema: \`${ir.manifest.tool}\` / ${ir.manifest.schemaVersion}`,
    `- Languages: ${ir.manifest.languages.length ? ir.manifest.languages.join(", ") : "not recorded"}`,
    `- Files scanned: ${ir.manifest.filesScanned.length}; skipped: ${ir.manifest.filesSkipped.length}; parse failures: ${ir.manifest.parseFailures.length}`,
    `- Declarations: ${ir.manifest.symbolCount}; relationships: ${ir.manifest.edgeCount}; unresolved: ${ir.manifest.unresolvedCount}`,
    "- Known: resolved edges are parser/linker evidence anchored to source locations.",
    "- Heuristic or incomplete: exported surfaces and root flows are static indicators, not runtime registration or execution proof.",
    "- Limitations: dynamic dispatch, reflection, callbacks, dependency injection, generated code, and runtime configuration may be unresolved.",
  ];
  return `${ARCHITECTURE_HEADER}
# Architecture Index

This deterministic view is projected from one canonical structural representation. It distinguishes resolved static facts from external, heuristic, and unresolved boundaries; it does not infer runtime behavior.

## Repository / packages / services

${componentLines.length ? componentLines.join("\n") : "No packages or services were detected."}

## Major components and directories

${bounded(modules.map((module) => `- \`${module.file}\` — module`), 200, "modules").join("\n") || "No modules were detected."}

## Detected entrypoints and public surfaces

${publicLines.length ? publicLines.join("\n") : "No exported public surfaces were detected."}

## Component/module dependencies

${dependencies.length ? dependencies.join("\n") : "No resolved cross-module dependencies were detected."}

## Important execution flows

${flowLines(ir).join("\n") || "No resolved multi-symbol execution flows were detected."}

## External boundaries

${externalLines.length ? externalLines.join("\n") : "No external boundaries were detected."}

## Unresolved / dynamic boundaries

${unresolvedLines.length ? unresolvedLines.join("\n") : "No unresolved relationships were detected."}

## Analysis coverage and limitations

${coverage.join("\n")}

## Static Call Roots

Static roots are callable declarations with no resolved repository callers and at least one resolved outgoing call. They are navigation hints, not guaranteed runtime entrypoints.

${bounded(symbols.filter(isCallable).filter((node) => !ir.edges.some((edge) => edge.type === "call" && edge.resolution === "resolved" && edge.target === node.id)).filter((node) => ir.edges.some((edge) => edge.source === node.id && edge.type === "call" && edge.resolution === "resolved")).map((node) => `- \`${node.id}\` — \`${node.file}:${node.startLine}:${node.startColumn}\``), 100, "static roots").join("\n") || "No connected static roots were detected."}
`;
}
