import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArchitectureMermaid, createArchitectureSummary, generateOutline } from "../src/index.js";
import { createStructuralIRFromDetected } from "../src/analysis/ir.js";
import { parseProject } from "../src/analysis/parser.js";
import { detectProject } from "../src/detection.js";
import type { CallGraph } from "../src/types.js";

const repositoryFixtures = path.resolve(process.cwd(), "test/fixtures");
const languageFixtures = path.join(repositoryFixtures, "languages");

async function temporaryRepository(prefix: string): Promise<{ parent: string; root: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `cartograph-${prefix}-`));
  const root = path.join(parent, "repository");
  await fs.mkdir(root, { recursive: true });
  return { parent, root };
}

async function copyFixture(source: string): Promise<{ parent: string; root: string }> {
  const temporary = await temporaryRepository(path.basename(source));
  await fs.cp(source, temporary.root, { recursive: true });
  return temporary;
}

async function fileMap(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.set(path.relative(root, absolute).split(path.sep).join("/"), await fs.readFile(absolute));
    }
  };
  await visit(root);
  return result;
}

function pointAt(buffer: Buffer, offset: number): { line: number; column: number } {
  const prefix = buffer.subarray(0, offset);
  let line = 1;
  let lastNewline = -1;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] === 0x0a) {
      line += 1;
      lastNewline = index;
    }
  }
  return { line, column: offset - lastNewline };
}

