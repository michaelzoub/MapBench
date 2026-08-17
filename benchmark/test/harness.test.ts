import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateCost, parsePiEvents } from "../events.js";
import { assertWorkspaceOutputPath, assertWorkspacePath, assertWorkspacePattern } from "../path-policy.js";
import { parseConditionSelection, runBenchmarkCli } from "../cli.js";
import { createAuthoredEval, validateAuthoredGroundTruth } from "../author-eval.js";
import { materializeExampleRepository } from "../examples.js";
import { analyzeNavigation, emptyNavigationMetrics } from "../navigation.js";
import { fetchOpenRouterPricing, openRouterModelId } from "../pricing.js";
import { runProcess } from "../process.js";
import { DEFAULT_BENCHMARK_THINKING, isolatedPiEnvironment, piCommand, runBenchmark } from "../runner.js";
import { scaffoldEvalTask } from "../scaffold.js";
import { buildSummary } from "../summary.js";
import type { CheckResult, Condition, GraderResult, RunResult, TokenUsage } from "../types.js";
import { CONDITION_FACTORS, CONDITIONS, DEFAULT_CONDITIONS } from "../types.js";
import { assertGraderOutsideWorkspace, commitBaseline, COMPONENTS, conditionInstructions, createWorkspace, prepareCondition, removeDockerWorkspace, removePrivateTaskFromWorkspace, startDockerWorkspace } from "../workspace.js";

const passCheck: CheckResult = { status: "passed", command: ["true"], exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
const grader = (score: number): GraderResult => ({ ...passCheck, score, maxScore: 1, passed: score === 1, details: {} });
const tokenUsage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  input: 100,
  uncachedInput: 80,
  cachedInput: 20,
  output: 30,
  reasoning: 5,
  total: 130,
  provenance: {
    source: "pi-jsonl",
    eventType: "message_end",
    eventLines: [1],
    rawEventFile: null,
    fields: {
      input: "derived: message.usage.input + cacheRead + cacheWrite",
      uncachedInput: "derived: message.usage.input + cacheWrite",
      cachedInput: "message.usage.cacheRead",
      output: "message.usage.output",
      reasoning: "message.usage.reasoning",
      total: "message.usage.totalTokens",
    },
  },
  ...overrides,
});

function fakeRun(condition: Condition, pairId: string, score: number, overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 3, pairId, taskId: "task", condition, run: 1, targetCommit: "a", baselineCommit: "b",
    baselineTreeHash: "tree", promptSha256: "prompt", provider: "openai-codex", model: "fixed",
    status: "completed", exitCode: 0, durationMs: 1000, tokens: tokenUsage(),
    estimatedCostUsd: 0.01, commands: [], commandCount: 2, failedCommandCount: 0, finalResponse: "done", filesChanged: ["src/a.ts"], fileCount: 1,
    navigation: emptyNavigationMetrics(),
    hiddenGrader: grader(score), checks: { regression: passCheck, typecheck: passCheck, build: passCheck }, artifactDirectory: "regular-code/task/run-001", workspaceKept: false,
    isolation: { harness: "pi", freshProcess: true, resumedSession: false, ephemeralSession: true, freshWorkspace: true,
      originalGitObjectsRemoved: true, piHome: "fresh-auth-only", initialPiHomeFiles: ["auth.json"], piHomeRemoved: true,
      contextFiles: "disabled", resources: "explicit-extension-only", tools: "workspace-read-only" },
    ...overrides,
  };
}

