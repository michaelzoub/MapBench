#!/usr/bin/env node
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
const norm = value => String(value).trim().replace(/\(\)$/, "").toLowerCase();
const score = (id, signature, query) => {
  const item = norm(id), target = norm(query);
  if (item === target) return 0;
  if (item.endsWith("#" + target) || item.endsWith("." + target)) return 1;
  if (item.includes(target)) return 2;
  const terms = target.split(/\s+/).filter(Boolean), searchable = norm(id + " " + signature);
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
