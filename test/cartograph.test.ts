import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanOutline,
  generateOutline,
  initOutline,
  navigateOutline,
  queryOutline,
  watchOutline,
} from "../src/index.js";

const fixtureRoot = path.resolve(process.cwd(), "test/fixtures/basic/repository");
const expectedRoot = path.resolve(process.cwd(), "test/fixtures/basic/expected");

async function relativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else files.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return files.sort();
}

test("generates deterministic high-level mirrors and removes stale files", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-test-"));
  const repository = path.join(temporaryParent, "repository");
  await fs.cp(fixtureRoot, repository, { recursive: true });
  await fs.mkdir(path.join(repository, "tasks", "private-task", "grader"), { recursive: true });
  await fs.writeFile(
    path.join(repository, "tasks", "private-task", "grader", "grade.py"),
    "SECRET_EXPECTED_ANSWER = 'must never enter agent context'\n",
  );

  try {
    const first = await generateOutline({ root: repository });
    assert.equal(first.filesWritten, 8);
    assert.deepEqual(await relativeFiles(first.out), [
      "AGENTS.md",
      "architecture.md",
      "architecture.mmd",
      "callgraph.json",
      "query.mjs",
      "src/storage/candidate-store.ts",
      "src/types.ts",
      "src/workers/worker-manager.ts",
    ]);
    assert.equal((await relativeFiles(first.out)).some((file) => file.startsWith("tasks/")), false);

    const instructions = await fs.readFile(path.join(first.out, "AGENTS.md"), "utf8");
    assert.match(instructions, /^<!-- @cartograph generated -->/);
    assert.match(instructions, /cartograph query/);
    assert.match(instructions, /query find/);
    assert.match(instructions, /query inspect/);
    assert.match(instructions, /query explore/);
    assert.match(instructions, /query trace/);
    assert.match(instructions, /single smallest artifact/);
    assert.match(instructions, /Never dump `callgraph\.json`/);
    assert.doesNotMatch(instructions, /architecture\.md` first/);
    assert.match(instructions, /cartograph generate/);

    const architecture = await fs.readFile(path.join(first.out, "architecture.md"), "utf8");
    assert.match(architecture, /# Architecture Index/);
    assert.match(architecture, /`src\/workers\/worker-manager\.ts#bootstrap`/);
    assert.match(architecture, /`src\/types\.ts` — 3 type declarations/);
    assert.match(architecture, /## Important execution flows/);
    assert.match(architecture, /## Static Call Roots/);

    const mermaid = await fs.readFile(path.join(first.out, "architecture.mmd"), "utf8");
    assert.match(mermaid, /^%% @cartograph generated\n/);
    assert.match(mermaid, /flowchart LR/);
    assert.match(mermaid, /worker-manager\.ts<br\/>6 callables · 1 type declaration · entry/);
    assert.match(mermaid, /module_2 -->\|calls · creates\| module_0/);
    assert.match(mermaid, /module_2 -\.->\|uses\| dependency_0/);

    const serializedGraph = await fs.readFile(path.join(first.out, "callgraph.json"), "utf8");
    assert.match(await fs.readFile(path.join(first.out, "query.mjs"), "utf8"), /^#!\/usr\/bin\/env node\n\/\/ @cartograph generated\n/);
    const graph = JSON.parse(serializedGraph);
    const processId = "src/workers/worker-manager.ts#WorkerManager.process";
    const findId = "src/storage/candidate-store.ts#CandidateStore.find";
    assert.deepEqual(graph[processId].calls, [findId]);
    assert.deepEqual(graph[findId].calledBy, [processId]);
    assert.deepEqual(graph["src/workers/worker-manager.ts#createWorker"].instantiates,
      ["src/workers/worker-manager.ts#WorkerManager"]);
    assert.deepEqual(graph["src/workers/worker-manager.ts#WorkerManager.map"].unresolvedProjectCalls, ["callback"]);
    assert.deepEqual(graph[processId].externalCalls, ["zod#z.number().parse"]);
    assert.equal(graph[processId].column, 3);
    const query = await queryOutline("WorkerManager.process", { root: repository });
    assert.equal(query.exact, true);
    assert.equal(query.matches[0].id, processId);
    assert.equal(query.matches.some((item) => item.id === findId && item.distance === 1), true);
    const missing = await queryOutline("DefinitelyMissingSymbol", { root: repository });
    assert.deepEqual(missing.matches, []);

    const found = await navigateOutline({ operation: "find", query: "worker process" }, { root: repository });
    assert.equal(found.operation, "find");
    assert.equal(found.matches[0].id, processId);
    assert.deepEqual(Object.keys(found.matches[0]), ["id", "location", "kind", "signature"]);

    const inspected = await navigateOutline({ operation: "inspect", query: "WorkerManager.process" }, { root: repository });
    assert.equal(inspected.operation, "inspect");
    assert.equal(inspected.resolution, "exact");
    assert.equal(inspected.symbol?.id, processId);
    assert.deepEqual(inspected.symbol?.callees.map((item) => item.id), [findId]);
    assert.deepEqual(inspected.symbol?.externalCalls, ["zod#z.number().parse"]);
    assert.equal(JSON.stringify(inspected).includes("bootstrap"), false);

    const explored = await navigateOutline({
      operation: "explore",
      query: "WorkerManager.process",
      direction: "callees",
      depth: 2,
    }, { root: repository });
    assert.equal(explored.operation, "explore");
    assert.deepEqual(explored.nodes?.map((item) => item.id), [processId, findId]);
    assert.deepEqual(explored.edges, [[processId, findId]]);

    const traced = await navigateOutline({
      operation: "trace",
      from: "WorkerManager.process",
      to: "CandidateStore.find",
    }, { root: repository });
    assert.equal(traced.operation, "trace");
    assert.equal(traced.found, true);
    assert.deepEqual(traced.path?.map((item) => item.id), [processId, findId]);
    assert.deepEqual(traced.steps, [{ from: processId, to: findId, relation: "calls" }]);

    await generateOutline({ root: repository });
    assert.equal(await fs.readFile(path.join(first.out, "callgraph.json"), "utf8"), serializedGraph);
    assert.equal(await fs.readFile(path.join(first.out, "architecture.mmd"), "utf8"), mermaid);

    for (const relative of await relativeFiles(expectedRoot)) {
      const actual = await fs.readFile(path.join(first.out, relative), "utf8");
      const expected = await fs.readFile(path.join(expectedRoot, relative), "utf8");
      assert.equal(actual, expected, relative);
    }

    const staleSource = path.join(repository, "src/stale.ts");
    await fs.writeFile(staleSource, "export function stale(): string { return 'stale'; }\n");
    await generateOutline({ root: repository });
    const staleOutput = path.join(first.out, "src/stale.ts");
    assert.equal(await fs.readFile(staleOutput, "utf8").then(() => true), true);
    await fs.unlink(staleSource);

    const second = await generateOutline({ root: repository });
    assert.equal(second.staleFilesRemoved, 1);
    await assert.rejects(fs.access(staleOutput));

    const cleaned = await cleanOutline({ root: repository });
    assert.equal(cleaned, first.out);
    await assert.rejects(fs.access(first.out));
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("resolves native callers, callees, and construction while preserving dynamic calls", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-graph-"));
  const repository = path.join(temporaryParent, "repository");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.writeFile(path.join(repository, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(repository, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
    },
    include: ["src/**/*.ts"],
  }));
  await fs.writeFile(path.join(repository, "src/context.ts"), "export class RunContext {}\n");
  await fs.writeFile(path.join(repository, "src/research.ts"), `
import { RunContext } from "./context.js";

interface ToolRegistry {
  execute(name: string): void;
}

export class ResearchAgent {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  async run(objective: string): Promise<string> {
    this.plan(objective);
    this.delegate();
    this.evaluate();
    new RunContext();
    this.toolRegistry.execute("search");
    return objective;
  }

  private plan(_objective: string): void {}
  private delegate(): void {}
  private evaluate(): void {}
}

export function runResearchCommand(agent: ResearchAgent): Promise<string> {
  return agent.run("new");
}

export function resumeResearchCommand(agent: ResearchAgent): Promise<string> {
  return agent.run("resume");
}
`);

  try {
    const result = await generateOutline({ root: repository });
    const graph = JSON.parse(await fs.readFile(path.join(result.out, "callgraph.json"), "utf8"));
    assert.deepEqual(graph["src/research.ts#ResearchAgent.run"], {
      file: "src/research.ts",
      line: 11,
      column: 3,
      endLine: 18,
      endColumn: 4,
      startByte: 198,
      endByte: 402,
      kind: "method",
      signature: "run(objective: string): Promise<string>",
      calls: [
        "src/research.ts#ResearchAgent.delegate",
        "src/research.ts#ResearchAgent.evaluate",
        "src/research.ts#ResearchAgent.plan",
      ],
      callsInSourceOrder: [
        "src/research.ts#ResearchAgent.plan",
        "src/research.ts#ResearchAgent.delegate",
        "src/research.ts#ResearchAgent.evaluate",
      ],
      calledBy: ["src/research.ts#resumeResearchCommand", "src/research.ts#runResearchCommand"],
      instantiates: ["src/context.ts#RunContext"],
      unresolvedProjectCalls: ["this.toolRegistry.execute"],
    });
    assert.equal(graph["src/context.ts#RunContext"].kind, "class");
    assert.equal(graph["src/context.ts#RunContext"].signature, "class RunContext");
    const inspectedType = await navigateOutline({ operation: "inspect", query: "RunContext" }, { root: repository });
    assert.equal(inspectedType.operation, "inspect");
    assert.equal(inspectedType.resolution, "exact");
    assert.equal(inspectedType.symbol?.id, "src/context.ts#RunContext");
    assert.equal(inspectedType.symbol?.kind, "class");
    assert.deepEqual(inspectedType.symbol?.callees, []);
    assert.deepEqual(inspectedType.symbol?.callers, []);
    const outline = await fs.readFile(path.join(result.out, "src/research.ts"), "utf8");
    assert.match(outline, /\/\/ Structural relationships:\n\s*\/\/ call:\n\s*\/\/\s+src\/research\.ts#ResearchAgent\.plan/);
    assert.doesNotMatch(outline, /"Calls:/);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("promotes statically supplied callbacks into navigable call edges", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-callbacks-"));
  const repository = path.join(temporaryParent, "repository");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.writeFile(path.join(repository, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(repository, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src/**/*.ts"],
  }));
  await fs.writeFile(path.join(repository, "src/callbacks.ts"), `
export function dispatch(value: string, callback: (value: string) => void): void {
  callback(value);
}
export function persist(_value: string): void {}
export function notify(_value: string): void {}
export function run(): void {
  dispatch("stored", persist);
  dispatch("sent", notify);
}
`);
  try {
    const result = await generateOutline({ root: repository });
    const graph = JSON.parse(await fs.readFile(path.join(result.out, "callgraph.json"), "utf8"));
    const prefix = "src/callbacks.ts#";
    assert.deepEqual(graph[`${prefix}dispatch`].calls, [`${prefix}notify`, `${prefix}persist`]);
    assert.deepEqual(graph[`${prefix}dispatch`].callsInSourceOrder, [`${prefix}persist`, `${prefix}notify`]);
    assert.deepEqual(graph[`${prefix}dispatch`].unresolvedProjectCalls, ["callback"]);
    assert.deepEqual(graph[`${prefix}notify`].calledBy, [`${prefix}dispatch`]);
    assert.deepEqual(graph[`${prefix}persist`].calledBy, [`${prefix}dispatch`]);
    assert.deepEqual(graph[`${prefix}run`].calls, [`${prefix}dispatch`]);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("keeps same-named symbols stable and makes short queries explicitly ambiguous", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-symbol-ids-"));
  const repository = path.join(temporaryParent, "repository");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.writeFile(path.join(repository, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(repository, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src/**/*.ts"],
  }));
  await fs.writeFile(path.join(repository, "src/alpha.ts"), "export function run(): void {}\n");
  await fs.writeFile(path.join(repository, "src/beta.ts"), "export function run(): void {}\n");
  await fs.writeFile(path.join(repository, "src/main.ts"), `
import { run as runAlpha } from "./alpha.js";
import { run as runBeta } from "./beta.js";
export function start(): void { runAlpha(); runBeta(); }
`);

  try {
    const result = await generateOutline({ root: repository });
    const graph = JSON.parse(await fs.readFile(path.join(result.out, "callgraph.json"), "utf8"));
    const alpha = "src/alpha.ts#run";
    const beta = "src/beta.ts#run";
    const start = "src/main.ts#start";
    assert.deepEqual(Object.keys(graph).sort(), [alpha, beta, start]);
    assert.deepEqual(graph[start].calls, [alpha, beta]);
    assert.deepEqual(graph[alpha].calledBy, [start]);
    assert.deepEqual(graph[beta].calledBy, [start]);

    const ambiguous = await queryOutline("run", { root: repository });
    assert.equal(ambiguous.exact, false);
    assert.deepEqual(ambiguous.matches.map((match) => match.id), [alpha, beta]);
    const inspected = await navigateOutline({ operation: "inspect", query: "run" }, { root: repository });
    assert.equal(inspected.operation, "inspect");
    assert.equal(inspected.resolution, "ambiguous");
    assert.equal(inspected.symbol, undefined);
    assert.deepEqual(inspected.candidates?.map((candidate) => candidate.id), [alpha, beta]);
    const qualified = await queryOutline(alpha, { root: repository });
    assert.equal(qualified.exact, true);
    assert.equal(qualified.matches.some((match) => match.id === start && match.distance === 1), true);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("init creates and idempotently updates only its managed AGENTS.md section", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-init-"));
  const repository = path.join(temporaryParent, "repository");
  await fs.mkdir(repository);

  try {
    const created = await initOutline({ root: repository });
    assert.equal(created.created, true);
    assert.equal(created.changed, true);
    const initial = await fs.readFile(created.agentsFile, "utf8");
    assert.match(initial, /<!-- cartograph:start -->/);
    assert.match(initial, /cartograph query/);
    assert.match(initial, /Use one smallest-fit aid first/);
    assert.doesNotMatch(initial, /architecture\.md` first/);

    const unchanged = await initOutline({ root: repository });
    assert.equal(unchanged.changed, false);
    assert.equal(await fs.readFile(created.agentsFile, "utf8"), initial);

    const userInstructions = `# Repository Rules\n\nKeep this text.\n\n${initial.trim()}\n\nFinal user note.\n`;
    await fs.writeFile(created.agentsFile, userInstructions);
    const updated = await initOutline({ root: repository, out: ".agent-map" });
    assert.equal(updated.created, false);
    assert.equal(updated.changed, true);
    const final = await fs.readFile(created.agentsFile, "utf8");
    assert.match(final, /^# Repository Rules/);
    assert.match(final, /Keep this text\./);
    assert.match(final, /Final user note\./);
    assert.match(final, /\.agent-map\/query\.mjs/);
    assert.doesNotMatch(final, /\.agent-map\/AGENTS\.md/);
    assert.equal((final.match(/<!-- cartograph:start -->/g) ?? []).length, 1);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("generate never modifies a root AGENTS.md", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-boundary-"));
  const repository = path.join(temporaryParent, "repository");
  await fs.cp(fixtureRoot, repository, { recursive: true });
  const agentsFile = path.join(repository, "AGENTS.md");
  const instructions = "# User-owned instructions\n";
  await fs.writeFile(agentsFile, instructions);

  try {
    await generateOutline({ root: repository });
    assert.equal(await fs.readFile(agentsFile, "utf8"), instructions);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("refuses output paths that could modify the source repository", async () => {
  await assert.rejects(generateOutline({ root: fixtureRoot, out: "." }), /child of the repository root/);
  await assert.rejects(generateOutline({ root: fixtureRoot, out: ".." }), /child of the repository root/);
});

test("refuses output symlinks that could escape the repository", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-symlink-"));
  const repository = path.join(temporaryParent, "repository");
  const outside = path.join(temporaryParent, "outside");
  await fs.cp(fixtureRoot, repository, { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(repository, ".cartograph"), "dir");

  try {
    await assert.rejects(generateOutline({ root: repository }), /must not contain symbolic links/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("watch regenerates after source changes", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "cartograph-watch-"));
  const repository = path.join(temporaryParent, "repository");
  await fs.cp(fixtureRoot, repository, { recursive: true });
  let generationCount = 0;
  let resolveRegeneration: (() => void) | undefined;
  const regenerated = new Promise<void>((resolve) => {
    resolveRegeneration = resolve;
  });

  const handle = await watchOutline(
    { root: repository },
    () => {
      generationCount += 1;
      if (generationCount >= 2) resolveRegeneration?.();
    },
    (error) => {
      throw error;
    },
  );

  try {
    await fs.writeFile(path.join(repository, "src/new-worker.ts"), "export class NewWorker { run(): void {} }\n");
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        regenerated,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("watch did not regenerate")), 5_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const generated = await fs.readFile(path.join(repository, ".cartograph/src/new-worker.ts"), "utf8");
    assert.match(generated, /export class NewWorker/);
    assert.match(generated, /run\(\): void \{ \}/);
  } finally {
    handle.close();
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});