test("all five maintained Tree-sitter grammars feed one normalized structural IR", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.dependencies).filter((name) => name.startsWith("tree-sitter")).sort(), [
    "tree-sitter",
    "tree-sitter-go",
    "tree-sitter-javascript",
    "tree-sitter-python",
    "tree-sitter-rust",
    "tree-sitter-typescript",
  ]);
  assert.equal(packageJson.dependencies.typescript, undefined);

  const cases = [
    { source: path.join(repositoryFixtures, "basic/repository"), expected: ["class", "constructor", "enum", "function", "interface", "method", "type"] },
    { source: path.join(languageFixtures, "javascript-only"), expected: ["class", "constructor", "function", "method"] },
    { source: path.join(languageFixtures, "python-only"), expected: ["class", "constructor", "function", "interface", "method"] },
    { source: path.join(languageFixtures, "go-only"), expected: ["function", "interface", "method", "struct"] },
    { source: path.join(languageFixtures, "rust-only"), expected: ["constructor", "function", "method", "struct", "trait"] },
  ];
  for (const fixture of cases) {
    const parsed = await parseProject(await detectProject({ root: fixture.source }));
    const kinds = [...new Set(parsed.symbols.map((symbol) => symbol.kind))].sort();
    for (const expected of fixture.expected) assert.ok(kinds.includes(expected as never), `${fixture.source} missing ${expected}`);
    assert.equal(new Set(parsed.symbols.map((symbol) => symbol.id)).size, parsed.symbols.length);
    for (const symbol of parsed.symbols) {
      assert.ok(symbol.startLine > 0 && symbol.startColumn > 0);
      assert.ok(symbol.endLine >= symbol.startLine && symbol.endColumn > 0);
      assert.ok(symbol.endByte > symbol.startByte);
    }
  }
});
test("canonical IR carries module nodes, typed anchored edges, unresolved records, and manifest counts", async () => {
  const temporary = await copyFixture(path.join(repositoryFixtures, "basic/repository"));
  try {
    const detected = await detectProject({ root: temporary.root });
    const project = await parseProject(detected);
    const ir = createStructuralIRFromDetected(project, detected);
    assert.ok(ir.nodes.some((node) => node.kind === "module" && node.id === "src/workers/worker-manager.ts#<module>"));
    const process = ir.nodes.find((node) => node.id === "src/workers/worker-manager.ts#WorkerManager.process");
    assert.ok(process);
    const call = ir.edges.find((edge) => edge.source === process!.id && edge.type === "call" && edge.resolution === "resolved");
    assert.deepEqual(call && { target: call.target, file: call.file, line: call.line, resolution: call.resolution }, {
      target: "src/storage/candidate-store.ts#CandidateStore.find",
      file: "src/workers/worker-manager.ts",
      line: 25,
      resolution: "resolved",
    });
    assert.ok(ir.edges.some((edge) => edge.type === "call" && edge.resolution === "unresolved" && edge.targetLabel === "callback"));
    assert.equal(ir.manifest.symbolCount, ir.nodes.filter((node) => node.kind !== "module").length);
    assert.equal(ir.manifest.edgeCount, ir.edges.length);
    assert.equal(ir.manifest.unresolvedCount, ir.unresolved.length);
    assert.deepEqual(ir.manifest.parseFailures, []);
  } finally {
    await fs.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("every graph callable carries an exact source range and human artifacts derive from canonical IR", async () => {
  const temporary = await copyFixture(path.join(languageFixtures, "polyglot"));
  try {
    const result = await generateOutline({ root: temporary.root });
    const graph = JSON.parse(await fs.readFile(path.join(result.out, "callgraph.json"), "utf8")) as CallGraph;
    for (const [id, entry] of Object.entries(graph)) {
      const source = await fs.readFile(path.join(temporary.root, entry.file));
      assert.ok(entry.startByte >= 0 && entry.endByte > entry.startByte && entry.endByte <= source.length, id);
      assert.deepEqual(pointAt(source, entry.startByte), { line: entry.line, column: entry.column }, `${id} start`);
      assert.deepEqual(pointAt(source, entry.endByte), { line: entry.endLine, column: entry.endColumn }, `${id} end`);
      const declaration = source.subarray(entry.startByte, entry.endByte).toString("utf8");
      assert.ok(declaration.includes(id.slice(id.lastIndexOf("#") + 1).split(".").at(-1)!), id);
    }
    const detected = await detectProject({ root: temporary.root });
    const project = await parseProject(detected);
    const ir = createStructuralIRFromDetected(project, detected);
    assert.equal(await fs.readFile(path.join(result.out, "architecture.md"), "utf8"), createArchitectureSummary(ir));
    assert.equal(await fs.readFile(path.join(result.out, "architecture.mmd"), "utf8"), createArchitectureMermaid(ir));
  } finally {
    await fs.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("Tree-sitter parse failures remain explicit in the canonical manifest projection", async () => {
  const malformed = [
    ["broken.ts", "export function broken( {"],
    ["broken.js", "export function broken( {"],
    ["broken.py", "def broken(:\n    pass\n"],
    ["broken.go", "package broken\nfunc broken( {\n"],
    ["broken.rs", "fn broken( {\n"],
  ] as const;
  for (const [name, contents] of malformed) {
    const temporary = await temporaryRepository(`malformed-${path.extname(name).slice(1)}`);
    try {
      await fs.writeFile(path.join(temporary.root, name), contents);
      const result = await generateOutline({ root: temporary.root });
      const architecture = await fs.readFile(path.join(result.out, "architecture.md"), "utf8");
      assert.match(architecture, /parse failures: 1/);
      assert.match(architecture, new RegExp(`Files scanned: 1`));
      assert.equal((await fileMap(result.out)).has(name), false);
    } finally {
      await fs.rm(temporary.parent, { recursive: true, force: true });
    }
  }

  const preserved = await temporaryRepository("malformed-replaces-last-good-output");
  try {
    const source = path.join(preserved.root, "main.ts");
    await fs.writeFile(source, "export function valid(): void {}\n");
    const valid = await generateOutline({ root: preserved.root });
    assert.equal((await fileMap(valid.out)).has("main.ts"), true);
    await fs.writeFile(source, "export function broken( {");
    const regenerated = await generateOutline({ root: preserved.root });
    assert.equal((await fileMap(regenerated.out)).has("main.ts"), false);
    assert.match(await fs.readFile(path.join(regenerated.out, "architecture.md"), "utf8"), /parse failures: 1/);
  } finally {
    await fs.rm(preserved.parent, { recursive: true, force: true });
  }
});

test("DeepSWE verifier and reference-solution trees cannot enter persisted artifacts", async () => {
  const temporary = await temporaryRepository("deepswe-isolation");
  const sentinel = "DEEPSWE_PRIVATE_SENTINEL_9f4f8a";
  try {
    await fs.mkdir(path.join(temporary.root, "src"), { recursive: true });
    await fs.writeFile(path.join(temporary.root, "src/main.ts"), "export function publicEntry(): void {}\n");
    const privateFiles = [
      ["tests/verifier.py", `def ${sentinel}():\n    pass\n`],
      ["verifier/check.go", `package verifier\nfunc ${sentinel}() {}\n`],
      ["solution/reference.ts", `export function ${sentinel}(): void {}\n`],
      ["reference_solution/gold.rs", `fn ${sentinel}() {}\n`],
      ["tasks/private/grader/answer.js", `export const ${sentinel} = true;\n`],
    ];
    for (const [relative, contents] of privateFiles) {
      const fileName = path.join(temporary.root, relative);
      await fs.mkdir(path.dirname(fileName), { recursive: true });
      await fs.writeFile(fileName, contents);
    }
    const result = await generateOutline({ root: temporary.root });
    const artifacts = await fileMap(result.out);
    assert.ok(artifacts.has("src/main.ts"), "positive control: application skeleton was not generated");
    const persisted = Buffer.concat([...artifacts.values()]).toString("utf8");
    assert.match(persisted, /publicEntry/);
    assert.doesNotMatch(persisted, new RegExp(sentinel));
    for (const relative of artifacts.keys()) assert.doesNotMatch(relative, /tests|verifier|solution|tasks/);
  } finally {
    await fs.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("all polyglot artifacts are byte-for-byte deterministic and match golden files", async () => {
  const temporary = await copyFixture(path.join(languageFixtures, "polyglot"));
  try {
    const result = await generateOutline({ root: temporary.root });
    const first = await fileMap(result.out);
    await generateOutline({ root: temporary.root });
    const second = await fileMap(result.out);
    assert.deepEqual([...second.keys()], [...first.keys()]);
    for (const [relative, contents] of first) assert.deepEqual(second.get(relative), contents, relative);

    const golden = await fileMap(path.join(languageFixtures, "polyglot-golden"));
    for (const [relative, expected] of golden) assert.deepEqual(first.get(relative), expected, `golden ${relative}`);
  } finally {
    await fs.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("bounded parsing keeps a 500-file polyglot repository comfortably below a catastrophic runtime", { timeout: 30_000 }, async () => {
  const temporary = await temporaryRepository("large-polyglot");
  try {
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 100; index += 1) {
      const cases = [
        [`ts/file-${index}.ts`, `export function ts_${index}(): void {}\n`],
        [`js/file-${index}.js`, `export function js_${index}() {}\n`],
        [`python/file_${index}.py`, `def py_${index}() -> None:\n    pass\n`],
        [`go/file_${index}.go`, `package large\nfunc Go${index}() {}\n`],
        [`rust/file_${index}.rs`, `pub fn rust_${index}() {}\n`],
      ];
      for (const [relative, contents] of cases) {
        const fileName = path.join(temporary.root, relative);
        await fs.mkdir(path.dirname(fileName), { recursive: true });
        writes.push(fs.writeFile(fileName, contents));
      }
    }
    await Promise.all(writes);
    const started = performance.now();
    const result = await generateOutline({ root: temporary.root });
    const elapsed = performance.now() - started;
    assert.equal(result.languages.length, 5);
    assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(result.out, "callgraph.json"), "utf8"))).length, 500);
    assert.ok(elapsed < 15_000, `generation took ${Math.round(elapsed)} ms`);
  } finally {
    await fs.rm(temporary.parent, { recursive: true, force: true });
  }
});
