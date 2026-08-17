import { promises as fs } from "node:fs";
import path from "node:path";
import { createCallGraphFromIR, createStructuralIRFromDetected } from "./analysis/ir.js";
import { parseProject } from "./analysis/parser.js";
import { detectProject } from "./detection.js";
import type {
  CallGraph,
  CallGraphDirection,
  CallGraphExploreNode,
  CallGraphExploreResult,
  CallGraphFindResult,
  CallGraphInspectResult,
  CallGraphNavigationRequest,
  CallGraphNavigationResult,
  CallGraphQueryMatch,
  CallGraphQueryResult,
  CallGraphSymbolDetail,
  CallGraphSymbolReference,
  CallGraphTraceResult,
  QueryOptions,
} from "./types.js";

function normalized(value: string): string {
  return value.trim().replace(/\(\)$/, "").toLowerCase();
}

function scoreMatch(id: string, query: string): number | null {
  const candidate = normalized(id);
  const target = normalized(query);
  if (candidate === target) return 0;
  if (candidate.endsWith(`#${target}`) || candidate.endsWith(`.${target}`)) return 1;
  if (candidate.includes(target)) return 2;
  return null;
}

function validateLimit(value: number | undefined, fallback: number, maximum = 100): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Query limit must be an integer from 1 to ${maximum}.`);
  }
  return limit;
}

function validateDepth(value: number | undefined, fallback: number, maximum: number, label = "depth"): number {
  const depth = value ?? fallback;
  if (!Number.isInteger(depth) || depth < 0 || depth > maximum) {
    throw new Error(`Query ${label} must be an integer from 0 to ${maximum}.`);
  }
  return depth;
}

function validateDirection(direction: CallGraphDirection | undefined, fallback: CallGraphDirection): CallGraphDirection {
  const result = direction ?? fallback;
  if (result !== "callers" && result !== "callees" && result !== "both") {
    throw new Error("Query direction must be callers, callees, or both.");
  }
  return result;
}

function navigationScore(id: string, signature: string, query: string): number | null {
  const direct = scoreMatch(id, query);
  if (direct !== null) return direct;
  const target = normalized(query);
  const searchable = normalized(`${id} ${signature}`);
  if (searchable.includes(target)) return 3;
  const terms = target.split(/\s+/).filter(Boolean);
  return terms.length > 1 && terms.every((term) => searchable.includes(term)) ? 4 : null;
}

function rankedSymbols(graph: CallGraph, query: string): Array<{ id: string; rank: number }> {
  const clean = query.trim();
  if (!clean) throw new Error("Query symbol must not be empty.");
  return Object.entries(graph).flatMap(([id, entry]) => {
    const rank = navigationScore(id, entry.signature, clean);
    return rank === null ? [] : [{ id, rank }];
  }).sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
}

function symbolReference(graph: CallGraph, id: string): CallGraphSymbolReference {
  const entry = graph[id];
  return {
    id,
    location: `${entry.file}:${entry.line}:${entry.column}`,
    kind: entry.kind,
    signature: entry.signature,
  };
}

function boundaryMetadata(entry: CallGraph[string]): Pick<CallGraphSymbolDetail, "instantiates" | "unresolvedProjectCalls" | "externalCalls"> {
  return {
    ...(entry.instantiates?.length ? { instantiates: entry.instantiates } : {}),
    ...(entry.unresolvedProjectCalls?.length ? { unresolvedProjectCalls: entry.unresolvedProjectCalls } : {}),
    ...(entry.externalCalls?.length ? { externalCalls: entry.externalCalls } : {}),
  };
}

interface Resolution {
  status: "exact" | "ambiguous" | "missing";
  id?: string;
  candidates: string[];
  truncated: boolean;
}

function resolveSymbol(graph: CallGraph, query: string, candidateLimit = 12): Resolution {
  const ranked = rankedSymbols(graph, query);
  if (!ranked.length) return { status: "missing", candidates: [], truncated: false };
  const bestRank = ranked[0].rank;
  const best = ranked.filter((item) => item.rank === bestRank);
  if (bestRank <= 1 && best.length === 1) {
    return { status: "exact", id: best[0].id, candidates: [], truncated: false };
  }
  return {
    status: "ambiguous",
    candidates: ranked.slice(0, candidateLimit).map((item) => item.id),
    truncated: ranked.length > candidateLimit,
  };
}

function orderedCallees(graph: CallGraph, id: string): string[] {
  const entry = graph[id];
  return (entry.callsInSourceOrder ?? entry.calls).filter((candidate) => Boolean(graph[candidate]));
}

function relatedSymbols(graph: CallGraph, id: string, direction: CallGraphDirection): string[] {
  const callees = direction === "callers" ? [] : orderedCallees(graph, id);
  const callers = direction === "callees" ? [] : graph[id].calledBy.filter((candidate) => Boolean(graph[candidate]));
  return [...new Set([...callees, ...callers])];
}

export function findCallGraphSymbols(graph: CallGraph, query: string, limitOption?: number): CallGraphFindResult {
  const clean = query.trim();
  const limit = validateLimit(limitOption, 12);
  const ranked = rankedSymbols(graph, clean);
  return {
    operation: "find",
    query: clean,
    matches: ranked.slice(0, limit).map(({ id }) => symbolReference(graph, id)),
    truncated: ranked.length > limit,
  };
}

export function inspectCallGraphSymbol(graph: CallGraph, query: string, limitOption?: number): CallGraphInspectResult {
  const clean = query.trim();
  const limit = validateLimit(limitOption, 8);
  const resolution = resolveSymbol(graph, clean, limit);
  if (!resolution.id) {
    return {
      operation: "inspect",
      query: clean,
      resolution: resolution.status,
      ...(resolution.candidates.length ? { candidates: resolution.candidates.map((id) => symbolReference(graph, id)) } : {}),
      truncated: resolution.truncated,
    };
  }
  const entry = graph[resolution.id];
  const callees = orderedCallees(graph, resolution.id);
  const callers = entry.calledBy.filter((id) => Boolean(graph[id]));
  const omitted = {
    callers: Math.max(0, callers.length - limit),
    callees: Math.max(0, callees.length - limit),
  };
  return {
    operation: "inspect",
    query: clean,
    resolution: "exact",
    symbol: {
      ...symbolReference(graph, resolution.id),
      callees: callees.slice(0, limit).map((id) => symbolReference(graph, id)),
      callers: callers.slice(0, limit).map((id) => symbolReference(graph, id)),
      ...boundaryMetadata(entry),
    },
    ...(omitted.callers || omitted.callees ? { omitted } : {}),
    truncated: Boolean(omitted.callers || omitted.callees),
  };
}

export function exploreCallGraph(
  graph: CallGraph,
  query: string,
  options: { direction?: CallGraphDirection; depth?: number; limit?: number } = {},
): CallGraphExploreResult {
  const clean = query.trim();
  const direction = validateDirection(options.direction, "both");
  const depth = validateDepth(options.depth, 2, 5);
  const limit = validateLimit(options.limit, 24);
  const resolution = resolveSymbol(graph, clean, Math.min(limit, 12));
  if (!resolution.id) {
    return {
      operation: "explore",
      query: clean,
      resolution: resolution.status,
      direction,
      depth,
      ...(resolution.candidates.length ? { candidates: resolution.candidates.map((id) => symbolReference(graph, id)) } : {}),
      truncated: resolution.truncated,
    };
  }

  const distances = new Map<string, number>([[resolution.id, 0]]);
  let frontier = [resolution.id];
  let truncated = false;
  for (let distance = 1; distance <= depth && frontier.length; distance += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const related of relatedSymbols(graph, id, direction)) {
        if (distances.has(related)) continue;
        if (distances.size >= limit) {
          truncated = true;
          continue;
        }
        distances.set(related, distance);
        next.push(related);
      }
    }
    frontier = next;
  }

  const selected = new Set(distances.keys());
  const nodes: CallGraphExploreNode[] = [...distances].map(([id, distance]) => ({
    ...symbolReference(graph, id),
    distance,
    ...boundaryMetadata(graph[id]),
  }));
  const edges: [string, string][] = [];
  for (const caller of [...selected].sort()) {
    for (const callee of orderedCallees(graph, caller)) {
      if (selected.has(callee)) edges.push([caller, callee]);
    }
  }
  return {
    operation: "explore",
    query: clean,
    resolution: "exact",
    direction,
    depth,
    root: resolution.id,
    nodes,
    edges,
    truncated,
  };
}

export function traceCallGraph(
  graph: CallGraph,
  fromQuery: string,
  toQuery: string,
  options: { direction?: CallGraphDirection; maxDepth?: number } = {},
): CallGraphTraceResult {
  const from = fromQuery.trim();
  const to = toQuery.trim();
  const direction = validateDirection(options.direction, "callees");
  const maxDepth = validateDepth(options.maxDepth, 12, 50, "max depth");
  const fromResolution = resolveSymbol(graph, from);
  const toResolution = resolveSymbol(graph, to);
  if (!fromResolution.id || !toResolution.id) {
    const statuses = [fromResolution.status, toResolution.status];
    const resolution = statuses.includes("missing") ? "missing" : "ambiguous";
    return {
      operation: "trace",
      from,
      to,
      direction,
      maxDepth,
      resolution,
      found: false,
      ...(!fromResolution.id && fromResolution.candidates.length
        ? { fromCandidates: fromResolution.candidates.map((id) => symbolReference(graph, id)) }
        : {}),
      ...(!toResolution.id && toResolution.candidates.length
        ? { toCandidates: toResolution.candidates.map((id) => symbolReference(graph, id)) }
        : {}),
      truncated: fromResolution.truncated || toResolution.truncated,
    };
  }

  const previous = new Map<string, string | null>([[fromResolution.id, null]]);
  let frontier = [fromResolution.id];
  let found = fromResolution.id === toResolution.id;
  for (let distance = 1; distance <= maxDepth && frontier.length && !found; distance += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const related of relatedSymbols(graph, id, direction)) {
        if (previous.has(related)) continue;
        previous.set(related, id);
        next.push(related);
        if (related === toResolution.id) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!found) {
    return {
      operation: "trace",
      from,
      to,
      direction,
      maxDepth,
      resolution: "exact",
      found: false,
      truncated: false,
    };
  }

  const ids: string[] = [];
  for (let current: string | null = toResolution.id; current !== null; current = previous.get(current) ?? null) {
    ids.push(current);
  }
  ids.reverse();
  return {
    operation: "trace",
    from,
    to,
    direction,
    maxDepth,
    resolution: "exact",
    found: true,
    path: ids.map((id) => symbolReference(graph, id)),
    steps: ids.slice(1).map((id, index) => ({
      from: ids[index],
      to: id,
      relation: graph[ids[index]].calls.includes(id) ? "calls" : "calledBy",
    })),
    truncated: false,
  };
}

export function navigateCallGraph(graph: CallGraph, request: CallGraphNavigationRequest): CallGraphNavigationResult {
  if (request.operation === "find") return findCallGraphSymbols(graph, request.query, request.limit);
  if (request.operation === "inspect") return inspectCallGraphSymbol(graph, request.query, request.limit);
  if (request.operation === "explore") return exploreCallGraph(graph, request.query, request);
  return traceCallGraph(graph, request.from, request.to, request);
}

export function queryCallGraph(graph: CallGraph, query: string, options: Pick<QueryOptions, "depth" | "limit"> = {}): CallGraphQueryResult {
  const clean = query.trim();
  if (!clean) throw new Error("Query symbol must not be empty.");
  const ranked = Object.keys(graph).flatMap((id) => {
    const rank = scoreMatch(id, clean);
    return rank === null ? [] : [{ id, rank }];
  }).sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
  const bestRank = ranked[0]?.rank;
  const best = ranked.filter((item) => item.rank === bestRank);
  const exact = bestRank === 0 || (bestRank === 1 && best.length === 1);
  const depth = options.depth ?? (exact ? 1 : 0);
  const limit = options.limit ?? 12;
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new Error("Query depth must be an integer from 0 to 3.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Query limit must be an integer from 1 to 100.");
  const seeds = (exact ? best : ranked).slice(0, limit);
  const distances = new Map<string, number>(seeds.map((item) => [item.id, 0]));
  let frontier = seeds.map((item) => item.id);
  for (let distance = 1; distance <= depth; distance += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const entry = graph[id];
      if (!entry) continue;
      for (const related of [...entry.calls, ...entry.calledBy]) {
        if (!graph[related] || distances.has(related)) continue;
        distances.set(related, distance);
        next.push(related);
      }
    }
    frontier = next.sort();
  }
  const matches: CallGraphQueryMatch[] = [...distances.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([id, distance]) => ({ id, distance, ...graph[id] }));
  return { query: clean, exact, truncated: ranked.length > seeds.length || distances.size > matches.length, matches };
}

async function readOutlineCallGraph(options: Pick<QueryOptions, "root" | "out"> = {}): Promise<CallGraph> {
  const root = path.resolve(options.root ?? process.cwd());
  try {
    const detected = await detectProject({ root, out: options.out });
    const project = await parseProject(detected);
    return createCallGraphFromIR(createStructuralIRFromDetected(project, detected));
  } catch (error) {
    const out = path.resolve(root, options.out ?? ".cartograph");
    const file = path.join(out, "callgraph.json");
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as CallGraph;
    } catch {
      throw error;
    }
  }
}

export async function queryOutline(query: string, options: QueryOptions = {}): Promise<CallGraphQueryResult> {
  return queryCallGraph(await readOutlineCallGraph(options), query, options);
}

export async function navigateOutline(
  request: CallGraphNavigationRequest,
  options: Pick<QueryOptions, "root" | "out"> = {},
): Promise<CallGraphNavigationResult> {
  return navigateCallGraph(await readOutlineCallGraph(options), request);
}

function createPreviousUnmarkedEmbeddedQueryScript(): string {
  return `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
