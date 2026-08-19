import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateReport, renderGraphics } from "../report.js";
import { buildSummary } from "../summary.js";
import { emptyNavigationMetrics } from "../navigation.js";
import { buildTrialTelemetry } from "../telemetry.js";
import type { CheckResult, RunResult, TokenUsage } from "../types.js";

const check: CheckResult = { status: "unavailable", command: null, exitCode: null, durationMs: 0, stdout: "", stderr: "" };
const tokens: TokenUsage = {
  input: 4, uncachedInput: 3, cachedInput: 1, output: 2, reasoning: 0, total: 6,
  provenance: { source: "pi-jsonl", eventType: "message_end", eventLines: [1], rawEventFile: "usage-events.json",
    fields: { input: "derived: message.usage.input + cacheRead + cacheWrite", uncachedInput: "derived: message.usage.input + cacheWrite", cachedInput: "message.usage.cacheRead", output: "message.usage.output",
      reasoning: "message.usage.reasoning", total: "derived: total input + message.usage.output" } },
};
const run: RunResult = {
  schemaVersion: 4, pairId: "task:run-001", taskId: "task", condition: "regular-code", run: 1, targetCommit: "a", baselineCommit: "b",
  baselineTreeHash: "treehash", promptSha256: "prompthash", provider: "openai-codex", model: "fixed",
  trial: { taskId: "task", condition: "regular-code", repetition: 1, model: "fixed", provider: "openai-codex", backend: "docker", harness: "pi", repoCommit: "a", configurationSha256: "confighash", promptSha256: "prompthash" },
  status: "failed", exitCode: 1, durationMs: 1200, tokens,
  telemetry: buildTrialTelemetry({ modelTurns: 1, toolCalls: 0, sourceFileReads: 0, artifactReads: 0, graphQueries: 0, searches: 0, edits: 0, shellCommands: 0, failedToolCalls: 0 }, tokens,
    { ...check, status: "failed", score: 0, maxScore: 1, passed: false, details: null }, 1200),
  estimatedCostUsd: null, commands: [], commandCount: 0, failedCommandCount: 0, finalResponse: "", filesChanged: [], fileCount: 0,
  navigation: emptyNavigationMetrics(),
  editNavigation: { firstSourceEditObserved: false, elapsedMs: null, censoredAtMs: 1200, eventLine: null },
  hiddenGrader: { ...check, status: "failed", score: 0, maxScore: 1, passed: false,
    details: { metrics: { nodeRecall: 0.5, sourceLinesRetrieved: 12 } } }, checks: { regression: check, typecheck: check, build: check },
  artifactDirectory: "regular-code/task/run-001", workspaceKept: false,
  isolation: { harness: "pi", freshProcess: true, resumedSession: false, ephemeralSession: true, freshWorkspace: true,
    originalGitObjectsRemoved: true, piHome: "fresh-auth-only", initialPiHomeFiles: ["auth.json"], piHomeRemoved: true,
    contextFiles: "disabled", resources: "explicit-extension-only", tools: "workspace-read-only" },
};

