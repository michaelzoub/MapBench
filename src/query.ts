import { promises as fs } from "node:fs";
import path from "node:path";
import type { CallGraph, CallGraphQueryMatch, CallGraphQueryResult, QueryOptions } from "./types.js";

function normalized(value: string): string {
  return value.trim().replace(/\(\)$/, "").toLocaleLowerCase();
}

function scoreMatch(id: string, query: string): number | null {
  const candidate = normalized(id);
  const target = normalized(query);
  if (candidate === target) return 0;
  if (candidate.endsWith(`#${target}`) || candidate.endsWith(`.${target}`)) return 1;
  if (candidate.includes(target)) return 2;
  return null;
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

export async function queryOutline(query: string, options: QueryOptions = {}): Promise<CallGraphQueryResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const out = path.resolve(root, options.out ?? ".project-outline");
  const file = path.join(out, "callgraph.json");
  let graph: CallGraph;
  try {
    graph = JSON.parse(await fs.readFile(file, "utf8")) as CallGraph;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Call graph not found at ${file}. Run project-outline generate first.`);
    }
    throw error;
  }
  return queryCallGraph(graph, query, options);
}

function createUnmarkedEmbeddedQueryScript(): string {
  return `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
const query = String(process.argv[2] || "").trim();
if (!query) { console.error("Usage: node .project-outline/query.mjs <symbol>"); process.exit(2); }
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
  return createUnmarkedEmbeddedQueryScript()
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
  return createUnmarkedEmbeddedQueryScript().replace(
    "#!/usr/bin/env node\n",
    "#!/usr/bin/env node\n// @project-outline generated\n",
  );
}

export function isManagedEmbeddedQueryScript(contents: string): boolean {
  return contents === createEmbeddedQueryScript() ||
    contents === createUnmarkedEmbeddedQueryScript() ||
    contents === createLegacyEmbeddedQueryScript();
}