const query = String(process.argv[2] || "").trim();
if (!query) { console.error("Usage: node .cartograph/query.mjs <symbol>"); process.exit(2); }
const graph = JSON.parse(await readFile(new URL("./callgraph.json", import.meta.url), "utf8"));
const norm = value => String(value).trim().replace(/\\(\\)$/, "").toLowerCase();
const target = norm(query);
const ranked = Object.keys(graph).flatMap(id => {
  const item = norm(id);
  const rank = item === target ? 0 : item.endsWith("#" + target) || item.endsWith("." + target) ? 1 : item.includes(target) ? 2 : null;
  return rank === null ? [] : [{ id, rank }];
}).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
const bestRank = ranked[0]?.rank;
const best = ranked.filter(item => item.rank === bestRank);
const exact = bestRank === 0 || (bestRank === 1 && best.length === 1);
const limit = 12;
const seeds = (exact ? best : ranked).slice(0, limit);
const distances = new Map(seeds.map(item => [item.id, 0]));
if (exact) {
  for (const { id } of seeds) {
    const entry = graph[id];
    for (const related of [...entry.calls, ...entry.calledBy]) if (graph[related] && !distances.has(related)) distances.set(related, 1);
  }
}
const matches = [...distances].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id, distance]) => ({ id, distance, ...graph[id] }));
console.log(JSON.stringify({ query, exact, truncated: ranked.length > seeds.length || distances.size > matches.length, matches }, null, 2));
if (!matches.length) process.exitCode = 2;
`;
}

function createLegacyEmbeddedQueryScript(): string {
  return createPreviousUnmarkedEmbeddedQueryScript()
    .replace(
      `const bestRank = ranked[0]?.rank;\nconst best = ranked.filter(item => item.rank === bestRank);\nconst exact = bestRank === 0 || (bestRank === 1 && best.length === 1);`,
      `const exact = ranked.some(item => item.rank === 0);`,
    )
    .replace(
      `const seeds = (exact ? best : ranked).slice(0, limit);`,
      `const seeds = (exact ? ranked.filter(item => item.rank === 0) : ranked).slice(0, limit);`,
    )
    .replace(
      `[...entry.calls, ...entry.calledBy]`,
      `[...entry.calls, ...entry.calledBy, ...entry.constructs]`,
    );
}

export function createEmbeddedQueryScript(): string {
  return `#!/usr/bin/env node
