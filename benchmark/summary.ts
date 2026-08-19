import type { BenchmarkSummary, Condition, NavigationMetrics, RunResult, SummaryCondition, TokenCounts } from "./types.js";
import { CONDITION_FACTORS, CONDITION_LABELS, CONDITIONS, DEFAULT_CONDITIONS, normalizeCondition } from "./types.js";
import { mean } from "./util.js";
import { emptyNavigationMetrics } from "./navigation.js";
import { telemetryStatistics, withVerifierTelemetry } from "./telemetry.js";

function normalizedScore(run: RunResult): number {
  return run.hiddenGrader.maxScore > 0 ? run.hiddenGrader.score / run.hiddenGrader.maxScore : 0;
}

function nullableMean(values: Array<number | null>): number | null {
  return values.every((value): value is number => value !== null) ? mean(values) : null;
}

function tokenMeans(runs: RunResult[]): TokenCounts {
  return {
    input: nullableMean(runs.map((run) => run.tokens.input)),
    uncachedInput: nullableMean(runs.map((run) => run.tokens.uncachedInput)),
    cachedInput: nullableMean(runs.map((run) => run.tokens.cachedInput)),
    output: nullableMean(runs.map((run) => run.tokens.output)),
    reasoning: nullableMean(runs.map((run) => run.tokens.reasoning)),
    total: nullableMean(runs.map((run) => run.tokens.total)),
  };
}

const navigationOf = (run: RunResult): NavigationMetrics => run.navigation ?? emptyNavigationMetrics();

function navigationMeans(runs: RunResult[]): NavigationMetrics {
  const values = runs.map(navigationOf);
  const numberMean = (key: Exclude<keyof NavigationMetrics, "outlineUsed">): number => mean(values.map((item) => item[key]));
  return {
    outlineAccessCommandCount: numberMean("outlineAccessCommandCount"),
    successfulOutlineAccessCommandCount: numberMean("successfulOutlineAccessCommandCount"),
    sourceAccessCommandCount: numberMean("sourceAccessCommandCount"),
    mixedAccessCommandCount: numberMean("mixedAccessCommandCount"),
    failedNavigationCommandCount: numberMean("failedNavigationCommandCount"),
    outlineOutputBytes: numberMean("outlineOutputBytes"),
    sourceOutputBytes: numberMean("sourceOutputBytes"),
    mixedOutputBytes: numberMean("mixedOutputBytes"),
    commandOutputBytes: numberMean("commandOutputBytes"),
    cumulativeOutputBytes: numberMean("cumulativeOutputBytes"),
    duplicateSourceReadCount: numberMean("duplicateSourceReadCount"),
    duplicateSourceReadLines: numberMean("duplicateSourceReadLines"),
    uniqueOutlineFiles: numberMean("uniqueOutlineFiles"),
    uniqueSourceFiles: numberMean("uniqueSourceFiles"),
    outlineUsed: values.some((item) => item.outlineUsed),
  };
}

