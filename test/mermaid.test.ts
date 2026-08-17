import assert from "node:assert/strict";
import test from "node:test";
import { createArchitectureMermaid } from "../src/index.js";
import type {
  StructuralEdge,
  StructuralEdgeType,
  StructuralIR,
  StructuralResolution,
  StructuralSymbol,
  StructuralSymbolKind,
} from "../src/index.js";

function symbol(
  id: string,
  file: string,
  kind: StructuralSymbolKind = "function",
  qualifiedName = id.split("#").at(-1) ?? id,
): StructuralSymbol {
  return {
    id,
    name: qualifiedName.split(".").at(-1) ?? qualifiedName,
    qualifiedName,
    kind,
    file,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 2,
    startByte: 0,
    endByte: 1,
    signature: `${qualifiedName}(): void`,
    exported: true,
    visibility: "public",
  };
}

function module(file: string): StructuralSymbol {
  return symbol(`${file}#<module>`, file, "module", `${file}#<module>`);
}

function edge(
  type: StructuralEdgeType,
  source: string,
  target?: string,
  options: { targetLabel?: string; resolution?: StructuralResolution; order?: number } = {},
): StructuralEdge {
  return {
    id: `${type}:${source}:${target ?? options.targetLabel ?? "?"}:${options.order ?? 0}`,
    type,
    source,
    ...(target ? { target } : {}),
    ...(options.targetLabel ? { targetLabel: options.targetLabel } : {}),
    file: source.split("#")[0],
    line: 1,
    column: 1,
    sourceOrder: options.order ?? 0,
    resolution: options.resolution ?? "resolved",
    provenance: "test",
  };
}

function ir(nodes: StructuralSymbol[], edges: StructuralEdge[]): StructuralIR {
  return {
    nodes,
    edges,
    unresolved: [],
    manifest: {
      tool: "cartograph",
      schemaVersion: 1,
      toolVersion: "0.1.0",
      languages: ["typescript"],
      filesScanned: [...new Set(nodes.map((node) => node.file))].sort(),
      filesSkipped: [],
      parseFailures: [],
      symbolCount: nodes.filter((node) => node.kind !== "module").length,
      edgeCount: edges.length,
      unresolvedCount: 0,
    },
  };
}

test("creates a deterministic entrypoint-rooted system map from canonical IR", () => {
  const files = [
    "src/app/main.ts",
    "src/contracts/repository.ts",
    "src/domain/service.ts",
    "src/adapters/store.ts",
  ];
  const nodes = [
    ...files.map(module),
    symbol("src/app/main.ts#start", files[0]),
    symbol("src/contracts/repository.ts#Repository", files[1], "interface", "Repository"),
    symbol("src/domain/service.ts#run", files[2]),
    symbol("src/adapters/store.ts#Store", files[3], "class", "Store"),
    symbol("src/adapters/store.ts#save", files[3]),
  ];
  const edges = [
    edge("import", `${files[0]}#<module>`, `${files[2]}#<module>`),
    edge("call", `${files[0]}#start`, `${files[2]}#run`),
    edge("call", `${files[2]}#run`, `${files[3]}#save`),
    edge("instantiate", `${files[0]}#start`, `${files[3]}#Store`),
    edge("implement", `${files[3]}#Store`, `${files[1]}#Repository`),
    edge("import", `${files[0]}#<module>`, undefined, { targetLabel: "fastify", resolution: "external" }),
    edge("call", `${files[0]}#start`, undefined, { targetLabel: "zod#schema.parse", resolution: "external" }),
  ];
  const canonical = ir(nodes, edges);

  const first = createArchitectureMermaid(canonical);
  const reversed = createArchitectureMermaid({
    ...canonical,
    nodes: [...canonical.nodes].reverse(),
    edges: [...canonical.edges].reverse(),
  });

  assert.equal(first, reversed);
  assert.match(first, /^%% @cartograph generated\n/);
  assert.match(first, /projected directly from the canonical structural IR/);
  assert.match(first, /callgraph\.json/);
  assert.match(first, /group_\d+\["src\/app"\]/);
  assert.match(first, /main\.ts<br\/>static entry: start · fan 0 in \/ 2 out · 3 downstream/);
  assert.match(first, /service\.ts<br\/>reached by 1 entry/);
  assert.match(first, /==>\|imports · execution flow\|/);
  assert.match(first, /-->\|instantiates\|/);
  assert.match(first, /-->\|implements\|/);
  assert.match(first, /dependencies\["External systems \/ dependencies"\]/);
  assert.match(first, /\["fastify"\]/);
  assert.match(first, /\["zod"\]/);
  assert.match(first, /-\.->\|imports\|/);
  assert.match(first, /-\.->\|uses API\|/);
  assert.doesNotMatch(first, /\|\d+ calls?\|/);
  assert.doesNotMatch(first, /src\/domain\/service\.ts#run/);
});

test("bounds large system maps using deterministic reach and topology metrics", () => {
  const nodes: StructuralSymbol[] = [];
  const edges: StructuralEdge[] = [];
  for (let index = 0; index < 40; index += 1) {
    const file = `src/component/module-${String(index).padStart(2, "0")}.ts`;
    const id = `${file}#run`;
    nodes.push(module(file), symbol(id, file));
    if (index < 39) {
      const nextFile = `src/component/module-${String(index + 1).padStart(2, "0")}.ts`;
      edges.push(edge("call", id, `${nextFile}#run`));
    }
    if (index === 0) {
      for (let dependency = 0; dependency < 10; dependency += 1) {
        edges.push(edge("import", `${file}#<module>`, undefined, {
          targetLabel: `package-${dependency}`,
          resolution: "external",
          order: dependency,
        }));
      }
    }
  }

  const mermaid = createArchitectureMermaid(ir(nodes, edges));

  assert.equal((mermaid.match(/module_\d+\["/g) ?? []).length, 24);
  assert.equal((mermaid.match(/dependency_\d+\(\["/g) ?? []).length, 6);
  assert.match(mermaid, /… 16 modules, 16 system relationships, 4 external dependencies omitted for readability/);
  assert.ok((mermaid.match(/(?:==>|-->|-\.->)\|/g) ?? []).length <= 42);
});
