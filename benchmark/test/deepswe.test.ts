import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDeepSweTasks, resolveDeepSweTaskSet, type DeepSweSourceConfig } from "../deepswe.js";
import { DEEPSWE_SOURCE } from "../deepswe-manifest.js";
import { runProcess } from "../process.js";
import { runBenchmark } from "../runner.js";

function verifierReward(details: unknown): number {
  assert.ok(details && typeof details === "object" && "reward" in details);
  const reward = details.reward;
  assert.ok(reward && typeof reward === "object" && "reward" in reward);
  assert.equal(typeof reward.reward, "number");
  return reward.reward as number;
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await runProcess(["git", ...args], { cwd: directory, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function commitAll(directory: string, message: string): Promise<string> {
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "--quiet", "-m", message]);
  return await git(directory, ["rev-parse", "HEAD"]);
}

async function initializeRepository(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet"]);
  await git(directory, ["config", "user.name", "DeepSWE Test"]);
  await git(directory, ["config", "user.email", "deepswe-test@invalid.local"]);
}

function taskToml(id: string, baseCommit: string): string {
  return `schema_version = "1.3"
artifacts = ["/logs/artifacts/model.patch"]
[task]
name = "datacurve/${id}"
description = ""
authors = []
keywords = []
[metadata]
ext_id = "external-${id}"
task_id = "${id}"
display_title = "${id} title"
display_description = "fixture"
original_title = "fixture"
category = "enhancement"
language = "typescript"
repository_url = "https://github.com/example/${id}"
base_commit_hash = "${baseCommit}"
[verifier]
network_mode = "no-network"
environment_mode = "separate"
timeout_sec = 30.0
[verifier.env]
[verifier.environment]
build_timeout_sec = 30.0
cpus = 1
memory_mb = 512
storage_mb = 1024
[[verifier.collect]]
command = "cd /app && mkdir -p /logs/artifacts && git diff --binary ${baseCommit} HEAD > /logs/artifacts/model.patch"
timeout_sec = 30.0
[agent]
network_mode = "no-network"
timeout_sec = 30.0
[environment]
build_timeout_sec = 30.0
docker_image = "fake/deepswe-${id}-v1.1"
os = "linux"
cpus = 1
memory_mb = 512
storage_mb = 1024
gpus = 0
mcp_servers = []
[environment.env]
[solution.env]
`;
}

async function makeFixture(root: string): Promise<{
  checkout: string;
  target: string;
  targetCommit: string;
  ids: string[];
  source: DeepSweSourceConfig;
}> {
  const target = path.join(root, "target");
  await initializeRepository(target);
  await fs.writeFile(path.join(target, "base.txt"), "base\n");
  await fs.writeFile(path.join(target, "index.ts"), "export const base = 1;\n");
  const targetCommit = await commitAll(target, "base");

  const checkout = path.join(root, "deep-swe");
  await initializeRepository(checkout);
  const ids = ["abs-module-cache-flags", "actionlint-action-pinning-lint"];
  for (const id of ids) {
    const task = path.join(checkout, "tasks", id);
    const tests = path.join(task, "tests");
    const declaredCommit = id === "actionlint-action-pinning-lint" ? targetCommit.slice(0, 7) : targetCommit;
    await fs.mkdir(path.join(task, "environment"), { recursive: true });
    await fs.mkdir(tests, { recursive: true });
    await fs.mkdir(path.join(task, "solution"), { recursive: true });
    await fs.writeFile(path.join(task, "task.toml"), taskToml(id, declaredCommit));
    await fs.writeFile(path.join(task, "instruction.md"), `DeepSWE smoke instruction for ${id}.\n`);
    await fs.writeFile(path.join(task, "environment", "Dockerfile"), "FROM fake/base\n");
    await fs.writeFile(path.join(tests, "Dockerfile"), "FROM fake/base\n");
    await fs.writeFile(path.join(tests, "test.sh"), "#!/bin/sh\n");
    await fs.writeFile(path.join(tests, "grader.py"), "# fixture\n");
    await fs.writeFile(path.join(tests, "config.json"), `${JSON.stringify({ base_commit: declaredCommit, f2p_node_ids: ["smoke"], p2p_node_ids: [], grade: { format: "ctrf", reports: [] } })}\n`);
    await fs.writeFile(path.join(tests, "test.patch"), "");
    await fs.writeFile(path.join(task, "solution", "solution.patch"), "REFERENCE_SOLUTION_SECRET\n");
  }
  const revision = await commitAll(checkout, "fixture tasks");
  return {
    checkout,
    target,
    targetCommit,
    ids,
    source: {
      name: "deep-swe-test",
      version: "1.1",
      schemaVersion: "1.3",
      repository: "https://github.com/datacurve-ai/deep-swe.git",
      revision,
      tasksDirectory: "tasks",
      sets: { smoke: ids },
    },
  };
}

async function writeFakeExecutables(root: string): Promise<{ docker: string; pi: string }> {
  const docker = path.join(root, "fake-docker.ts");
  await fs.writeFile(docker, `#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const command = args[0];
if (command === "image" || command === "pull" || command === "start" || command === "rm") process.exit(0);
if (command === "create") {
  console.log(args.includes("--mount") ? "agent-container" : "source-container");
  process.exit(0);
}
if (command === "cp") {
  const source = process.env.FAKE_DEEPSWE_APP;
  const destination = args[2];
  if (!source) process.exit(2);
  for (const entry of readdirSync(source)) cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
  process.exit(0);
}
if (command === "build") {
  console.log("verifier-image");
  process.exit(0);
}
if (command === "run") {
  const mount = args[args.indexOf("--mount") + 1];
  const prefix = "type=bind,source=";
  const suffix = ",target=/logs";
  if (!mount.startsWith(prefix) || !mount.endsWith(suffix)) process.exit(3);
  const logs = mount.slice(prefix.length, -suffix.length);
  const patch = path.join(logs, "artifacts", "model.patch");
  const passed = existsSync(patch) && statSync(patch).size > 0;
  mkdirSync(path.join(logs, "verifier"), { recursive: true });
  writeFileSync(path.join(logs, "verifier", "reward.json"), JSON.stringify({ reward: passed ? 1 : 0, f2p_total: 1, f2p_passed: passed ? 1 : 0, p2p_total: 1, p2p_passed: 1, f2p: passed ? 1 : 0, p2p: 1, partial: passed ? 1 : 0.5 }));
  writeFileSync(path.join(logs, "verifier", "ctrf.json"), JSON.stringify({ results: { tests: [{ name: "smoke", status: passed ? "passed" : "failed" }] } }));
  console.log(passed ? "DeepSWE verifier passed" : "DeepSWE negative control failed as expected");
  process.exit(0);
}
process.exit(4);
`);
  const pi = path.join(root, "fake-pi.ts");
  await fs.writeFile(pi, `#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const prompt = process.argv.at(-1) ?? "";
if (!prompt.includes("DeepSWE smoke instruction") || !prompt.includes("Implement the requested change")) process.exit(2);
writeFileSync("agent-change.txt", prompt);
spawnSync("git", ["add", "agent-change.txt"], { stdio: "ignore" });
const committed = spawnSync("git", ["commit", "--quiet", "-m", "agent solution"], { stdio: "ignore" });
if (committed.status !== 0) process.exit(3);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Implemented DeepSWE task.\\n" }], usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 3, reasoning: 0, totalTokens: 13 } } }));
`);
  await Promise.all([fs.chmod(docker, 0o755), fs.chmod(pi, 0o755)]);
  return { docker, pi };
}

test("DeepSWE source pin and smoke set remain explicit", () => {
  assert.equal(DEEPSWE_SOURCE.version, "1.1");
  assert.match(DEEPSWE_SOURCE.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(resolveDeepSweTaskSet("smoke"), ["abs-module-cache-flags", "actionlint-action-pinning-lint"]);
});

test("DeepSWE adapter preserves official IDs and required execution metadata", async () => {

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deepswe-adapter-"));
  try {
    const fixture = await makeFixture(root);
    const tasks = await loadDeepSweTasks(fixture.checkout, fixture.ids, fixture.source);
    assert.deepEqual(tasks.map((task) => task.id), fixture.ids);
    assert.equal(tasks[0].prompt, "DeepSWE smoke instruction for abs-module-cache-flags.");
    assert.equal(tasks[0].execution.kind, "repository-edit");
    if (tasks[0].execution.kind !== "repository-edit") assert.fail("expected repository-edit task");
    assert.equal(tasks[0].execution.repositoryUrl, "https://github.com/example/abs-module-cache-flags");
    assert.equal(tasks[0].execution.baseCommit, fixture.targetCommit);
    assert.equal(tasks[0].execution.environment.dockerImage, "fake/deepswe-abs-module-cache-flags-v1.1");
    assert.equal(tasks[0].execution.verifier.environmentMode, "separate");
    assert.doesNotMatch(tasks[0].grader.command.join(" "), /solution/);
    await assert.rejects(loadDeepSweTasks(fixture.checkout, ["not-a-task"], fixture.source), /Unknown DeepSWE v1\.1 task ID/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("DeepSWE validation rejects missing, malformed, incomplete, and mismatched sources", async () => {
  const missingSource = { name: "test", version: "1.1", schemaVersion: "1.3", repository: "x", revision: "0".repeat(40), tasksDirectory: "tasks", sets: {} } satisfies DeepSweSourceConfig;
  await assert.rejects(loadDeepSweTasks("/definitely/missing/deep-swe", ["x"], missingSource), /checkout does not exist/);

  const revisionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deepswe-revision-"));
  try {
    const fixture = await makeFixture(revisionRoot);
    await assert.rejects(loadDeepSweTasks(fixture.checkout, fixture.ids, { ...fixture.source, revision: "0".repeat(40) }), /revision mismatch/);
  } finally {
    await fs.rm(revisionRoot, { recursive: true, force: true });
  }

  for (const scenario of ["missing-verifier", "missing-instruction", "missing-repository", "missing-base", "malformed", "version"] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `deepswe-${scenario}-`));
    try {
      const fixture = await makeFixture(root);
      const task = path.join(fixture.checkout, "tasks", fixture.ids[0]);
      const manifestFile = path.join(task, "task.toml");
      if (scenario === "missing-verifier") await fs.rm(path.join(task, "tests", "test.sh"));
      if (scenario === "missing-instruction") await fs.rm(path.join(task, "instruction.md"));
      if (scenario === "malformed") await fs.writeFile(manifestFile, "[broken\n");
      if (scenario === "missing-repository" || scenario === "missing-base" || scenario === "version") {
        const manifest = await fs.readFile(manifestFile, "utf8");
        const updated = scenario === "missing-repository"
          ? manifest.replace(/repository_url = .*\n/, "repository_url = \"\"\n")
          : scenario === "missing-base"
            ? manifest.replace(/base_commit_hash = .*\n/, "base_commit_hash = \"\"\n")
            : manifest.replace("-v1.1", "-v1.0");
        await fs.writeFile(manifestFile, updated);
      }
      const revision = await commitAll(fixture.checkout, scenario);
      const source = { ...fixture.source, revision };
      const pattern = scenario === "missing-verifier"
        ? /missing tests\/test\.sh/
        : scenario === "missing-instruction"
          ? /missing instruction\.md/
          : scenario === "missing-repository"
            ? /missing repository_url/
            : scenario === "missing-base"
              ? /missing base_commit_hash/
              : scenario === "malformed"
                ? /Malformed DeepSWE task metadata/
                : /environment version mismatch/;
      await assert.rejects(loadDeepSweTasks(fixture.checkout, [fixture.ids[0]], source), pattern);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("DeepSWE tasks pass through the runner and capture isolated verifier results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deepswe-runner-"));
  const previous = {
    docker: process.env.MAPBENCH_DOCKER,
    pi: process.env.MAPBENCH_PI,
    app: process.env.FAKE_DEEPSWE_APP,
  };
  try {
    const fixture = await makeFixture(root);
    const tasks = await loadDeepSweTasks(fixture.checkout, fixture.ids, fixture.source);
    const executables = await writeFakeExecutables(root);
    process.env.MAPBENCH_DOCKER = executables.docker;
    process.env.MAPBENCH_PI = executables.pi;
    process.env.FAKE_DEEPSWE_APP = fixture.target;
    const completed = await runBenchmark({
      repo: "",
      deepSweCheckout: fixture.checkout,
      taskIds: fixture.ids,
      runs: 3,
      conditions: ["regular-code", "outline-only"],
      provider: "openai-codex",
      model: "fixed-test-model",
      timeoutMs: 5_000,
      dryRun: false,
      keepWorkspaces: false,
      outputRoot: path.join(root, "results"),
      tasksRoot: path.join(root, "unused-tasks"),
      pricingMode: "off",
      seed: "deepswe-smoke",
      debugUsage: false,
    }, tasks);
    assert.equal(completed.runs.length, 12);
    for (const run of completed.runs) {
      assert.equal(run.status, "completed");
      assert.equal(fixture.targetCommit.startsWith(run.targetCommit), true);
      assert.equal(run.hiddenGrader.passed, true);
      assert.equal(run.hiddenGrader.score, 1);
      assert.equal(verifierReward(run.hiddenGrader.details), 1);
      assert.equal(run.isolation.tools, "workspace-read-write-docker-isolated");
      assert.equal(run.isolation.resources, "task-docker-limits");
      const directory = path.join(completed.resultsRoot, run.artifactDirectory);
      const patch = await fs.readFile(path.join(directory, "changes.patch"), "utf8");
      assert.match(patch, new RegExp(`DeepSWE smoke instruction for ${run.taskId}`));
      assert.doesNotMatch(patch, /REFERENCE_SOLUTION_SECRET/);
      assert.equal(await fs.stat(path.join(directory, "deepswe", "verifier", "reward.json")).then((value) => value.isFile()), true);
      assert.equal(await fs.stat(path.join(directory, "deepswe", "verifier", "ctrf.json")).then((value) => value.isFile()), true);
    }
    assert.deepEqual([...new Set(completed.runs.map((run) => run.condition))].sort(), ["outline-only", "regular-code"]);
    assert.equal(completed.plan[0].repository.startsWith("https://github.com/example/"), true);
    assert.equal(completed.plan[0].targetCommit, fixture.targetCommit);
    assert.match(completed.plan[0].piCommand.at(-1) ?? "", /DeepSWE smoke instruction/);
    const config = JSON.parse(await fs.readFile(path.join(completed.resultsRoot, "config.json"), "utf8"));
    assert.equal(config.deepSwe.revision, fixture.source.revision);
    assert.equal(config.graderPreflight[fixture.ids[0]].passed, false);
    assert.equal(config.graderPreflight[fixture.ids[0]].details.reward.reward, 0);
  } finally {
    if (previous.docker === undefined) delete process.env.MAPBENCH_DOCKER; else process.env.MAPBENCH_DOCKER = previous.docker;
    if (previous.pi === undefined) delete process.env.MAPBENCH_PI; else process.env.MAPBENCH_PI = previous.pi;
    if (previous.app === undefined) delete process.env.FAKE_DEEPSWE_APP; else process.env.FAKE_DEEPSWE_APP = previous.app;
    await fs.rm(root, { recursive: true, force: true });
  }
});
