#!/usr/bin/env bun
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHiddenGrader } from "./grader.js";
import { runProcess } from "./process.js";
import { generateReport } from "./report.js";
import { buildSummary } from "./summary.js";
import { loadTask } from "./tasks.js";
import type { BenchmarkSummary, RunResult } from "./types.js";
import { writeJson } from "./util.js";
import { removePrivateTaskFromWorkspace } from "./workspace.js";

async function checked(command: string[], cwd: string): Promise<void> {
  const result = await runProcess(command, { cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: bun run benchmark:regrade --results <directory>\n");
    return;
  }
  const index = args.findIndex((arg) => arg === "--results" || arg.startsWith("--results="));
  if (index < 0) throw new Error("--results is required.");
  const input = args[index].includes("=") ? args[index].split("=", 2)[1] : args[index + 1];
  if (!input) throw new Error("Missing value for --results.");
  const resultsRoot = path.resolve(input);
  const prior = JSON.parse(await fs.readFile(path.join(resultsRoot, "summary.json"), "utf8")) as BenchmarkSummary;
  const config = JSON.parse(await fs.readFile(path.join(resultsRoot, "config.json"), "utf8")) as {
    repo?: unknown; targetCommit?: unknown; tasksRoot?: unknown;
  };
  if (prior.schemaVersion !== 2 || !Array.isArray(prior.runs)) throw new Error("Unsupported summary.json schema.");
  if (typeof config.repo !== "string" || typeof config.targetCommit !== "string") throw new Error("config.json lacks repository provenance.");

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-outline-regrade-"));
  const workspace = path.join(temporary, "repository");
  try {
    await checked(["git", "clone", "--quiet", "--no-hardlinks", config.repo, workspace], temporary);
    await checked(["git", "checkout", "--quiet", "--detach", config.targetCommit], workspace);
    const tasksRoot = typeof config.tasksRoot === "string" ? path.resolve(config.tasksRoot) : path.resolve(import.meta.dirname, "tasks");
    await removePrivateTaskFromWorkspace(workspace, config.repo, tasksRoot);
    const taskCache = new Map<string, Awaited<ReturnType<typeof loadTask>>>();
    const runs: RunResult[] = [];
    for (const [index, original] of prior.runs.entries()) {
      const task = taskCache.get(original.taskId) ?? await loadTask(tasksRoot, original.taskId);
      taskCache.set(original.taskId, task);
      const artifactDirectory = path.isAbsolute(original.artifactDirectory)
        ? original.artifactDirectory
        : path.join(resultsRoot, original.artifactDirectory);
      const answer = path.join(artifactDirectory, "final-message.md");
      const events = path.join(artifactDirectory, "events.jsonl");
      const hiddenGrader = await runHiddenGrader(task, workspace, answer, events);
      const run = { ...original, hiddenGrader };
      runs.push(run);
      await Promise.all([
        writeJson(path.join(artifactDirectory, "grader.json"), hiddenGrader),
        writeJson(path.join(artifactDirectory, "result.json"), run),
      ]);
      process.stdout.write(`[${index + 1}/${prior.runs.length}] ${original.taskId} ${original.condition}: ${(hiddenGrader.score / hiddenGrader.maxScore * 100).toFixed(1)}%\n`);
    }
    const summary = buildSummary(runs);
    const regradedAt = new Date().toISOString();
    await Promise.all([
      writeJson(path.join(resultsRoot, "summary.json"), summary),
      writeJson(path.join(resultsRoot, "regrade.json"), {
        regradedAt,
        targetCommit: config.targetCommit,
        sourceSummaryGeneratedAt: prior.generatedAt,
        responsesReused: runs.length,
        modelInvocations: 0,
      }),
    ]);
    await generateReport(resultsRoot, summary);
    process.stdout.write(`Regraded ${runs.length} persisted responses without invoking Codex: ${resultsRoot}\n`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`benchmark:regrade: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
