import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createEmbeddedQueryScript,
  exploreCallGraph,
  findCallGraphSymbols,
  inspectCallGraphSymbol,
  traceCallGraph,
} from "../src/index.js";
import type { CallGraph, CallGraphEntry } from "../src/index.js";

const execFileAsync = promisify(execFile);

function entry(
  file: string,
  line: number,
  calls: string[] = [],
  calledBy: string[] = [],
  extra: Partial<CallGraphEntry> = {},
): CallGraphEntry {
  return {
    file,
    line,
    column: 1,
    kind: "function",
    signature: `${path.basename(file, ".ts")}(): void`,
    calls,
    calledBy,
    ...extra,
  };
}

const root = "src/alpha.ts#root";
const beta = "src/beta.ts#beta";
const charlie = "src/charlie.ts#charlie";
const destination = "src/destination.ts#destination";

const graph: CallGraph = {
  [root]: entry("src/alpha.ts", 10, [beta, charlie], [], {
    callsInSourceOrder: [charlie, beta],
    externalCalls: ["fastify#app.get"],
  }),
  [beta]: entry("src/beta.ts", 20, [destination], [root]),
  [charlie]: entry("src/charlie.ts", 30, [destination], [root], {
    unresolvedProjectCalls: ["handler"],
  }),
  [destination]: entry("src/destination.ts", 40, [], [beta, charlie]),
};

test("find and inspect expose bounded symbol-focused graph slices", () => {
  const found = findCallGraphSymbols(graph, "alpha root");
  assert.deepEqual(found.matches.map((item) => item.id), [root]);
  assert.deepEqual(found.matches[0], {
    id: root,
    location: "src/alpha.ts:10:1",
    kind: "function",
    signature: "alpha(): void",
  });
  assert.deepEqual(findCallGraphSymbols(graph, "alpha(): void").matches.map((item) => item.id), [root]);

  const inspected = inspectCallGraphSymbol(graph, root, 1);
  assert.equal(inspected.resolution, "exact");
  assert.deepEqual(inspected.symbol?.callees.map((item) => item.id), [charlie]);
  assert.deepEqual(inspected.symbol?.callers, []);
  assert.deepEqual(inspected.symbol?.externalCalls, ["fastify#app.get"]);
  assert.deepEqual(inspected.omitted, { callers: 0, callees: 1 });
  assert.equal(JSON.stringify(inspected).includes(destination), false);
});

test("explore bounds a deterministic multi-hop subsystem and preserves selected metadata", () => {
  const explored = exploreCallGraph(graph, root, { direction: "callees", depth: 2, limit: 3 });
  assert.equal(explored.resolution, "exact");
  assert.equal(explored.truncated, true);
  assert.deepEqual(explored.nodes?.map((item) => [item.id, item.distance]), [
    [root, 0],
    [charlie, 1],
    [beta, 1],
  ]);
  assert.deepEqual(explored.nodes?.find((item) => item.id === charlie)?.unresolvedProjectCalls, ["handler"]);
  assert.deepEqual(explored.edges, [[root, charlie], [root, beta]]);
  assert.equal(JSON.stringify(explored).includes(destination), false);
});

test("trace returns only a deterministic shortest relationship path", () => {
  const outbound = traceCallGraph(graph, root, destination);
  assert.equal(outbound.found, true);
  assert.deepEqual(outbound.path?.map((item) => item.id), [root, charlie, destination]);
  assert.deepEqual(outbound.steps?.map((item) => item.relation), ["calls", "calls"]);

  const inbound = traceCallGraph(graph, destination, root, { direction: "callers" });
  assert.equal(inbound.found, true);
  assert.deepEqual(inbound.path?.map((item) => item.id), [destination, beta, root]);
  assert.deepEqual(inbound.steps?.map((item) => item.relation), ["calledBy", "calledBy"]);

  const bounded = traceCallGraph(graph, root, destination, { maxDepth: 1 });
  assert.equal(bounded.resolution, "exact");
  assert.equal(bounded.found, false);
  assert.equal(bounded.path, undefined);
});

test("generated helper and installed CLI expose the progressive operations", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-outline-query-"));
  const out = path.join(temporary, ".project-outline");
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, "callgraph.json"), `${JSON.stringify(graph, null, 2)}\n`);
  await fs.writeFile(path.join(out, "query.mjs"), createEmbeddedQueryScript());
  try {
    const helper = await execFileAsync(process.execPath, [path.join(out, "query.mjs"), "inspect", root, "--limit", "1"]);
    const helperResult = JSON.parse(helper.stdout);
    assert.deepEqual(helperResult, inspectCallGraphSymbol(graph, root, 1));

    const cli = path.resolve(process.cwd(), "dist/src/cli.js");
    const command = await execFileAsync(process.execPath, [cli, "query", "trace", root, destination, "--root", temporary]);
    assert.deepEqual(JSON.parse(command.stdout), traceCallGraph(graph, root, destination));

    const legacy = await execFileAsync(process.execPath, [path.join(out, "query.mjs"), root]);
    const legacyResult = JSON.parse(legacy.stdout);
    assert.equal(legacyResult.exact, true);
    assert.equal(legacyResult.matches[0].id, root);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
