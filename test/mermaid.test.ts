import assert from "node:assert/strict";
import test from "node:test";
import { createArchitectureMermaid } from "../src/index.js";
import type { CallGraph, CallGraphEntry } from "../src/index.js";

function entry(file: string, calls: string[] = [], calledBy: string[] = []): CallGraphEntry {
  return {
    file,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    startByte: 0,
    endByte: 1,
    kind: "function",
    signature: "run(): void",
    calls,
    calledBy,
  };
}

test("creates a deterministic module-level Mermaid architecture from call graph relationships", () => {
  const graph: CallGraph = {
    "src/app.ts#start": {
      ...entry("src/app.ts", ["src/domain/service.ts#run"]),
      instantiates: ["src/adapters/store.ts#Store"],
      externalCalls: ["fastify#app.listen", "zod#schema.parse"],
    },
    "src/domain/service.ts#run": entry(
      "src/domain/service.ts",
      ["src/adapters/store.ts#save"],
      ["src/app.ts#start"],
    ),
    "src/adapters/store.ts#save": entry(
      "src/adapters/store.ts",
      [],
      ["src/domain/service.ts#run"],
    ),
  };

  const first = createArchitectureMermaid(graph);
  const reversed = createArchitectureMermaid(Object.fromEntries(Object.entries(graph).reverse()));

  assert.equal(first, reversed);
  assert.match(first, /^%% @project-outline generated\n/);
  assert.match(first, /app\.ts<br\/>1 callable · entry/);
  assert.match(first, /service\.ts<br\/>1 callable/);
  assert.match(first, /store\.ts<br\/>1 callable/);
  assert.match(first, /-->\|calls\|/);
  assert.match(first, /-\.->\|creates\|/);
  assert.match(first, /dependencies\["External dependencies"\]/);
  assert.match(first, /\["fastify"\]/);
  assert.match(first, /\["zod"\]/);
  assert.doesNotMatch(first, /src\/domain\/service\.ts#run/);
});

test("bounds large Mermaid diagrams and reports omitted detail", () => {
  const graph: CallGraph = {};
  for (let index = 0; index < 40; index += 1) {
    const id = `src/module-${String(index).padStart(2, "0")}.ts#run`;
    const next = index < 39 ? `src/module-${String(index + 1).padStart(2, "0")}.ts#run` : undefined;
    const previous = index > 0 ? `src/module-${String(index - 1).padStart(2, "0")}.ts#run` : undefined;
    graph[id] = {
      ...entry(`src/module-${String(index).padStart(2, "0")}.ts`, next ? [next] : [], previous ? [previous] : []),
      externalCalls: index === 0
        ? Array.from({ length: 10 }, (_, dependency) => `package-${dependency}#use`)
        : undefined,
    };
  }

  const mermaid = createArchitectureMermaid(graph);

  assert.equal((mermaid.match(/module_\d+\["/g) ?? []).length, 24);
  assert.equal((mermaid.match(/dependency_\d+\(\["/g) ?? []).length, 6);
  assert.match(mermaid, /… 16 modules, .*4 external dependencies omitted for readability/);
  assert.ok((mermaid.match(/(?:-->|-\.->)\|/g) ?? []).length <= 42);
});
