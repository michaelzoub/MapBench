import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateCost, parseCodexEvents } from "../events.js";
import { parseConditionSelection, runBenchmarkCli } from "../cli.js";
import { createAuthoredEval, validateAuthoredGroundTruth } from "../author-eval.js";
import { materializeExampleRepository } from "../examples.js";
import { analyzeNavigation, emptyNavigationMetrics } from "../navigation.js";
import { fetchOpenRouterPricing, openRouterModelId } from "../pricing.js";
import { runProcess } from "../process.js";
import { codexCommand, DEFAULT_BENCHMARK_REASONING_EFFORT, runBenchmark } from "../runner.js";
import { scaffoldEvalTask } from "../scaffold.js";
import { buildSummary } from "../summary.js";
import type { CheckResult, Condition, GraderResult, RunResult, TokenUsage } from "../types.js";
import { CONDITION_FACTORS, CONDITIONS, DEFAULT_CONDITIONS } from "../types.js";
import { assertGraderOutsideWorkspace, COMPONENTS, createWorkspace, prepareCondition, removePrivateTaskFromWorkspace } from "../workspace.js";

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
    source: "codex-jsonl",
    eventType: "turn.completed",
    eventLines: [1],
    rawEventFile: null,
    fields: {
      input: "usage.input_tokens",
      uncachedInput: "derived: usage.input_tokens - usage.cached_input_tokens",
      cachedInput: "usage.cached_input_tokens",
      output: "usage.output_tokens",
      reasoning: "usage.reasoning_output_tokens",
      total: "usage.total_tokens",
    },
  },
  ...overrides,
});

function fakeRun(condition: Condition, pairId: string, score: number, overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 2, pairId, taskId: "task", condition, run: 1, targetCommit: "a", baselineCommit: "b",
    baselineTreeHash: "tree", promptSha256: "prompt", model: "fixed",
    status: "completed", exitCode: 0, durationMs: 1000, tokens: tokenUsage(),
    estimatedCostUsd: 0.01, commands: [], commandCount: 2, failedCommandCount: 0, finalResponse: "done", filesChanged: ["src/a.ts"], fileCount: 1,
    navigation: emptyNavigationMetrics(),
    hiddenGrader: grader(score), checks: { regression: passCheck, typecheck: passCheck, build: passCheck }, artifactDirectory: "regular-code/task/run-001", workspaceKept: false,
    isolation: { freshProcess: true, resumedSession: false, ephemeralSession: true, freshWorkspace: true,
      codexHome: "fresh-auth-only", initialCodexHomeFiles: ["auth.json"], codexHomeRemoved: true },
    ...overrides,
  };
}

