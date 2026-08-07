import type { CallGraph } from "./types.js";

export const ARCHITECTURE_HEADER = "<!-- @project-outline generated -->";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function displayList(items: readonly string[]): string {
  return items.length ? items.map((item) => `\`${item}\``).join(", ") : "none";
}

function bounded(lines: readonly string[], limit: number, label: string): string[] {
  if (lines.length <= limit) return [...lines];
  return [...lines.slice(0, limit), `- … ${lines.length - limit} additional ${label} omitted; query the mirror for detail.`];
}

function representativeChains(graph: CallGraph, limit = 40, maxDepth = 12): string[][] {
  const roots = Object.keys(graph)
    .filter((id) => graph[id].calledBy.length === 0 && (graph[id].calls.length > 0 || (graph[id].instantiates?.length ?? 0) > 0))
    .sort(compare);
  const chains: string[][] = [];

  const visit = (id: string, path: string[]): void => {
    if (chains.length >= limit) return;
    const nextPath = [...path, id];
    const callees = (graph[id]?.callsInSourceOrder ?? graph[id]?.calls ?? []).filter((callee) => graph[callee]);
    const next = callees.filter((callee) => !nextPath.includes(callee));
    if (!next.length || nextPath.length >= maxDepth) {
      chains.push(nextPath);
      return;
    }
    for (const callee of next) visit(callee, nextPath);
  };

  for (const root of roots) visit(root, []);
  return chains;
}

/** Create a bounded, deterministic overview for architecture questions. */
export function createArchitectureSummary(graph: CallGraph): string {
  const ids = Object.keys(graph).sort(compare);
  const byFile = new Map<string, string[]>();
  for (const id of ids) {
    const symbols = byFile.get(graph[id].file) ?? [];
    symbols.push(id);
    byFile.set(graph[id].file, symbols);
  }

  const moduleLines = bounded([...byFile].sort(([left], [right]) => compare(left, right)).map(([file, symbols]) => {
    const outgoing = new Set<string>();
    const instantiatedTypes = new Set<string>();
    for (const id of symbols) {
      for (const callee of graph[id].calls) {
        const target = graph[callee]?.file;
        if (target && target !== file) outgoing.add(target);
      }
      for (const instantiated of graph[id].instantiates ?? []) instantiatedTypes.add(instantiated);
    }
    const details = [
      outgoing.size ? `calls ${displayList([...outgoing].sort(compare))}` : "",
      instantiatedTypes.size ? `instantiates ${displayList([...instantiatedTypes].sort(compare))}` : "",
    ].filter(Boolean).join("; ");
    return `- \`${file}\` — ${symbols.length} callable symbol${symbols.length === 1 ? "" : "s"}${details ? `; ${details}` : ""}`;
  }), 200, "modules");

  const roots = ids.filter((id) => graph[id].calledBy.length === 0).sort((left, right) => {
    const leftConnected = Number(graph[left].calls.length > 0 || (graph[left].instantiates?.length ?? 0) > 0);
    const rightConnected = Number(graph[right].calls.length > 0 || (graph[right].instantiates?.length ?? 0) > 0);
    return rightConnected - leftConnected || compare(left, right);
  });
  const rootLines = bounded(roots.map((id) => {
    const entry = graph[id];
    const relations = [
      entry.calls.length ? `calls ${displayList(entry.calls)}` : "",
      entry.instantiates?.length ? `instantiates ${displayList(entry.instantiates)}` : "",
    ].filter(Boolean).join("; ");
    return `- \`${id}\` — \`${entry.file}:${entry.line}:${entry.column}\`${relations ? `; ${relations}` : ""}`;
  }), 100, "root symbols");

  const chains = representativeChains(graph);
  const chainLines = chains.map((chain) => `- ${chain.map((id) => `\`${id}\``).join(" → ")}`);

  return `${ARCHITECTURE_HEADER}
# Architecture Index

This is a static, generated overview. Use narrow symbol queries for detail and verify runtime registration, dependency injection, and unresolved dynamic calls in source when they matter.

## Modules

${moduleLines.length ? moduleLines.join("\n") : "No callable modules were detected."}

## Root Symbols

Symbols with no statically resolved repository callers:

${rootLines.length ? rootLines.join("\n") : "No root symbols were detected."}

## Representative Execution Chains

${chainLines.length ? chainLines.join("\n") : "No multi-symbol execution chains were detected."}
`;
}