// @cartograph generated
import { readFile } from "node:fs/promises";
process.on("uncaughtException", error => {
  console.error("cartograph query: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
const graph = JSON.parse(await readFile(new URL("./callgraph.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);
const operations = new Set(["find", "inspect", "explore", "trace"]);
const operation = operations.has(argv[0]) ? argv.shift() : "legacy";
const positionals = [];
const options = {};
while (argv.length) {
  const value = argv.shift();
  if (!value.startsWith("--")) { positionals.push(value); continue; }
  const [flag, inline] = value.split("=", 2);
  const next = inline ?? argv.shift();
  if (next === undefined || next.startsWith("--")) throw new Error("Missing value for " + flag);
  if (flag === "--depth") options.depth = Number(next);
  else if (flag === "--limit") options.limit = Number(next);
  else if (flag === "--max-depth") options.maxDepth = Number(next);
  else if (flag === "--direction") options.direction = next;
  else throw new Error("Unknown option: " + flag);
}
const norm = value => String(value).trim().replace(/\\(\\)$/, "").toLowerCase();
const score = (id, signature, query) => {
  const item = norm(id), target = norm(query);
  if (item === target) return 0;
  if (item.endsWith("#" + target) || item.endsWith("." + target)) return 1;
  if (item.includes(target)) return 2;
  const terms = target.split(/\\s+/).filter(Boolean), searchable = norm(id + " " + signature);
  if (searchable.includes(target)) return 3;
  return terms.length > 1 && terms.every(term => searchable.includes(term)) ? 4 : null;
};
const ranked = query => {
  if (!String(query).trim()) throw new Error("Query symbol must not be empty.");
  return Object.entries(graph).flatMap(([id, entry]) => {
  const rank = score(id, entry.signature, query);
  return rank === null ? [] : [{ id, rank }];
  }).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
};
const reference = id => {
  const entry = graph[id];
  return { id, location: entry.file + ":" + entry.line + ":" + entry.column, kind: entry.kind, signature: entry.signature };
};
const metadata = entry => ({
  ...(entry.instantiates?.length ? { instantiates: entry.instantiates } : {}),
  ...(entry.unresolvedProjectCalls?.length ? { unresolvedProjectCalls: entry.unresolvedProjectCalls } : {}),
  ...(entry.externalCalls?.length ? { externalCalls: entry.externalCalls } : {}),
});
const limit = (value, fallback, maximum = 100) => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error("Query limit must be an integer from 1 to " + maximum + ".");
  return result;
};
const depth = (value, fallback, maximum, label = "depth") => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > maximum) throw new Error("Query " + label + " must be an integer from 0 to " + maximum + ".");
  return result;
};
const direction = (value, fallback) => {
  const result = value ?? fallback;
  if (!["callers", "callees", "both"].includes(result)) throw new Error("Query direction must be callers, callees, or both.");
  return result;
};
const resolve = (query, candidateLimit = 12) => {
  const matches = ranked(query);
  if (!matches.length) return { status: "missing", candidates: [], truncated: false };
  const best = matches.filter(item => item.rank === matches[0].rank);
  if (matches[0].rank <= 1 && best.length === 1) return { status: "exact", id: best[0].id, candidates: [], truncated: false };
  return { status: "ambiguous", candidates: matches.slice(0, candidateLimit).map(item => item.id), truncated: matches.length > candidateLimit };
};
const callees = id => (graph[id].callsInSourceOrder ?? graph[id].calls).filter(candidate => graph[candidate]);
const related = (id, value) => [...new Set([
  ...(value === "callers" ? [] : callees(id)),
  ...(value === "callees" ? [] : graph[id].calledBy.filter(candidate => graph[candidate])),
])];
const unresolved = (name, query, resolution, extra = {}) => ({
  operation: name, query, resolution: resolution.status,
  ...(resolution.candidates.length ? { candidates: resolution.candidates.map(reference) } : {}),
  ...extra, truncated: resolution.truncated,
});
let result;
if (operation === "find") {
  if (positionals.length !== 1) throw new Error("Usage: node .cartograph/query.mjs find <terms> [--limit <1-100>]");
  const query = positionals[0].trim(), max = limit(options.limit, 12), matches = ranked(query);
  result = { operation, query, matches: matches.slice(0, max).map(item => reference(item.id)), truncated: matches.length > max };
} else if (operation === "inspect") {
  if (positionals.length !== 1) throw new Error("Usage: node .cartograph/query.mjs inspect <symbol> [--limit <1-100>]");
  const query = positionals[0].trim(), max = limit(options.limit, 8), resolution = resolve(query, max);
  if (!resolution.id) result = unresolved(operation, query, resolution);
  else {
    const entry = graph[resolution.id], outgoing = callees(resolution.id), incoming = entry.calledBy.filter(id => graph[id]);
    const omitted = { callers: Math.max(0, incoming.length - max), callees: Math.max(0, outgoing.length - max) };
    result = { operation, query, resolution: "exact", symbol: {
      ...reference(resolution.id), callees: outgoing.slice(0, max).map(reference), callers: incoming.slice(0, max).map(reference), ...metadata(entry),
    }, ...(omitted.callers || omitted.callees ? { omitted } : {}), truncated: Boolean(omitted.callers || omitted.callees) };
  }
} else if (operation === "explore") {
  if (positionals.length !== 1) throw new Error("Usage: node .cartograph/query.mjs explore <symbol> [--direction <callers|callees|both>] [--depth <0-5>] [--limit <1-100>]");
  const query = positionals[0].trim(), way = direction(options.direction, "both"), levels = depth(options.depth, 2, 5), max = limit(options.limit, 24);
  const resolution = resolve(query, Math.min(max, 12));
  if (!resolution.id) result = unresolved(operation, query, resolution, { direction: way, depth: levels });
  else {
    const distances = new Map([[resolution.id, 0]]); let frontier = [resolution.id], truncated = false;
    for (let distance = 1; distance <= levels && frontier.length; distance++) {
      const next = [];
      for (const id of frontier) for (const candidate of related(id, way)) {
        if (distances.has(candidate)) continue;
        if (distances.size >= max) { truncated = true; continue; }
        distances.set(candidate, distance); next.push(candidate);
      }
      frontier = next;
    }
    const selected = new Set(distances.keys()), edges = [];
    for (const caller of [...selected].sort()) for (const callee of callees(caller)) if (selected.has(callee)) edges.push([caller, callee]);
    result = { operation, query, resolution: "exact", direction: way, depth: levels, root: resolution.id,
      nodes: [...distances].map(([id, distance]) => ({ ...reference(id), distance, ...metadata(graph[id]) })), edges, truncated };
  }
} else if (operation === "trace") {
  if (positionals.length !== 2) throw new Error("Usage: node .cartograph/query.mjs trace <from> <to> [--direction <callers|callees|both>] [--max-depth <0-50>]");
  const [from, to] = positionals.map(value => value.trim()), way = direction(options.direction, "callees"), levels = depth(options.maxDepth, 12, 50, "max depth");
  const start = resolve(from), target = resolve(to);
  if (!start.id || !target.id) {
    const status = start.status === "missing" || target.status === "missing" ? "missing" : "ambiguous";
    result = { operation, from, to, direction: way, maxDepth: levels, resolution: status, found: false,
      ...(!start.id && start.candidates.length ? { fromCandidates: start.candidates.map(reference) } : {}),
      ...(!target.id && target.candidates.length ? { toCandidates: target.candidates.map(reference) } : {}),
      truncated: start.truncated || target.truncated };
  } else {
    const previous = new Map([[start.id, null]]); let frontier = [start.id], found = start.id === target.id;
    for (let distance = 1; distance <= levels && frontier.length && !found; distance++) {
      const next = [];
      for (const id of frontier) {
        for (const candidate of related(id, way)) {
          if (previous.has(candidate)) continue;
          previous.set(candidate, id); next.push(candidate);
          if (candidate === target.id) { found = true; break; }
        }
        if (found) break;
      }
      frontier = next;
    }
    if (!found) result = { operation, from, to, direction: way, maxDepth: levels, resolution: "exact", found: false, truncated: false };
    else {
      const ids = []; for (let current = target.id; current !== null; current = previous.get(current) ?? null) ids.push(current); ids.reverse();
      result = { operation, from, to, direction: way, maxDepth: levels, resolution: "exact", found: true, path: ids.map(reference),
        steps: ids.slice(1).map((id, index) => ({ from: ids[index], to: id, relation: graph[ids[index]].calls.includes(id) ? "calls" : "calledBy" })), truncated: false };
    }
  }
} else {
  if (positionals.length !== 1) throw new Error("Usage: node .cartograph/query.mjs <symbol>");
  const query = positionals[0].trim(), target = norm(query);
  if (!query) throw new Error("Query symbol must not be empty.");
  const matches = Object.keys(graph).flatMap(id => {
    const item = norm(id), rank = item === target ? 0 : item.endsWith("#" + target) || item.endsWith("." + target) ? 1 : item.includes(target) ? 2 : null;
    return rank === null ? [] : [{ id, rank }];
  }).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const bestRank = matches[0]?.rank, best = matches.filter(item => item.rank === bestRank);
  const exact = bestRank === 0 || (bestRank === 1 && best.length === 1), max = limit(options.limit, 12), levels = depth(options.depth, exact ? 1 : 0, 3);
  const seeds = (exact ? best : matches).slice(0, max), distances = new Map(seeds.map(item => [item.id, 0])); let frontier = seeds.map(item => item.id);
  for (let distance = 1; distance <= levels; distance++) {
    const next = [];
    for (const id of frontier) for (const candidate of [...graph[id].calls, ...graph[id].calledBy]) if (graph[candidate] && !distances.has(candidate)) { distances.set(candidate, distance); next.push(candidate); }
    frontier = next.sort();
  }
  const output = [...distances].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, max).map(([id, distance]) => ({ id, distance, ...graph[id] }));
  result = { query, exact, truncated: matches.length > seeds.length || distances.size > output.length, matches: output };
}
console.log(JSON.stringify(result, null, operation === "legacy" ? 2 : undefined));
if (("matches" in result && !result.matches.length) || ("resolution" in result && result.resolution !== "exact")) process.exitCode = 2;
`;
}

export function isManagedEmbeddedQueryScript(contents: string): boolean {
  return contents === createEmbeddedQueryScript() ||
    contents === createPreviousUnmarkedEmbeddedQueryScript() ||
    contents === createPreviousUnmarkedEmbeddedQueryScript().replace(
      "#!/usr/bin/env node\n",
      "#!/usr/bin/env node\n// @cartograph generated\n",
    ) ||
    contents === createLegacyEmbeddedQueryScript();
}