export function buildSummary(runs: RunResult[], generatedAt = new Date().toISOString()): BenchmarkSummary {
  runs = runs.map((run) => {
    const condition = normalizeCondition(run.condition);
    return {
      ...run,
      condition,
      telemetry: withVerifierTelemetry(run.telemetry, run.hiddenGrader),
      trial: {
        ...run.trial,
        taskId: run.taskId,
        condition,
        repetition: run.run,
        model: run.model,
        provider: run.provider,
        repoCommit: run.targetCommit,
        promptSha256: run.promptSha256,
      },
    };
  });
  const smoke = runs.length > 0 && runs.every((run) => run.smoke === true);
  const pairKey = (run: RunResult) => `${run.taskId}\0${run.pairId}`;
  const rawByPair = new Map(runs.filter((run) => run.condition === "regular-code").map((run) => [pairKey(run), run]));
  const conditionOrder = [...DEFAULT_CONDITIONS, ...CONDITIONS.filter((condition) => !DEFAULT_CONDITIONS.includes(condition))];
  const conditions: SummaryCondition[] = conditionOrder.flatMap((condition) => {
    const samples = runs.filter((run) => run.condition === condition);
    if (samples.length === 0) return [];
    const outcomes = { wins: 0, losses: 0, ties: 0 };
    if (condition !== "regular-code") {
      for (const run of samples) {
        const raw = rawByPair.get(pairKey(run));
        if (!raw) continue;
        const delta = normalizedScore(run) - normalizedScore(raw);
        if (delta > 1e-9) outcomes.wins += 1;
        else if (delta < -1e-9) outcomes.losses += 1;
        else outcomes.ties += 1;
      }
    }
    const priced = samples.map((run) => run.estimatedCostUsd).filter((value): value is number => value !== null);
    return [{
      condition,
      samples: samples.length,
      successes: samples.filter((run) => run.hiddenGrader.passed).length,
      successRate: samples.filter((run) => run.hiddenGrader.passed).length / samples.length,
      hiddenScoreMean: mean(samples.map(normalizedScore)),
      durationMeanMs: mean(samples.map((run) => run.durationMs)),
      tokensMean: tokenMeans(samples),
      costMeanUsd: priced.length === samples.length ? mean(priced) : null,
      commandsMean: mean(samples.map((run) => run.commandCount)),
      filesMean: mean(samples.map((run) => run.fileCount)),
      navigationMean: navigationMeans(samples),
      telemetry: telemetryStatistics(samples.map((run) => run.telemetry)),
      accuracyPer100kTokensMean: nullableMean(samples.map((run) =>
        run.tokens.total === null ? null : normalizedScore(run) * 100_000 / Math.max(1, run.tokens.total))),
      pairedVsRaw: outcomes,
    }];
  });
  const full = conditions.find((condition) => condition.condition === "all-outline-aids");
  const factorLabels: Record<keyof typeof CONDITION_FACTORS[Condition], string> = {
    outline: "architecture map",
    skeleton: "skeleton",
    callgraph: "call graph",
  };
  const ablations = full ? conditions.filter((condition) => condition.condition !== "all-outline-aids").map((condition) => ({
    condition: condition.condition,
    removed: (Object.keys(factorLabels) as Array<keyof typeof factorLabels>)
      .filter((factor) => !CONDITION_FACTORS[condition.condition][factor])
      .map((factor) => factorLabels[factor])
      .join(", "),
    successRateDelta: condition.successRate - full.successRate,
    hiddenScoreDelta: condition.hiddenScoreMean - full.hiddenScoreMean,
    durationDeltaMs: condition.durationMeanMs - full.durationMeanMs,
    tokensDelta: condition.tokensMean.total === null || full.tokensMean.total === null
      ? null
      : condition.tokensMean.total - full.tokensMean.total,
  })) : [];
  const tasks = [...new Set(runs.map((run) => run.taskId))].sort();
  const active = new Set(conditions.map((item) => item.condition));
  const missing = DEFAULT_CONDITIONS.filter((condition) => !active.has(condition));
  const repetitionsRequired = smoke ? 1 : 3;
  const underReplicated = tasks.some((taskId) => conditions.some(({ condition }) =>
    runs.filter((run) => run.taskId === taskId && run.condition === condition).length < repetitionsRequired));
  const warnings = [
    ...(smoke ? ["Smoke mode is infrastructure validation only; results are not publication-quality experimental measurements."] : []),
    ...(missing.length ? [`Incomplete targeted comparison: missing ${missing.map((condition) => CONDITION_LABELS[condition]).join(", ")}.`] : []),
    ...(underReplicated ? [`Fewer than ${repetitionsRequired} repetition${repetitionsRequired === 1 ? "" : "s"} are available for at least one task-condition cell; means are incomplete.`] : []),
  ];
  return {
    schemaVersion: 3,
    generatedAt,
    smoke,
    tasks,
    totalRuns: runs.length,
    warnings,
    conditions,
    ablations,
    runs: [...runs].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.run - b.run ||
      conditionOrder.indexOf(a.condition) - conditionOrder.indexOf(b.condition)),
  };
}