test("report generation is deterministic, self-contained, and emits every required graphic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-report-"));
  try {
    const outlineRun: RunResult = { ...run, condition: "outline-only", artifactDirectory: "outline-only/task/run-001" };
    const summary = buildSummary([run, outlineRun], "2026-01-01T00:00:00.000Z");
    const graphics = renderGraphics(summary);
    assert.deepEqual(Object.keys(graphics).sort(), [
      "figure-1-main-performance.svg",
      "figure-2-task-condition-heatmap.svg",
      "figure-3a-mean-total-tokens.svg",
      "figure-3b-mean-runtime.svg",
      "figure-4-navigation-cost.svg",
      "figure-5-per-task-treatment-effect.svg",
      "figure-6-median-token-breakdown.svg",
    ]);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await fs.mkdir(path.join(first, "graphics"), { recursive: true });
    await fs.writeFile(path.join(first, "graphics", "commands-executed.svg"), "obsolete");
    await generateReport(first, summary);
    await generateReport(second, summary);
    assert.equal(await fs.access(path.join(first, "graphics", "commands-executed.svg")).then(() => true, () => false), false);
    for (const file of ["summary.md", "report.html", "trials.csv", "conditions.csv", ...Object.keys(graphics).map((name) => `graphics/${name}`)]) {
      assert.equal(await fs.readFile(path.join(first, file), "utf8"), await fs.readFile(path.join(second, file), "utf8"), file);
    }
    const html = await fs.readFile(path.join(first, "report.html"), "utf8");
    assert.match(html, /<svg/);
    assert.match(html, /Task-by-task arithmetic means/);
    assert.match(html, /Task-specific evaluator means/);
    assert.match(html, /nodeRecall=50\.0%/);
    assert.match(html, /Modeled cost/);
    assert.match(html, /not an observed bill/);
    assert.match(html, /Telemetry by condition \(mean \/ median\)/);
    assert.match(html, /Efficiency telemetry is descriptive and does not adjust correctness/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/);
    const markdown = await fs.readFile(path.join(first, "summary.md"), "utf8");
    assert.match(markdown, /graphics\/figure-1-main-performance\.svg/);
    assert.doesNotMatch(markdown, /graphics\/commands-executed\.svg/);
    assert.match(markdown, /graphics\/figure-5-per-task-treatment-effect\.svg/);
    assert.match(markdown, /## Task-by-task arithmetic means/);
    assert.match(markdown, /sourceLinesRetrieved=12/);
    assert.match(markdown, /## Telemetry by condition \(mean \/ median\)/);
    const trialCsv = await fs.readFile(path.join(first, "trials.csv"), "utf8");
    assert.match(trialCsv, /configurationSha256/);
    assert.match(trialCsv, /sourceFileReads,artifactReads,graphQueries,searches,edits,shellCommands,failedToolCalls/);
    assert.match(trialCsv, /openedFiles,sourceFileReadCount,artifactReadCount,uniqueSourceFilesOpened,uniqueArtifactFilesOpened,artifactUsed/);
    assert.match(trialCsv, /failedSourceFileReadCount,failedArtifactReadCount,failedGraphQueryCount,failedAccesses,incompleteAccesses/);
    const conditionCsv = await fs.readFile(path.join(first, "conditions.csv"), "utf8");
    assert.match(conditionCsv, /regular-code,1,mean/);
    assert.match(conditionCsv, /regular-code,1,median/);
    assert.match(graphics["figure-1-main-performance.svg"], /Pass rate by condition/);
    assert.doesNotMatch(graphics["figure-1-main-performance.svg"], /Wilson|confidence|whisker/i);
    assert.match(graphics["figure-2-task-condition-heatmap.svg"], /data-task="task"/);
    assert.match(graphics["figure-2-task-condition-heatmap.svg"], /data-successes="0" data-samples="1"/);
    assert.match(graphics["figure-3a-mean-total-tokens.svg"], /Mean total tokens/);
    assert.match(graphics["figure-3b-mean-runtime.svg"], /Mean runtime \(seconds\)/);
    assert.doesNotMatch(graphics["figure-3a-mean-total-tokens.svg"], /Mean runtime/);
    assert.doesNotMatch(graphics["figure-3b-mean-runtime.svg"], /Mean total tokens/);
    assert.match(graphics["figure-3a-mean-total-tokens.svg"], /data-pass-rate=/);
    assert.match(graphics["figure-3b-mean-runtime.svg"], /data-pass-rate=/);
    assert.doesNotMatch(Object.values(graphics).join("\n"), /<text[^>]*>[^<]*(Wilson|confidence|whisker)/i);
    assert.match(graphics["figure-4-navigation-cost.svg"], /data-observed="false"/);
    assert.match(graphics["figure-5-per-task-treatment-effect.svg"], /no matched Full pairs/);
    assert.match(graphics["figure-6-median-token-breakdown.svg"], /Median token breakdown/);
    assert.match(graphics["figure-6-median-token-breakdown.svg"], /data-median-total="6"/);
    assert.match(graphics["figure-6-median-token-breakdown.svg"], /data-token-part="uncached" data-value="3"/);
    assert.match(graphics["figure-6-median-token-breakdown.svg"], /Uncached input/);
    assert.match(graphics["figure-6-median-token-breakdown.svg"], /Cached input/);
    assert.match(graphics["figure-6-median-token-breakdown.svg"], /Visible output/);
    assert.match(graphics["figure-6-median-token-breakdown.svg"], /Reasoning/);
    assert.doesNotMatch(Object.values(graphics).join("\n"), /source bytes|source KB|Output KB|Cumulative KB/i);
    assert.doesNotMatch(html, /Output KB|Cumulative KB/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("paired accuracy graphics use only matched regular-code pairs", () => {
  const raw: RunResult = {
    ...run,
    pairId: "map:run-001",
    taskId: "map-project",
    condition: "regular-code",
    durationMs: 1000,
    tokens: { ...run.tokens, total: 100 },
  };
  const full: RunResult = {
    ...raw,
    condition: "all-outline-aids",
    durationMs: 2000,
    tokens: { ...raw.tokens, total: 140 },
    hiddenGrader: { ...raw.hiddenGrader, status: "passed", score: 1, passed: true },
  };
  const unmatched: RunResult = {
    ...full,
    pairId: "map:unmatched",
    run: 2,
    durationMs: 99_000,
    tokens: { ...full.tokens, total: 99_000 },
    hiddenGrader: { ...full.hiddenGrader, status: "failed", score: 0, passed: false },
  };
  const foreignRaw: RunResult = {
    ...raw,
    taskId: "different-task",
    hiddenGrader: { ...raw.hiddenGrader, status: "passed", score: 1, passed: true },
  };
  const summary = buildSummary([raw, foreignRaw, full, unmatched], "2026-01-01T00:00:00.000Z");
  const fullCondition = summary.conditions.find((item) => item.condition === "all-outline-aids");
  assert.deepEqual(fullCondition?.pairedVsRaw, { wins: 1, losses: 0, ties: 0 });
  const graphics = renderGraphics(summary);
  assert.match(graphics["figure-5-per-task-treatment-effect.svg"], /data-condition="all-outline-aids" data-delta="1" data-pairs="1"/);
  assert.doesNotMatch(graphics["figure-5-per-task-treatment-effect.svg"], /99000/);
});