async function makeGitRepository(root: string): Promise<{ repo: string; commit: string }> {
  const repo = path.join(root, "source");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(repo, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}\n');
  await fs.writeFile(path.join(repo, "src", "main.ts"), "export function outer(): number { return inner(); }\nfunction inner(): number { return 1; }\n");
  await fs.writeFile(path.join(repo, "AGENTS.md"), "# User rules\n\nKeep me.\n");
  for (const args of [["init", "-q"], ["config", "user.email", "test@invalid.local"], ["config", "user.name", "Test"], ["add", "-A"], ["commit", "-qm", "fixture"]]) {
    const result = await runProcess(["git", ...args], { cwd: repo, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const commit = (await runProcess(["git", "rev-parse", "HEAD"], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();
  return { repo, commit };
}

test("workspace is a fresh exact-commit clone and never mutates the source repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-isolation-"));
  try {
    const { repo, commit } = await makeGitRepository(root);
    const workspace = await createWorkspace(repo, commit, "run", path.join(root, "workspaces"));
    assert.notEqual(path.resolve(workspace), path.resolve(repo));
    await fs.writeFile(path.join(workspace, "src", "main.ts"), "changed\n");
    assert.match(await fs.readFile(path.join(repo, "src", "main.ts"), "utf8"), /outer/);
    const actual = (await runProcess(["git", "rev-parse", "HEAD"], { cwd: workspace, timeoutMs: 10_000 })).stdout.trim();
    assert.equal(actual, commit);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ablations contain exactly their intended generated artifacts without generated guidance", { timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-ablation-"));
  try {
    const { repo, commit } = await makeGitRepository(root);
    for (const condition of CONDITIONS) {
      const workspace = await createWorkspace(repo, commit, condition, path.join(root, "workspaces"));
      await prepareCondition(workspace, condition);
      const exists = async (relative: string): Promise<boolean> => await fs.access(path.join(workspace, relative)).then(() => true, () => false);
      assert.equal(await exists(".project-outline/src"), COMPONENTS[condition].skeleton, `${condition} skeleton`);
      assert.equal(await exists(".project-outline/callgraph.json"), COMPONENTS[condition].callgraph, `${condition} graph`);
      assert.equal(await exists(".project-outline/architecture.md"), COMPONENTS[condition].architecture, `${condition} architecture`);
      assert.equal(await exists(".project-outline/architecture.mmd"), false, `${condition} human Mermaid view`);
      assert.equal(await exists(".project-outline/query.mjs"), COMPONENTS[condition].callgraph, `${condition} query helper`);
      assert.equal(await exists(".project-outline/AGENTS.md"), false, `${condition} generated guidance`);
      const rootAgents = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
      assert.match(rootAgents, /Keep me/);
      assert.equal(rootAgents.includes("project-outline:start"), COMPONENTS[condition].rootAgents);
      if (!COMPONENTS[condition].skeleton) assert.doesNotMatch(rootAgents, /for declarations and signatures/);
      if (!COMPONENTS[condition].callgraph) assert.doesNotMatch(rootAgents, /callgraph\.json/);
      if (condition !== "regular-code") {
        assert.match(rootAgents, /only announces the generated artifact paths; it supplies no navigation strategy/);
        assert.doesNotMatch(rootAgents, /navigation protocol|Follow the condition-specific protocol/);
      }
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

test("private graders must be outside the Codex workspace", async () => {
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

test("Codex-authored eval creation grounds its grader and exercises the real positive and negative controls", async () => {
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
  const previousCodex = process.env.PROJECT_OUTLINE_CODEX;
  try {
    const { repo } = await makeGitRepository(root);
    const fakeCodex = path.join(root, "fake-codex.mjs");
    await fs.writeFile(fakeCodex, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst index = process.argv.indexOf("--output-last-message");\nwriteFileSync(process.argv[index + 1], JSON.stringify({ requiredFiles: ["src/main.ts"], requiredSymbols: [{ name: "outer", path: "src/main.ts" }] }));\n`);
    await fs.chmod(fakeCodex, 0o755);
    process.env.PROJECT_OUTLINE_CODEX = fakeCodex;
    const tasksRoot = path.join(root, "tasks");
    await runBenchmarkCli(["ask", "--repo", repo, "--tasks", tasksRoot, "--task", "Explain Outer", "--question", "Where does outer delegate?", "--no-run"]);
    const directory = path.join(tasksRoot, "explain-outer");
    assert.match(await fs.readFile(path.join(directory, "prompt.md"), "utf8"), /Where does outer delegate/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "grader", "expected.json"), "utf8")), {
      requiredFiles: ["src/main.ts"], requiredSymbols: [{ name: "outer", path: "src/main.ts" }],
    });
  } finally {
    if (previousCodex === undefined) delete process.env.PROJECT_OUTLINE_CODEX;
    else process.env.PROJECT_OUTLINE_CODEX = previousCodex;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex JSONL parsing accounts for tokens, reasoning, commands, and failures", () => {
  const input = [
    { type: "item.completed", item: { type: "command_execution", command: "bun test", status: "completed", exit_code: 0 } },
    { type: "item.completed", item: { type: "command_execution", command: "bun build", status: "failed", exit_code: 1 } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, total_tokens: 130, reasoning_output_tokens: 10 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parseCodexEvents(input);
  assert.deepEqual(parsed.tokens, {
    input: 100,
    uncachedInput: 60,
    cachedInput: 40,
    output: 30,
    reasoning: 10,
    total: 130,
    provenance: {
      source: "codex-jsonl",
      eventType: "turn.completed",
      eventLines: [3],
      rawEventFile: null,
      fields: {
        input: "usage.input_tokens",
        uncachedInput: "derived: usage.input_tokens - usage.cached_input_tokens",
        cachedInput: "usage.cached_input_tokens",
        output: "usage.output_tokens",
        reasoning: "usage.reasoning_output_tokens",
        total: "usage.total_tokens",
      },
    },
  });
  assert.equal(parsed.usageEvents.length, 1);
  assert.equal(parsed.commands.length, 2);
  assert.equal(parsed.commands.filter((command) => command.failed).length, 1);
  assert.equal(estimateCost(parsed.tokens, { inputPerMillion: 10, cachedInputPerMillion: 2, outputPerMillion: 20 }), 0.00128);
});

test("Codex JSONL parsing records exact wall time to the first source-code edit", () => {
  const input = [
    { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,80p' src/main.ts", status: "completed", exit_code: 0 } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: ".project-outline/src/main.ts", kind: "update" }] } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/main.ts", kind: "update" }] } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parseCodexEvents(input, [45, 300, 725, 900]);
  assert.deepEqual(parsed.editNavigation, {
    firstSourceEditObserved: true,
    elapsedMs: 725,
    eventLine: 3,
  });
});

test("source-edit timing recognizes mutating shell commands for root-level source files", () => {
  const input = JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "sed -i.bak 's/old/new/' main.go", status: "completed", exit_code: 0 },
  });
  assert.deepEqual(parseCodexEvents(input, [180]).editNavigation, {
    firstSourceEditObserved: true,
    elapsedMs: 180,
    eventLine: 1,
  });
});

test("token parsing derives only exact totals and leaves unavailable Codex fields null", () => {
  const parsed = parseCodexEvents(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 },
  }));
  assert.equal(parsed.tokens.input, 12);
  assert.equal(parsed.tokens.uncachedInput, 10);
  assert.equal(parsed.tokens.cachedInput, 2);
  assert.equal(parsed.tokens.output, 3);
  assert.equal(parsed.tokens.reasoning, null);
  assert.equal(parsed.tokens.total, 15);
  assert.equal(parsed.tokens.provenance.fields.total, "derived: usage.input_tokens + usage.output_tokens");
  assert.equal(estimateCost(parsed.tokens, { inputPerMillion: 1, cachedInputPerMillion: 1, outputPerMillion: 1 }), null);

  const missing = parseCodexEvents('{"type":"turn.completed","usage":{"input_tokens":12}}');
  assert.equal(missing.tokens.uncachedInput, null);
  assert.equal(missing.tokens.output, null);
  assert.equal(missing.tokens.total, null);

  const inconsistent = parseCodexEvents('{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":3,"output_tokens":1}}');
  assert.equal(inconsistent.tokens.uncachedInput, null);
});

test("navigation telemetry measures real outline/source access and rejects decorative path mentions", () => {
  const input = [
    { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,100p' .project-outline/src/a.ts", status: "completed", exit_code: 0, aggregated_output: "outline" } },
    { type: "item.completed", item: { type: "command_execution", command: "echo .project-outline/callgraph.json", status: "completed", exit_code: 0, aggregated_output: "decorative" } },
    { type: "item.completed", item: { type: "command_execution", command: "sed -n '50,150p' src/a.ts", status: "completed", exit_code: 0, aggregated_output: "source" } },
    { type: "item.completed", item: { type: "command_execution", command: "sed -n '100,200p' src/a.ts", status: "failed", exit_code: 1, aggregated_output: "failed" } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parseCodexEvents(input);
  assert.equal(parsed.commands[0].navigation, "outline");
  assert.equal(parsed.commands[1].navigation, "other", "echoing an outline path must not count as adoption");
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

test("Codex benchmark commands force low reasoning despite ignored user config", () => {
  const command = codexCommand("/workspace", "gpt-5.6-terra", "/result.md");
  assert.equal(command[command.indexOf("--model") + 1], "gpt-5.6-terra");
  assert.equal(DEFAULT_BENCHMARK_REASONING_EFFORT, "low");
  assert.equal(command.includes('model_reasoning_effort="low"'), true);
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
    await fs.writeFile(events, JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "sed -n '1,20p' src/domain/payment-validator.ts", status: "completed", exit_code: 0,
        aggregated_output: "export class PaymentValidator {\n validate(input: unknown) {}\n}" },
    }));
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
    await fs.writeFile(events, JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "rg currency src", status: "completed", exit_code: 0,
        aggregated_output: Array.from({ length: 501 }, (_, index) => `src/domain/payment-validator.ts:${index + 1}:currency`).join("\n") },
    }));
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
  const previousPath = process.env.PATH;
  try {
    const { repo } = await makeGitRepository(root);
    const bin = path.join(root, "bin");
    const tasksRoot = path.join(root, "tasks");
    const task = path.join(tasksRoot, "behavior");
    const graderDirectory = path.join(task, "grader");
    await fs.mkdir(bin);
    await fs.mkdir(graderDirectory, { recursive: true });
    const fakeCodex = path.join(bin, "codex");
    await fs.writeFile(fakeCodex, `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then shift; out="$1"; fi
  shift
done
printf 'Implemented behavior.\\n' > "$out"
printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"bun test","status":"completed","exit_code":0}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":0}}'
`, "utf8");
    await fs.chmod(fakeCodex, 0o755);
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
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    const completed = await runBenchmark({
      repo, taskIds: ["behavior"], runs: 3, conditions: ["regular-code"], model: "fixed-test-model", timeoutMs: 5_000,
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
      assert.equal(run.isolation.codexHome, "fresh-auth-only");
      assert.equal(run.isolation.codexHomeRemoved, true);
      const runDirectory = path.join(completed.resultsRoot, "regular-code", "behavior", `run-${String(run.run).padStart(3, "0")}`);
      for (const name of ["events.jsonl", "usage-events.json", "stderr.log", "final-message.md", "changes.patch", "grader.json", "result.json"]) {
        assert.equal(await fs.access(path.join(runDirectory, name)).then(() => true, () => false), true, name);
      }
      const usage = JSON.parse(await fs.readFile(path.join(runDirectory, "usage-events.json"), "utf8"));
      assert.equal(usage[0].event.type, "turn.completed");
    }
    const config = JSON.parse(await fs.readFile(path.join(completed.resultsRoot, "config.json"), "utf8"));
    assert.equal(config.tasksRoot, tasksRoot);
    assert.equal(config.graderPreflight.behavior.details.passed, false);
    assert.equal(await fs.access(path.join(completed.resultsRoot, "report.html")).then(() => true, () => false), true);
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grader negative control aborts before an agent can spend tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-preflight-"));
  const previousPath = process.env.PATH;
  try {
    const { repo } = await makeGitRepository(root);
    const bin = path.join(root, "bin");
    const marker = path.join(root, "codex-was-invoked");
    const task = path.join(root, "tasks", "always-passes");
    await fs.mkdir(path.join(task, "grader"), { recursive: true });
    await fs.mkdir(bin);
    const fakeCodex = path.join(bin, "codex");
    await fs.writeFile(fakeCodex, `#!/bin/sh\nprintf invoked > "${marker}"\n`, "utf8");
    await fs.chmod(fakeCodex, 0o755);
    await fs.writeFile(path.join(task, "prompt.md"), "Find the relevant behavior.\n");
    await fs.writeFile(path.join(task, "task.json"), JSON.stringify({
      version: 1, id: "always-passes", title: "Broken grader", promptFile: "prompt.md",
      grader: { command: [process.execPath, "{grader}/grade.js"] },
    }));
    await fs.writeFile(path.join(task, "grader", "grade.js"),
      'console.log(JSON.stringify({score:1,maxScore:1,passed:true}));\n');
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    await assert.rejects(runBenchmark({
      repo, taskIds: ["always-passes"], runs: 3, conditions: ["regular-code"], model: "fixed-test-model", timeoutMs: 5_000,
      dryRun: false, keepWorkspaces: false, outputRoot: path.join(root, "results"), tasksRoot: path.join(root, "tasks"),
      pricingMode: "off", seed: "test", debugUsage: false,
    }), /accepted an empty answer/);
    assert.equal(await fs.access(marker).then(() => true, () => false), false);
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