async function makeGitRepository(root: string): Promise<{ repo: string; commit: string }> {
  const repo = path.join(root, "source");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(repo, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}\n');
  await fs.writeFile(path.join(repo, "src", "main.ts"), "export function outer(): number { return inner(); }\nfunction inner(): number { return 1; }\n");
  await fs.writeFile(path.join(repo, "AGENTS.md"), "# User rules\n\nKeep me.\n\n<!-- cartograph:start -->\n## Cartograph\n\nRead every generated aid.\n<!-- cartograph:end -->\n");
  for (const args of [["init", "-q"], ["config", "user.email", "test@invalid.local"], ["config", "user.name", "Test"], ["add", "-A"], ["commit", "-qm", "fixture"]]) {
    const result = await runProcess(["git", ...args], { cwd: repo, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const commit = (await runProcess(["git", "rev-parse", "HEAD"], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();
  return { repo, commit };
}

test("workspace materializes the exact commit, removes its original object database, and never mutates the source repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-isolation-"));
  try {
    const { repo, commit } = await makeGitRepository(root);
    const workspace = await createWorkspace(repo, commit, "run", path.join(root, "workspaces"));
    assert.notEqual(path.resolve(workspace), path.resolve(repo));
    assert.match(await fs.readFile(path.join(workspace, "src", "main.ts"), "utf8"), /outer/);
    const oldObject = await runProcess(["git", "cat-file", "-e", `${commit}^{commit}`], { cwd: workspace, timeoutMs: 10_000 });
    assert.notEqual(oldObject.exitCode, 0, "the sanitized repository must not retain the source repository's objects");
    await fs.writeFile(path.join(workspace, "src", "main.ts"), "changed\n");
    assert.match(await fs.readFile(path.join(repo, "src", "main.ts"), "utf8"), /outer/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("treatments expose only isolated .mapbench artifacts and matching instructions", { timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-ablation-"));
  try {
    const { repo, commit } = await makeGitRepository(root);
    for (const condition of CONDITIONS) {
      const workspace = await createWorkspace(repo, commit, condition, path.join(root, "workspaces"));
      const privateDirectory = path.join(root, "private", condition);
      const prepared = await prepareCondition(workspace, condition, privateDirectory);
      const exists = async (relative: string): Promise<boolean> => await fs.access(path.join(workspace, relative)).then(() => true, () => false);
      const components = COMPONENTS[condition];
      assert.equal(await exists("src/main.ts"), true, `${condition} must retain the complete source tree`);
      assert.equal(await exists(".mapbench"), components.architecture || components.skeleton);
      assert.equal(await exists(".mapbench/AGENTS.md"), false);
      assert.equal(await exists(".mapbench/architecture.md"), components.architecture, `${condition} architecture`);
      assert.equal(await exists(".mapbench/skeleton/src"), components.skeleton, `${condition} skeleton`);
      assert.equal(await exists(".mapbench/callgraph.json"), false, `${condition} hidden IR projection`);
      assert.equal(await exists(".mapbench/query.mjs"), false, `${condition} hidden helper`);
      assert.equal(await exists(".cartograph"), false, `${condition} legacy output`);
      assert.equal(await exists(".project-outline"), false, `${condition} previous benchmark output`);
      assert.equal(await exists(".mapbench-cartograph-analysis"), false, `${condition} private analysis output`);
      const rootAgents = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
      assert.match(rootAgents, /Keep me/);
      assert.doesNotMatch(rootAgents, /cartograph:start/);
      assert.equal(prepared.callgraphHelper !== null, components.callgraph);
      assert.equal(await fs.access(path.join(privateDirectory, "callgraph.json")).then(() => true, () => false), components.callgraph);
      const instructions = conditionInstructions(condition);
      if (components.architecture) assert.match(instructions, /architecture\.md/);
      else assert.doesNotMatch(instructions, /architecture\.md/);
      if (components.skeleton) assert.match(instructions, /skeleton/);
      else assert.doesNotMatch(instructions, /skeleton/);
      if (components.callgraph) assert.match(instructions, /mapbench_query/);
      else assert.doesNotMatch(instructions, /mapbench_query/);
      assert.match(instructions, /complete real repository source/);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("conditions form the complete three-factor artifact matrix", () => {
  assert.equal(CONDITIONS.length, 8);
  const signatures = CONDITIONS.map((condition) => Object.values(CONDITION_FACTORS[condition]).map(Number).join(""));
  assert.equal(new Set(signatures).size, 8);
  assert.deepEqual(new Set(signatures), new Set(Array.from({ length: 8 }, (_, value) => value.toString(2).padStart(3, "0"))));
});

test("default conditions compare regular code with each single artifact and Full MapBench", () => {
  assert.deepEqual(DEFAULT_CONDITIONS, [
    "regular-code",
    "outline-only",
    "callgraph-only",
    "skeleton-only",
    "all-outline-aids",
  ]);
  assert.equal(new Set(DEFAULT_CONDITIONS).size, 5);
  for (const condition of DEFAULT_CONDITIONS.filter((item) => item !== "all-outline-aids")) {
    const factors = CONDITION_FACTORS[condition];
    const artifactCount = Number(factors.outline) + Number(factors.skeleton) + Number(factors.callgraph);
    assert.ok(artifactCount <= 1, `${condition} unexpectedly combines generated artifacts`);
  }
  assert.deepEqual(CONDITION_FACTORS["all-outline-aids"], { outline: true, skeleton: true, callgraph: true });
});

test("condition presets select targeted defaults or the optional factorial", () => {
  assert.deepEqual(parseConditionSelection("targeted"), DEFAULT_CONDITIONS);
  assert.deepEqual(parseConditionSelection("factorial"), CONDITIONS);
  assert.deepEqual(parseConditionSelection("regular-code,outline-only,regular-code"), ["regular-code", "outline-only"]);
  assert.throws(() => parseConditionSelection("guidance-only"), /Unknown benchmark condition/);
  assert.throws(() => parseConditionSelection("no-agents"), /Unknown benchmark condition/);
});

test("legacy result IDs project onto the current artifact-only conditions", () => {
  const legacy = { ...fakeRun("regular-code", "legacy", 1), condition: "no-callgraph" as Condition };
  const summary = buildSummary([legacy], "2026-01-01T00:00:00.000Z");
  assert.deepEqual(summary.conditions.map((item) => item.condition), ["skeleton-only"]);
});

test("private graders must be outside the Pi workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-grader-isolation-"));
  try {
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "private-grader");
    await fs.mkdir(path.join(workspace, "hidden"), { recursive: true });
    await fs.mkdir(external);
    await assertGraderOutsideWorkspace(workspace, external);
    await assert.rejects(assertGraderOutsideWorkspace(workspace, path.join(workspace, "hidden")), /outside/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Pi read-tool path policy accepts source but rejects traversal, private Git data, and escaping symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-path-policy-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(workspace, "src", "main.ts"), "export {};\n");
    await fs.writeFile(path.join(outside, "secret.txt"), "private\n");
    await fs.symlink(outside, path.join(workspace, "escape"));
    await assertWorkspacePath(workspace, "src/main.ts");
    await assertWorkspaceOutputPath(workspace, "src/new-file.ts");
    await assert.rejects(assertWorkspacePath(workspace, "../outside/secret.txt"), /only access the benchmark workspace/);
    await assert.rejects(assertWorkspacePath(workspace, ".git"), /private to the MapBench harness/);
    await assert.rejects(assertWorkspacePath(workspace, "escape/secret.txt"), /only access the benchmark workspace/);
    await assert.rejects(assertWorkspaceOutputPath(workspace, "escape/new-file.ts"), /only access the benchmark workspace/);
    assert.throws(() => assertWorkspacePattern("../**", "Find patterns"), /inside the workspace/);
    assert.throws(() => assertWorkspacePattern(path.join(outside, "*"), "Grep globs"), /inside the workspace/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("repository-edit bash runs in the selected no-network Docker environment with CPU and memory limits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-docker-policy-"));
  const previousDocker = process.env.MAPBENCH_DOCKER;
  try {
    const workspace = path.join(root, "workspace");
    const log = path.join(root, "docker-calls.jsonl");
    const fakeDocker = path.join(root, "fake-docker.mjs");
    await fs.mkdir(workspace);
    await fs.writeFile(fakeDocker, `#!/usr/bin/env node
const fs = await import("node:fs/promises");
await fs.appendFile(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "create") console.log("container-id");
`);
    await fs.chmod(fakeDocker, 0o755);
    process.env.MAPBENCH_DOCKER = fakeDocker;
    const container = await startDockerWorkspace("example/image-v1.1", workspace, {
      cpus: 2, memoryMb: 4096, storageMb: 8192, gpus: 1,
    });
    assert.equal(container, "container-id");
    await removeDockerWorkspace(container);
    const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const create = calls[0];
    assert.deepEqual(create.slice(0, 5), ["create", "--network", "none", "--workdir", "/app"]);
    assert.equal(create[create.indexOf("--cpus") + 1], "2");
    assert.equal(create[create.indexOf("--memory") + 1], "4096m");
    assert.equal(create.includes("--storage-opt"), false, "bind-mounted workspace storage is provenance, not a falsely claimed Docker quota");
    assert.equal(create[create.indexOf("--gpus") + 1], "1");
    assert.match(create[create.indexOf("--mount") + 1], /target=\/app$/);
    assert.deepEqual(calls.at(-1), ["rm", "--force", "container-id"]);
  } finally {
    if (previousDocker === undefined) delete process.env.MAPBENCH_DOCKER;
    else process.env.MAPBENCH_DOCKER = previousDocker;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project-local task files are removed from the agent workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-private-task-"));
  try {
    const { repo } = await makeGitRepository(root);
    const task = path.join(repo, "tasks", "private-task");
    await fs.mkdir(path.join(task, "grader"), { recursive: true });
    await fs.writeFile(path.join(task, "grader", "expected.json"), "secret oracle\n");
    for (const args of [["add", "-A"], ["commit", "-qm", "add local eval"]]) {
      const result = await runProcess(["git", ...args], { cwd: repo, timeoutMs: 10_000 });
      assert.equal(result.exitCode, 0, result.stderr);
    }
    const commit = (await runProcess(["git", "rev-parse", "HEAD"], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();
    const workspace = await createWorkspace(repo, commit, "run", path.join(root, "workspaces"));
    assert.equal(await fs.access(path.join(workspace, "tasks", "private-task", "grader", "expected.json")).then(() => true, () => false), true);
    assert.equal(await removePrivateTaskFromWorkspace(workspace, repo, path.join(repo, "tasks")), "tasks");
    assert.equal(await fs.access(path.join(workspace, "tasks")).then(() => true, () => false), false);
    await commitBaseline(workspace);
    const historyLeak = await runProcess(["git", "log", "--all", "-Ssecret oracle", "--format=%H"], { cwd: workspace, timeoutMs: 10_000 });
    assert.equal(historyLeak.stdout.trim(), "", "removed grader contents must not survive in the sanitized Git history");
    const oldCommitLeak = await runProcess(["git", "show", `${commit}:tasks/private-task/grader/expected.json`], { cwd: workspace, timeoutMs: 10_000 });
    assert.notEqual(oldCommitLeak.exitCode, 0, "the source commit must be unreachable from the benchmark workspace");
    assert.match(await fs.readFile(path.join(repo, "tasks", "private-task", "grader", "expected.json"), "utf8"), /secret oracle/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("custom eval scaffold grades real expected artifacts and rejects decoys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-scaffold-"));
  try {
    const { repo } = await makeGitRepository(root);
    const tasksRoot = path.join(root, "tasks");
    const task = await scaffoldEvalTask({ tasksRoot, id: "find-entrypoint", title: "Find entrypoint" });
    await assert.rejects(scaffoldEvalTask({ tasksRoot, id: "find-entrypoint" }), /already exists/);
    const expected = path.join(task, "grader", "expected.json");
    await fs.writeFile(expected, JSON.stringify({
      requiredFiles: ["src/main.ts"],
      requiredSymbols: [{ name: "outer", path: "src/main.ts" }],
    }));
    const answer = path.join(root, "answer.json");
    const graderPath = path.join(task, "grader", "grade.mjs");
    await fs.writeFile(answer, JSON.stringify({ files: [{ path: "src/main.ts" }], symbols: [{ name: "outer", path: "src/main.ts" }] }));
    const positive = await runProcess([process.execPath, graderPath, answer, repo], { cwd: repo, timeoutMs: 10_000 });
    assert.equal(positive.exitCode, 0, positive.stdout + positive.stderr);
    assert.deepEqual(JSON.parse(positive.stdout.trim()).metrics, { fileRecall: 1, symbolRecall: 1 });
    await fs.writeFile(answer, JSON.stringify({ files: [{ path: "src/decoy.ts" }], symbols: [{ name: "unrelated", path: "src/decoy.ts" }] }));
    const negative = await runProcess([process.execPath, graderPath, answer, repo], { cwd: repo, timeoutMs: 10_000 });
    assert.notEqual(negative.exitCode, 0);
    assert.equal(JSON.parse(negative.stdout.trim()).passed, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Pi-authored eval creation grounds its grader and exercises the real positive and negative controls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-authored-eval-"));
  try {
    const { repo } = await makeGitRepository(root);
    const created = await createAuthoredEval({
      repo,
      tasksRoot: path.join(root, "tasks"),
      id: "explain-outer",
      title: "Explain outer",
      question: "Which symbol is the public entry point and what does it call?",
      model: "fixed",
      author: async (workspace) => {
        assert.match(await fs.readFile(path.join(workspace, "src", "main.ts"), "utf8"), /outer/);
        return { requiredFiles: ["src/main.ts"], requiredSymbols: [{ name: "outer", path: "src/main.ts" }] };
      },
    });
    assert.equal(created.expected.requiredFiles[0], "src/main.ts");
    assert.match(await fs.readFile(path.join(created.directory, "prompt.md"), "utf8"), /Which symbol is the public entry point/);
    const authorship = JSON.parse(await fs.readFile(path.join(created.directory, "grader", "authoring.json"), "utf8"));
    assert.deepEqual(authorship.validation, {
      repositoryPaths: true, symbolOccurrences: true, positiveControl: true, negativeControl: true,
    });
    await assert.rejects(validateAuthoredGroundTruth(repo, {
      requiredFiles: ["src/main.ts"], requiredSymbols: [{ name: "HallucinatedSymbol", path: "src/main.ts" }],
    }), /does not contain/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("benchmark ask non-interactively runs the one-command authored-eval path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-ask-cli-"));
  const previousPi = process.env.MAPBENCH_PI;
  try {
    const { repo } = await makeGitRepository(root);
    const fakePi = path.join(root, "fake-pi.mjs");
    await fs.writeFile(fakePi, `#!/usr/bin/env node
const answer = JSON.stringify({ requiredFiles: ["src/main.ts"], requiredSymbols: [{ name: "outer", path: "src/main.ts" }], rationale: ["grounded"] });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 4, reasoning: 0, totalTokens: 14 } } }));
`);
    await fs.chmod(fakePi, 0o755);
    process.env.MAPBENCH_PI = fakePi;
    const tasksRoot = path.join(root, "tasks");
    await runBenchmarkCli(["ask", "--repo", repo, "--tasks", tasksRoot, "--task", "Explain Outer", "--question", "Where does outer delegate?", "--no-run"]);
    const directory = path.join(tasksRoot, "explain-outer");
    assert.equal(await fs.access(directory).then(() => true), true);
  } finally {
    if (previousPi === undefined) delete process.env.MAPBENCH_PI;
    else process.env.MAPBENCH_PI = previousPi;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Pi JSONL parsing accounts for tokens, reasoning, tool calls, and failures", () => {
  const input = [
    { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/main.ts", offset: 1, limit: 20 } },
    { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "source" }] }, isError: false },
    { type: "tool_execution_start", toolCallId: "query-1", toolName: "mapbench_query", args: { operation: "find", query: "missing" } },
    { type: "tool_execution_end", toolCallId: "query-1", toolName: "mapbench_query", result: { content: [{ type: "text", text: "not found" }] }, isError: true },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 60, cacheRead: 40, cacheWrite: 0, output: 30, reasoning: 10, totalTokens: 130 } } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parsePiEvents(input);
  assert.deepEqual(parsed.tokens, {
    input: 100,
    uncachedInput: 60,
    cachedInput: 40,
    output: 30,
    reasoning: 10,
    total: 130,
    provenance: {
      source: "pi-jsonl",
      eventType: "message_end",
      eventLines: [5],
      rawEventFile: null,
      fields: {
        input: "derived: message.usage.input + cacheRead + cacheWrite",
        uncachedInput: "derived: message.usage.input + cacheWrite",
        cachedInput: "message.usage.cacheRead",
        output: "message.usage.output",
        reasoning: "message.usage.reasoning",
        total: "message.usage.totalTokens",
      },
    },
  });
  assert.equal(parsed.usageEvents.length, 1);
  assert.equal(parsed.commands.length, 2);
  assert.equal(parsed.commands.filter((command) => command.failed).length, 1);
  assert.equal(parsed.finalResponse, "done");
  assert.equal(estimateCost(parsed.tokens, { inputPerMillion: 10, cachedInputPerMillion: 2, outputPerMillion: 20 }), 0.00128);
  assert.equal(estimateCost(parsed.tokens, { inputPerMillion: 10, cachedInputPerMillion: 2, outputPerMillion: 20, reasoningPerMillion: 999 }), 0.00128);
});

test("Pi JSONL parsing records exact wall time to the first source-code edit", () => {
  const input = [
    { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "src/main.ts" } },
    { type: "tool_execution_end", toolCallId: "read", toolName: "read", result: {}, isError: false },
    { type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "src/main.ts", content: "changed" } },
    { type: "tool_execution_end", toolCallId: "write", toolName: "write", result: {}, isError: false },
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parsePiEvents(input, [45, 300, 725, 900]);
  assert.deepEqual(parsed.editNavigation, {
    firstSourceEditObserved: true,
    elapsedMs: 900,
    eventLine: 4,
  });
});

test("Pi source-edit timing recognizes mutating Docker bash commands", () => {
  const input = [
    { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "sed -i.bak 's/old/new/' main.go" } },
    { type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: {}, isError: false },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(parsePiEvents(input, [10, 180]).editNavigation, {
    firstSourceEditObserved: true,
    elapsedMs: 180,
    eventLine: 2,
  });
});

test("token parsing derives exact Pi totals and leaves unavailable fields null", () => {
  const parsed = parsePiEvents(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [], usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3 } },
  }));
  assert.equal(parsed.tokens.input, 12);
  assert.equal(parsed.tokens.uncachedInput, 10);
  assert.equal(parsed.tokens.cachedInput, 2);
  assert.equal(parsed.tokens.output, 3);
  assert.equal(parsed.tokens.reasoning, null);
  assert.equal(parsed.tokens.total, 15);
  assert.equal(parsed.tokens.provenance.fields.total, "derived: total input + message.usage.output");
  assert.equal(estimateCost(parsed.tokens, { inputPerMillion: 1, cachedInputPerMillion: 1, outputPerMillion: 1 }), 0.000015);

  const missing = parsePiEvents('{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":12}}}');
  assert.equal(missing.tokens.uncachedInput, null);
  assert.equal(missing.tokens.output, null);
  assert.equal(missing.tokens.total, null);

  const cacheWrite = parsePiEvents('{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":2,"cacheRead":3,"cacheWrite":4,"output":1}}}');
  assert.equal(cacheWrite.tokens.input, 9);
  assert.equal(cacheWrite.tokens.uncachedInput, 6);
});

test("navigation telemetry measures real outline/source access and rejects decorative path mentions", () => {
  const input = [
    { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: ".mapbench/skeleton/src/a.ts", offset: 1, limit: 100 } },
    { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: {}, isError: false },
    { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: { path: "src/a.ts", offset: 50, limit: 101 } },
    { type: "tool_execution_end", toolCallId: "2", toolName: "read", result: {}, isError: false },
    { type: "tool_execution_start", toolCallId: "3", toolName: "read", args: { path: "src/a.ts", offset: 100, limit: 101 } },
    { type: "tool_execution_end", toolCallId: "3", toolName: "read", result: {}, isError: true },
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parsePiEvents(input);
  assert.equal(parsed.commands[0].navigation, "outline");
  const metrics = analyzeNavigation(parsed.commands);
  assert.equal(metrics.outlineAccessCommandCount, 1);
  assert.equal(metrics.sourceAccessCommandCount, 2);
  assert.equal(metrics.failedNavigationCommandCount, 1);
  assert.equal(metrics.duplicateSourceReadCount, 1);
  assert.equal(metrics.duplicateSourceReadLines, 51);
  assert.equal(metrics.outlineUsed, true);
});

test("live OpenRouter pricing is converted from per-token API values and retains provenance", async () => {
  let requested = "";
  const resolution = await fetchOpenRouterPricing("gpt-5.6-terra", undefined, {
    fetch: (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({
        data: {
          id: "openai/gpt-5.6-terra",
          canonical_slug: "openai/gpt-5.6-terra-20260709",
          pricing: {
            prompt: "0.000001",
            completion: "0.000006",
            input_cache_read: "0.0000001",
            overrides: [{ min_prompt_tokens: 272000, prompt: "0.000002" }],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }),
    apiBase: "https://pricing.invalid/api/v1/",
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  assert.equal(requested, "https://pricing.invalid/api/v1/model/openai/gpt-5.6-terra");
  assert.deepEqual(resolution.pricing, {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6,
  });
  assert.equal(resolution.providerModel, "openai/gpt-5.6-terra");
  assert.equal(resolution.sourceUrl, "https://pricing.invalid/api/v1/model/openai/gpt-5.6-terra");
  assert.equal(resolution.canonicalModel, "openai/gpt-5.6-terra-20260709");
  assert.equal(resolution.fetchedAt, "2026-08-06T12:00:00.000Z");
  assert.equal(resolution.warnings.length, 1);
});

test("pricing rejects malformed provider data instead of reporting a fake zero cost", async () => {
  await assert.rejects(fetchOpenRouterPricing("custom", "vendor/custom", {
    fetch: (async () => new Response(JSON.stringify({
      data: { id: "vendor/custom", pricing: { prompt: "free-ish", completion: "0.1" } },
    }), { status: 200 })),
  }), /invalid prompt pricing/);
  assert.equal(openRouterModelId("claude-opus-4"), "anthropic/claude-opus-4");
  assert.throws(() => openRouterModelId("private-deployment"), /Cannot infer/);
});
test("MapBench Pi commands gate write tools on the isolated coding mode", () => {
  const command = piCommand("openai-codex", "gpt-5.6-terra", "outline-only", "prompt");
  assert.equal(command[command.indexOf("--model") + 1], "gpt-5.6-terra");
  assert.equal(command[command.indexOf("--provider") + 1], "openai-codex");
  assert.equal(DEFAULT_BENCHMARK_THINKING, "low");
  for (const flag of ["--no-session", "--no-context-files", "--no-builtin-tools", "--no-skills", "--no-prompt-templates", "--no-themes"]) {
    assert.equal(command.includes(flag), true, flag);
  }
  assert.equal(command[command.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.equal(command.includes("bash"), false);
  assert.equal(command.includes("mapbench_query"), false);
  assert.match(command[command.indexOf("--append-system-prompt") + 1], /architecture\.md/);
  assert.doesNotMatch(command[command.indexOf("--append-system-prompt") + 1], /mapbench_query/);

  const callgraph = piCommand("openai-codex", "gpt-5.6-terra", "callgraph-only", "prompt");
  assert.equal(callgraph[callgraph.indexOf("--tools") + 1], "read,grep,find,ls,mapbench_query");
  assert.doesNotMatch(callgraph[callgraph.indexOf("--append-system-prompt") + 1], /architecture\.md|skeleton/);

  const coding = piCommand("openai-codex", "gpt-5.6-terra", "regular-code", "prompt", "isolated-read-write");
  assert.equal(coding[coding.indexOf("--tools") + 1], "read,grep,find,ls,edit,write,bash");
  assert.equal(coding.includes("mapbench_query"), false);

  const architectureCoding = piCommand("openai-codex", "gpt-5.6-terra", "outline-only", "prompt", "isolated-read-write");
  assert.equal(architectureCoding[architectureCoding.indexOf("--tools") + 1], "read,grep,find,ls,edit,write,bash");
  assert.match(architectureCoding[architectureCoding.indexOf("--append-system-prompt") + 1], /architecture\.md|complete real repository source/);
  assert.doesNotMatch(architectureCoding[architectureCoding.indexOf("--append-system-prompt") + 1], /mapbench_query|skeleton/);

  const readOnlyEnvironment = isolatedPiEnvironment("/tmp/pi-home", null);
  assert.equal(readOnlyEnvironment.MAPBENCH_DOCKER_CONTAINER, undefined);
  const isolatedWriteEnvironment = isolatedPiEnvironment("/tmp/pi-home", null, "task-container");
  assert.equal(isolatedWriteEnvironment.MAPBENCH_DOCKER_CONTAINER, "task-container");
});

test("architecture answer graders accept repository facts and reject decoys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-architecture-graders-"));
  try {
    const { repo } = await makeGitRepository(root);
    const grader = path.resolve("benchmark/graders/grade_json.py");
    const answers: Record<string, unknown> = {
      "map-project": {
        entrypoint: { metadata_path: "setup.cfg", command: "autore", target: "research_harness.cli:main" },
        components: [
          ["research_harness/cli.py", "main"],
          ["research_harness/orchestrator.py", "Orchestrator"],
          ["research_harness/research_agent.py", "ResearchAgent"],
          ["research_harness/agent_loop.py", "AgentLoop"],
          ["research_harness/agent_state.py", "AgentState"],
          ["research_harness/tools/base.py", "ToolRegistry"],
          ["research_harness/store.py", "ArtifactStore"],
          ["research_harness/validation/final_answer.py", "FinalAnswerValidator"],
        ].map(([componentPath, symbol]) => ({ path: componentPath, symbol, responsibility: "verified" })),
        runtime_flow: [
          "cli.main", "Orchestrator.run", "ResearchAgent.with_research_tools", "ResearchAgent.arun",
          "AgentLoop.run", "FinalAnswerValidator",
        ],
        state_owner: { path: "research_harness/agent_state.py", symbol: "AgentState" },
      },
      "pinpoint-worker-delegation": {
        primary_file: "research_harness/worker_registry.py",
        assembly: { path: "research_harness/research_agent.py", symbol: "ResearchAgent.with_research_tools" },
        tool_entry: { path: "research_harness/worker_registry.py", symbol: "DelegateTaskTool.execute" },
        admission: { path: "research_harness/worker_registry.py", symbol: "WorkerRegistry.delegate" },
        capacity_symbols: [
          "WorkerRegistry._reserve_budget", "WorkerRegistry._release_budget", "WorkerRegistry._reconcile_budget",
        ],
        execution_flow: ["DelegateTaskTool.execute", "WorkerRegistry.delegate", "WorkerRegistry._run", "AgentLoop.run"],
        isolation: {
          path: "research_harness/worker_registry.py",
          symbol: "WorkerRegistry._run",
          mechanism: "Creates an isolated worker workspace and ArtifactStore.",
        },
      },
      "trace-cli-entrypoint": {
        metadata: { path: "setup.cfg", command: "autore", target: "research_harness.cli:main" },
        entry_file: "research_harness/cli.py",
        entry_symbol: "main",
        direct_calls: [
          "load_dotenv", "build_parser", "resolve_model_selection", "Orchestrator", "asyncio.run",
          "Orchestrator.run", "_print_run_summary",
        ],
        normal_runtime_flow: [
          "research_harness.cli:main", "Orchestrator", "Orchestrator.run", "ResearchAgent.with_research_tools",
          "ResearchAgent.arun", "AgentLoop.run",
        ],
        conditional_branches: [
          { condition: "eval", target: "research_harness.run_evals:main" },
          { condition: "list models", target: "format_model_catalog" },
          { condition: "interactive", target: "configure_interactive_run" },
          { condition: "preflight", target: "run_preflight_evals" },
        ],
      },
      "trace-final-answer-validation": {
        policy: { path: "research_harness/validation/final_answer.py", symbol: "FinalAnswerValidator.validate" },
        construction: { path: "research_harness/agent_loop.py", symbol: "AgentLoop.__init__" },
        call_site: { path: "research_harness/agent_loop.py", symbol: "AgentLoop._process_answer" },
        configuration: { path: "research_harness/agent_loop.py", symbol: "AgentRunConfig.max_final_validation_revisions" },
        execution_flow: ["AgentLoop.run", "AgentLoop._process_answer", "FinalAnswerValidator.validate"],
        outcome_targets: ["ResultBuilder.completed", "AgentLoop.run", "ResultBuilder.partial"],
        revision_behavior: "AgentState.final_validation_revisions is checked against AgentRunConfig.max_final_validation_revisions.",
      },
    };
    for (const [taskId, answer] of Object.entries(answers)) {
      const answerFile = path.join(root, `${taskId}.json`);
      await fs.writeFile(answerFile, `${JSON.stringify(answer)}\n`);
      const rubric = path.resolve("tasks", taskId, "grader/rubric.json");
      const positive = await runProcess(["python3", grader, rubric, answerFile, repo], { cwd: repo, timeoutMs: 10_000 });
      assert.equal(positive.exitCode, 0, `${taskId}: ${positive.stdout} ${positive.stderr}`);

      await fs.writeFile(answerFile, '{"components":[{"path":"research_harness/plan_builder.py","symbol":"PlanBuilder"}]}\n');
      const negative = await runProcess(["python3", grader, rubric, answerFile, repo], { cwd: repo, timeoutMs: 10_000 });
      assert.notEqual(negative.exitCode, 0, `${taskId} decoy unexpectedly passed`);
      const result = JSON.parse(negative.stdout.trim());
      assert.equal(result.passed, false);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("localization grader measures ranking and trace budget while rejecting forged metrics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-localization-grader-"));
  const materialized = await materializeExampleRepository("payments-service");
  try {
    const answer = path.join(root, "answer.json");
    const events = path.join(root, "events.jsonl");
    await fs.writeFile(answer, JSON.stringify({ rankedSymbols: [
      { symbol: "PaymentValidator.validate", reason: "It compares the supported currency codes.", relevance: 0.99 },
      { symbol: "PaymentController.create", reason: "It invokes validation.", relevance: 0.7 },
    ] }));
    await fs.writeFile(events, [
      { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/domain/payment-validator.ts", offset: 1, limit: 20 } },
      { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "export class PaymentValidator {\n validate(input: unknown) {}\n}" }] }, isError: false },
    ].map((event) => JSON.stringify(event)).join("\n"));
    const grader = path.resolve("benchmark/graders/grade_localization.py");
    const rubric = path.resolve("tasks/issue-to-symbol-localization/grader/rubric.json");
    const positive = await runProcess(["python3", grader, rubric, answer, materialized.repo, events], { cwd: materialized.repo, timeoutMs: 10_000 });
    assert.equal(positive.exitCode, 0, positive.stdout + positive.stderr);
    const positiveResult = JSON.parse(positive.stdout.trim());
    assert.equal(positiveResult.metrics.functionRecallAt1, 1);
    assert.equal(positiveResult.metrics.meanReciprocalRank, 1);
    assert.equal(positiveResult.metrics.linesRetrievedBeforeRelevantSymbol, 3);

    await fs.writeFile(answer, JSON.stringify({
      rankedSymbols: [{ symbol: "PaymentService.execute", reason: "decoy", relevance: 1 }],
      metrics: { functionRecallAt1: 1, meanReciprocalRank: 1 },
    }));
    const negative = await runProcess(["python3", grader, rubric, answer, materialized.repo, events], { cwd: materialized.repo, timeoutMs: 10_000 });
    assert.notEqual(negative.exitCode, 0, "self-declared metrics must not satisfy the behavioral grader");
    assert.equal(JSON.parse(negative.stdout.trim()).metrics.functionRecallAt1, 0);

    await fs.writeFile(answer, JSON.stringify({ rankedSymbols: [
      { symbol: "PaymentValidator.validate", reason: "correct symbol after an excessive search", relevance: 1 },
    ] }));
    await fs.writeFile(events, [
      { type: "tool_execution_start", toolCallId: "grep-1", toolName: "grep", args: { pattern: "currency", path: "src" } },
      { type: "tool_execution_end", toolCallId: "grep-1", toolName: "grep", result: { content: [{ type: "text", text: Array.from({ length: 501 }, (_, index) => `src/domain/payment-validator.ts:${index + 1}:currency`).join("\n") }] }, isError: false },
    ].map((event) => JSON.stringify(event)).join("\n"));
    const overBudget = await runProcess(["python3", grader, rubric, answer, materialized.repo, events], { cwd: materialized.repo, timeoutMs: 10_000 });
    assert.notEqual(overBudget.exitCode, 0, "a correct answer must not bypass the fixed source-line budget");
    const budgetResult = JSON.parse(overBudget.stdout.trim());
    assert.equal(budgetResult.metrics.sourceLinesRetrieved, 501);
    assert.equal(budgetResult.checks.find((item: { name: string }) => item.name === "source_line_budget").passed, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(materialized.cleanupRoot, { recursive: true, force: true });
  }
});

test("execution-path grader scores real nodes and edges while rejecting a plausible decoy path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-path-grader-"));
  const materialized = await materializeExampleRepository("payments-service");
  try {
    const answer = path.join(root, "answer.json");
    const events = path.join(root, "events.jsonl");
    await fs.writeFile(events, "");
    const orderedPath = ["HttpRouter.dispatch", "PaymentController.create", "PaymentValidator.validate",
      "PaymentService.execute", "PaymentRepository.save", "DatabaseAdapter.insertPayment"];
    const edges = [
      ["HttpRouter.dispatch", "PaymentController.create"],
      ["PaymentController.create", "PaymentValidator.validate"],
      ["PaymentController.create", "PaymentService.execute"],
      ["PaymentService.execute", "PaymentRepository.save"],
      ["PaymentRepository.save", "DatabaseAdapter.insertPayment"],
    ].map(([from, to]) => ({ from, to }));
    await fs.writeFile(answer, JSON.stringify({
      endpoint: { method: "POST", path: "/payments", registrationSymbol: "registerPaymentRoutes" },
      nodes: orderedPath.map((symbol) => ({ symbol })), edges, orderedPath,
      validation: { symbol: "PaymentValidator.validate", behavior: "validates the payment command" },
      sideEffects: ["DatabaseAdapter calls payments.set to retain the payment"],
    }));
    const grader = path.resolve("benchmark/graders/grade_execution_path.py");
    const rubric = path.resolve("tasks/reconstruct-payment-execution-path/grader/rubric.json");
    const positive = await runProcess(["python3", grader, rubric, answer, materialized.repo, events], { cwd: materialized.repo, timeoutMs: 10_000 });
    assert.equal(positive.exitCode, 0, positive.stdout + positive.stderr);
    const metrics = JSON.parse(positive.stdout.trim()).metrics;
    assert.equal(metrics.nodePrecision, 1);
    assert.equal(metrics.edgeRecall, 1);
    assert.equal(metrics.correctOrdering, 1);

    await fs.writeFile(answer, JSON.stringify({
      endpoint: { method: "POST", path: "/payments", registrationSymbol: "createApplication" },
      nodes: [{ symbol: "PaymentService.execute" }, { symbol: "DatabaseAdapter.findPayment" }],
      edges: [{ from: "PaymentService.execute", to: "DatabaseAdapter.findPayment" }],
      orderedPath: ["PaymentService.execute", "DatabaseAdapter.findPayment"],
      validation: { symbol: "PaymentService.execute" }, sideEffects: ["returns a payment"],
      metrics: { nodeRecall: 1, edgeRecall: 1 },
    }));
    const negative = await runProcess(["python3", grader, rubric, answer, materialized.repo, events], { cwd: materialized.repo, timeoutMs: 10_000 });
    assert.notEqual(negative.exitCode, 0, "a plausible but wrong path must not pass");
    assert.ok(JSON.parse(negative.stdout.trim()).metrics.nodeRecall < 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(materialized.cleanupRoot, { recursive: true, force: true });
  }
});

test("process timeout terminates the child and reports timeout", async () => {
  const result = await runProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeoutMs: 80 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("summary uses arithmetic means and paired hidden-score outcomes", () => {
  const runs = [
    fakeRun("regular-code", "pair-1", 0, { durationMs: 100, tokens: tokenUsage({ input: 1, uncachedInput: 1, cachedInput: 0, output: 1, reasoning: 0, total: 10 }) }),
    fakeRun("regular-code", "pair-2", 1, { run: 2, pairId: "pair-2", durationMs: 300, tokens: tokenUsage({ input: 1, uncachedInput: 1, cachedInput: 0, output: 1, reasoning: 0, total: 30 }) }),
    fakeRun("all-outline-aids", "pair-1", 1), fakeRun("all-outline-aids", "pair-2", 0, { run: 2, pairId: "pair-2" }),
  ];
  const summary = buildSummary(runs, "2026-01-01T00:00:00.000Z");
  const raw = summary.conditions.find((item) => item.condition === "regular-code")!;
  const full = summary.conditions.find((item) => item.condition === "all-outline-aids")!;
  assert.equal(raw.durationMeanMs, 200);
  assert.equal(raw.tokensMean.total, 20);
  assert.deepEqual(full.pairedVsRaw, { wins: 1, losses: 1, ties: 0 });
  assert.match(summary.warnings?.join(" ") ?? "", /task-condition cell/);
});

test("the end-to-end runner persists run artifacts and a report from the real process path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-e2e-"));
  const previousPi = process.env.MAPBENCH_PI;
  try {
    const { repo } = await makeGitRepository(root);
    const tasksRoot = path.join(root, "tasks");
    const task = path.join(tasksRoot, "behavior");
    const graderDirectory = path.join(task, "grader");
    await fs.mkdir(graderDirectory, { recursive: true });
    const fakePi = path.join(root, "fake-pi.mjs");
    await fs.writeFile(fakePi, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/main.ts" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "source" }] }, isError: false }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Implemented behavior.\\n" }], usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 0, totalTokens: 15 } } }));
`, "utf8");
    await fs.chmod(fakePi, 0o755);
    await fs.writeFile(path.join(task, "prompt.md"), "Make the exported behavior return the correct value.\n");
    await fs.writeFile(path.join(task, "task.json"), JSON.stringify({
      version: 1, id: "behavior", title: "Behavior", promptFile: "prompt.md",
      grader: { command: [process.execPath, "{grader}/grade.js", "{workspace}", "{answer}"] },
    }));
    await fs.writeFile(path.join(graderDirectory, "grade.js"), `
const fs = require("node:fs");
const answer = fs.readFileSync(process.argv[3], "utf8").trim();
const passed = answer === "Implemented behavior.";
console.log(JSON.stringify({score:passed ? 1 : 0,maxScore:1,passed,checks:[{name:"answer_artifact",passed}]}));
process.exitCode = passed ? 0 : 1;
`);
    process.env.MAPBENCH_PI = fakePi;
    const completed = await runBenchmark({
      repo, taskIds: ["behavior"], runs: 3, conditions: ["regular-code"], provider: "openai-codex", model: "fixed-test-model", timeoutMs: 5_000,
      dryRun: false, keepWorkspaces: false, outputRoot: path.join(root, "results"), tasksRoot,
      pricingMode: "off", seed: "test", debugUsage: true,
    });
    assert.equal(completed.runs.length, 3);
    assert.equal(completed.runs[0].status, "completed");
    assert.equal(completed.runs[0].hiddenGrader.passed, true);
    assert.equal(completed.runs[0].tokens.total, 15);
    assert.equal(new Set(completed.runs.map((run) => run.baselineTreeHash)).size, 1);
    assert.equal(new Set(completed.runs.map((run) => run.promptSha256)).size, 1);
    for (const run of completed.runs) {
      assert.equal(run.isolation.freshProcess, true);
      assert.equal(run.isolation.resumedSession, false);
      assert.equal(run.isolation.harness, "pi");
      assert.equal(run.isolation.originalGitObjectsRemoved, true);
      assert.equal(run.isolation.piHome, "fresh-auth-only");
      assert.equal(run.isolation.piHomeRemoved, true);
      assert.equal(run.isolation.contextFiles, "disabled");
      assert.equal(run.isolation.resources, "explicit-extension-only");
      assert.equal(run.isolation.tools, "workspace-read-only");
      const runDirectory = path.join(completed.resultsRoot, "regular-code", "behavior", `run-${String(run.run).padStart(3, "0")}`);
      for (const name of ["events.jsonl", "usage-events.json", "stderr.log", "final-message.md", "changes.patch", "grader.json", "result.json"]) {
        assert.equal(await fs.access(path.join(runDirectory, name)).then(() => true, () => false), true, name);
      }
      const usage = JSON.parse(await fs.readFile(path.join(runDirectory, "usage-events.json"), "utf8"));
      assert.equal(usage[0].event.type, "message_end");
    }
    const config = JSON.parse(await fs.readFile(path.join(completed.resultsRoot, "config.json"), "utf8"));
    assert.equal(config.tasksRoot, tasksRoot);
    assert.equal(config.graderPreflight.behavior.details.passed, false);
    assert.equal(await fs.access(path.join(completed.resultsRoot, "report.html")).then(() => true, () => false), true);
  } finally {
    if (previousPi === undefined) delete process.env.MAPBENCH_PI;
    else process.env.MAPBENCH_PI = previousPi;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grader negative control aborts before an agent can spend tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-preflight-"));
  const previousPi = process.env.MAPBENCH_PI;
  try {
    const { repo } = await makeGitRepository(root);
    const marker = path.join(root, "pi-was-invoked");
    const task = path.join(root, "tasks", "always-passes");
    await fs.mkdir(path.join(task, "grader"), { recursive: true });
    const fakePi = path.join(root, "fake-pi.mjs");
    await fs.writeFile(fakePi, `#!/usr/bin/env node\nawait (await import("node:fs/promises")).writeFile(${JSON.stringify(marker)}, "invoked");\n`, "utf8");
    await fs.chmod(fakePi, 0o755);
    await fs.writeFile(path.join(task, "prompt.md"), "Find the relevant behavior.\n");
    await fs.writeFile(path.join(task, "task.json"), JSON.stringify({
      version: 1, id: "always-passes", title: "Broken grader", promptFile: "prompt.md",
      grader: { command: [process.execPath, "{grader}/grade.js"] },
    }));
    await fs.writeFile(path.join(task, "grader", "grade.js"),
      'console.log(JSON.stringify({score:1,maxScore:1,passed:true}));\n');
    process.env.MAPBENCH_PI = fakePi;
    await assert.rejects(runBenchmark({
      repo, taskIds: ["always-passes"], runs: 3, conditions: ["regular-code"], provider: "openai-codex", model: "fixed-test-model", timeoutMs: 5_000,
      dryRun: false, keepWorkspaces: false, outputRoot: path.join(root, "results"), tasksRoot: path.join(root, "tasks"),
      pricingMode: "off", seed: "test", debugUsage: false,
    }), /accepted an empty answer/);
    assert.equal(await fs.access(marker).then(() => true, () => false), false);
  } finally {
    if (previousPi === undefined) delete process.env.MAPBENCH_PI;
    else process.env.MAPBENCH_PI = previousPi;
    await fs.rm(root, { recursive: true, force: true });
  }
});
