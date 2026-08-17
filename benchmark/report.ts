import { promises as fs } from "node:fs";
import path from "node:path";
import type { BenchmarkSummary, Condition, NavigationMetrics, RunResult, SummaryCondition } from "./types.js";
import { CONDITION_FACTORS, CONDITION_LABELS, CONDITIONS, DEFAULT_CONDITIONS } from "./types.js";
import { escapeHtml, mean } from "./util.js";
import { renderPublicationGraphics } from "./figures.js";

const COLORS: Record<Condition, string> = {
  "regular-code": "#64748b",
  "outline-only": "#0369a1", "skeleton-only": "#c2410c", "callgraph-only": "#047857",
  "outline-skeleton": "#ea580c", "outline-callgraph": "#0d9488", "skeleton-callgraph": "#65a30d",
  "all-outline-aids": "#0f766e",
};
const LABELS = CONDITION_LABELS;

const FACTOR_NAMES: Record<keyof typeof CONDITION_FACTORS[Condition], string> = {
  outline: "Architecture map", skeleton: "Skeleton", callgraph: "Call graph",
};
const FACTOR_CODES: Record<keyof typeof CONDITION_FACTORS[Condition], string> = {
  outline: "A", skeleton: "S", callgraph: "C",
};
const CONDITION_LEGEND_SPACE = 160;

function xml(value: unknown): string {
  return escapeHtml(String(value));
}

function conditionGlossary(height: number): string {
  const top = height - 138;
  return `<rect x="34" y="${top}" width="1012" height="114" rx="6" fill="#f1f5f9" stroke="#dbe4ee"/>
<text x="50" y="${top + 19}" font-family="Inter,ui-sans-serif,system-ui" font-size="10.5" font-weight="800" letter-spacing=".08em" fill="#64748b">CONDITION LEGEND</text>
<text x="50" y="${top + 40}" font-family="Inter,ui-sans-serif,system-ui" font-size="11.5" fill="#475569"><tspan font-weight="700">Regular code</tspan><tspan> — no generated project-outline aids</tspan></text>
<text x="540" y="${top + 40}" font-family="Inter,ui-sans-serif,system-ui" font-size="11.5" fill="#475569"><tspan font-weight="700">All three artifacts</tspan><tspan> — complete generated set</tspan></text>
<text x="50" y="${top + 61}" font-family="Inter,ui-sans-serif,system-ui" font-size="11.5" fill="#475569"><tspan font-weight="700">Architecture map</tspan><tspan> — one system-level index</tspan></text>
<text x="50" y="${top + 82}" font-family="Inter,ui-sans-serif,system-ui" font-size="11.5" fill="#475569"><tspan font-weight="700">Skeleton</tspan><tspan> — mirrored declarations without bodies</tspan></text>
<text x="540" y="${top + 82}" font-family="Inter,ui-sans-serif,system-ui" font-size="11.5" fill="#475569"><tspan font-weight="700">Call graph</tspan><tspan> — symbol relationships + query helper</tspan></text>
<text x="50" y="${top + 103}" font-family="Inter,ui-sans-serif,system-ui" font-size="10.5" fill="#64748b">Generated conditions get the same path-only discovery notice.</text>`;
}

function svgFrame(title: string, subtitle: string, body: string, height = 470): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${xml(title)}</title><desc id="desc">${xml(subtitle)}</desc>
<rect width="1080" height="${height}" rx="16" fill="#f8fafc"/><rect x="1" y="1" width="1078" height="${height - 2}" rx="15" fill="none" stroke="#dbe4ee"/>
<text x="48" y="56" font-family="Inter,ui-sans-serif,system-ui" font-size="26" font-weight="700" fill="#0f172a">${xml(title)}</text>
<text x="48" y="83" font-family="Inter,ui-sans-serif,system-ui" font-size="14" fill="#64748b">${xml(subtitle)}</text>
${body}${conditionGlossary(height)}</svg>\n`;
}

function chartHeight(rowCount: number, rowHeight: number, top = 120, extra = 0): number {
  return Math.max(470, top + rowCount * rowHeight + extra + CONDITION_LEGEND_SPACE);
}

function conditionCode(condition: Condition): string {
  if (condition === "regular-code") return "Code";
  if (condition === "all-outline-aids") return "All";
  const factors = CONDITION_FACTORS[condition];
  return (["outline", "skeleton", "callgraph"] as const)
    .filter((factor) => factors[factor])
    .map((factor) => FACTOR_CODES[factor])
    .join("+");
}

function noData(label: string): string {
  return `<text x="540" y="245" text-anchor="middle" font-family="Inter,ui-sans-serif,system-ui" font-size="18" fill="#94a3b8">${xml(label)}</text>`;
}

function barChart(
  title: string,
  subtitle: string,
  conditions: SummaryCondition[],
  value: (condition: SummaryCondition) => number | null,
  format: (value: number) => string,
): string {
  const entries = conditions.map((condition) => ({ condition, value: value(condition) }));
  const numeric = entries.flatMap((entry) => entry.value === null ? [] : [entry.value]);
  if (!numeric.length) return svgFrame(title, subtitle, noData("Pricing is not configured for this model."));
  const max = Math.max(...numeric, 0.000001);
  const barX = 320;
  const barWidth = 580;
  const body = entries.map((entry, index) => {
    const y = 120 + index * 58;
    const width = entry.value === null ? 0 : barWidth * entry.value / max;
    return `<text x="48" y="${y + 22}" font-family="Inter,ui-sans-serif,system-ui" font-size="14" font-weight="600" fill="#334155">${xml(LABELS[entry.condition.condition])}</text>
<rect x="${barX}" y="${y}" width="${barWidth}" height="30" rx="4" fill="#e7edf4"/><rect x="${barX}" y="${y}" width="${width.toFixed(2)}" height="30" rx="4" fill="${COLORS[entry.condition.condition]}"/>
<text x="${Math.max(barX + 15, barX + 12 + width)}" y="${y + 21}" font-family="Inter,ui-sans-serif,system-ui" font-size="14" font-weight="700" fill="#0f172a">${entry.value === null ? "N/A" : xml(format(entry.value))}</text>
<text x="1018" y="${y + 21}" text-anchor="end" font-family="Inter,ui-sans-serif,system-ui" font-size="13" fill="#64748b">n=${entry.condition.samples}</text>`;
  }).join("\n");
  return svgFrame(title, subtitle, body, chartHeight(entries.length, 58));
}

function conditionDesign(conditions: Condition[]): string {
  const columns: Array<keyof typeof CONDITION_FACTORS[Condition]> = ["outline", "skeleton", "callgraph"];
  const body = `<g font-family="Inter,ui-sans-serif,system-ui">${columns.map((label, index) =>
    `<text x="${460 + index * 140}" y="125" text-anchor="middle" font-size="12" font-weight="700" fill="#475569">${xml(FACTOR_NAMES[label])}</text>`).join("")}
${conditions.map((condition, row) => {
  const y = 160 + row * 48;
  const values = columns.map((factor) => CONDITION_FACTORS[condition][factor]);
  return `<rect x="34" y="${y - 25}" width="1012" height="42" rx="5" fill="${row % 2 ? "#ffffff" : "#f1f5f9"}"/>
<circle cx="56" cy="${y - 4}" r="7" fill="${COLORS[condition]}"/><text x="76" y="${y + 1}" font-size="15" font-weight="700" fill="#1e293b">${xml(LABELS[condition])}</text>
${values.map((enabled, col) => `<circle cx="${460 + col * 140}" cy="${y - 4}" r="11" fill="${enabled ? COLORS[condition] : "#e2e8f0"}"/><text x="${460 + col * 140}" y="${y + 1}" text-anchor="middle" font-size="14" font-weight="800" fill="${enabled ? "#fff" : "#94a3b8"}">${enabled ? "✓" : "–"}</text>`).join("")}`;
}).join("")}</g>`;
  const isTargeted = conditions.length === DEFAULT_CONDITIONS.length &&
    DEFAULT_CONDITIONS.every((condition) => conditions.includes(condition));
  const subtitle = conditions.length === CONDITIONS.length
    ? "Optional factorial design: all 8 combinations of the three generated artifacts are measured independently."
    : isTargeted
      ? "Targeted default: baseline, each artifact in isolation, and Full MapBench."
      : "Selected conditions; only combinations with persisted runs are shown.";
  return svgFrame("Benchmark condition design", subtitle, body, chartHeight(conditions.length, 48, 140));
}

function tokenBreakdown(conditions: SummaryCondition[]): string {
  const max = Math.max(...conditions.map((item) => item.tokensMean.total ?? 0), 1);
  const barX = 320;
  const barWidth = 580;
  const parts: Array<[keyof SummaryCondition["tokensMean"], string, string]> = [
    ["uncachedInput", "Uncached input", "#0f766e"], ["cachedInput", "Cached input", "#5eead4"], ["output", "Visible output", "#7c3aed"], ["reasoning", "Reasoning", "#f59e0b"],
  ];
  const body = conditions.map((condition, index) => {
    const y = 132 + index * 54;
    let x = barX;
    const segments = parts.map(([key, _label, color]) => {
      const raw = condition.tokensMean[key];
      const amount = typeof raw !== "number" ? 0 : key === "output" ? Math.max(0, raw - (condition.tokensMean.reasoning ?? 0)) : raw;
      const width = barWidth * amount / max;
      const segment = `<rect x="${x.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="28" fill="${color}"/>`;
      x += width;
      return segment;
    }).join("");
    return `<text x="48" y="${y + 20}" font-family="Inter,ui-sans-serif,system-ui" font-size="14" font-weight="600" fill="#334155">${xml(LABELS[condition.condition])}</text><rect x="${barX}" y="${y}" width="${barWidth}" height="28" rx="4" fill="#e2e8f0"/>${segments}<text x="920" y="${y + 20}" font-family="Inter,ui-sans-serif,system-ui" font-size="13" fill="#475569">${condition.tokensMean.total === null ? "N/A" : condition.tokensMean.total.toLocaleString()}</text>`;
  }).join("");
  const legendY = 132 + conditions.length * 54 + 10;
  const legend = parts.map(([_key, label, color], index) => `<rect x="${48 + index * 170}" y="${legendY}" width="12" height="12" rx="2" fill="${color}"/><text x="${66 + index * 170}" y="${legendY + 11}" font-family="Inter,ui-sans-serif,system-ui" font-size="12" fill="#64748b">${label}</text>`).join("");
  return svgFrame("Mean token breakdown", "Arithmetic mean of three fresh runs. Total input equals uncached plus cached input; cached input is never counted twice.", `${body}${legend}`, chartHeight(conditions.length, 54, 132, 28));
}

const EMPTY_NAVIGATION: NavigationMetrics = {
  outlineAccessCommandCount: 0, successfulOutlineAccessCommandCount: 0, sourceAccessCommandCount: 0,
  mixedAccessCommandCount: 0, failedNavigationCommandCount: 0, outlineOutputBytes: 0, sourceOutputBytes: 0,
  mixedOutputBytes: 0, commandOutputBytes: 0, cumulativeOutputBytes: 0, duplicateSourceReadCount: 0,
  duplicateSourceReadLines: 0, uniqueOutlineFiles: 0, uniqueSourceFiles: 0, outlineUsed: false,
};

function navigationOf(condition: SummaryCondition): NavigationMetrics {
  return condition.navigationMean ?? EMPTY_NAVIGATION;
}

function pairedOutcomes(conditions: SummaryCondition[]): string {
  const compared = conditions.filter((item) => item.condition !== "regular-code");
  if (!compared.length) return svgFrame("Paired outcomes versus regular code", "Wins and losses compare normalized hidden-test scores within each pair.", noData("Select regular code and at least one comparison condition."));
  const max = Math.max(...compared.map((item) => item.pairedVsRaw.wins + item.pairedVsRaw.losses + item.pairedVsRaw.ties), 1);
  const body = compared.map((item, index) => {
    const y = 135 + index * 62;
    let x = 320;
    const pieces: Array<[number, string]> = [[item.pairedVsRaw.wins, "#16a34a"], [item.pairedVsRaw.ties, "#94a3b8"], [item.pairedVsRaw.losses, "#dc2626"]];
    const bars = pieces.map(([count, color]) => {
      const width = count / max * 560;
      const output = `<rect x="${x}" y="${y}" width="${width}" height="30" fill="${color}"/>`;
      x += width;
      return output;
    }).join("");
    return `<text x="48" y="${y + 21}" font-family="Inter,ui-sans-serif,system-ui" font-size="14" font-weight="600" fill="#334155">${xml(LABELS[item.condition])}</text><rect x="320" y="${y}" width="560" height="30" rx="4" fill="#e2e8f0"/>${bars}<text x="900" y="${y + 21}" font-family="Inter,ui-sans-serif,system-ui" font-size="13" fill="#475569">${item.pairedVsRaw.wins}W · ${item.pairedVsRaw.losses}L · ${item.pairedVsRaw.ties}T</text>`;
  }).join("");
  return svgFrame("Paired outcomes versus regular code", "Wins and losses compare normalized hidden-test scores within the same task and repetition.", body, chartHeight(compared.length, 62, 135));
}

function taskHeatmap(summary: BenchmarkSummary): string {
  const active = summary.conditions.map((item) => item.condition);
  const left = 220;
  const cell = Math.min(100, 800 / Math.max(1, active.length));
  const body = `${active.map((condition, index) => `<text x="${left + (index + .5) * cell}" y="125" text-anchor="middle" font-family="Inter,ui-sans-serif,system-ui" font-size="11" font-weight="700" fill="#475569">${xml(conditionCode(condition))}</text>`).join("")}
${summary.tasks.map((task, row) => {
  const y = 150 + row * 52;
  return `<text x="48" y="${y + 29}" font-family="Inter,ui-sans-serif,system-ui" font-size="14" font-weight="600" fill="#334155">${xml(task)}</text>${active.map((condition, col) => {
    const runs = summary.runs.filter((run) => run.taskId === task && run.condition === condition);
    const score = runs.length ? runs.reduce((sum, run) => sum + run.hiddenGrader.score / Math.max(1, run.hiddenGrader.maxScore), 0) / runs.length : 0;
    const lightness = 94 - score * 56;
    return `<rect x="${left + col * cell + 2}" y="${y}" width="${Math.max(12, cell - 4)}" height="40" rx="4" fill="hsl(171 70% ${lightness}%)"/><text x="${left + (col + .5) * cell}" y="${y + 26}" text-anchor="middle" font-family="Inter,ui-sans-serif,system-ui" font-size="12" font-weight="700" fill="${score > .55 ? "#fff" : "#134e4a"}">${(score * 100).toFixed(0)}%</text>`;
  }).join("")}`;
}).join("")}`;
  return svgFrame("Task × condition heatmap", "Mean normalized hidden-test score. Column codes use A = architecture map, S = skeleton, C = call graph.", body, Math.max(470, 280 + summary.tasks.length * 52));
}

interface TaskConditionMetrics {
  taskId: string;
  condition: Condition;
  samples: number;
  successes: number;
  successRate: number;
  hiddenScoreMean: number;
  durationMeanMs: number;
  tokensMean: number | null;
  costMeanUsd: number | null;
  commandsMean: number;
  filesMean: number;
  accuracyPer100kTokensMean: number | null;
  duplicateSourceReadLinesMean: number;
  failedNavigationMean: number;
  failedChecks: string;
}

function failedGraderChecks(run: RunResult): string[] {
  const details = run.hiddenGrader.details;
  if (!details || typeof details !== "object") return [];
  const checks = (details as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    if (!check || typeof check !== "object") return [];
    const item = check as { name?: unknown; passed?: unknown };
    return item.passed === false && typeof item.name === "string" && item.name !== "workspace_unchanged" ? [item.name] : [];
  });
}

function taskBreakdown(summary: BenchmarkSummary): TaskConditionMetrics[] {
  const active = summary.conditions.map((item) => item.condition);
  return summary.tasks.flatMap((taskId) => active.flatMap((condition) => {
    const runs = summary.runs.filter((run) => run.taskId === taskId && run.condition === condition);
    if (!runs.length) return [];
    const priced = runs.map((run) => run.estimatedCostUsd).filter((value): value is number => value !== null);
    const successes = runs.filter((run) => run.hiddenGrader.passed).length;
    const failedCheckCounts = new Map<string, number>();
    for (const run of runs) {
      for (const name of failedGraderChecks(run)) failedCheckCounts.set(name, (failedCheckCounts.get(name) ?? 0) + 1);
    }
    return [{
      taskId,
      condition,
      samples: runs.length,
      successes,
      successRate: successes / runs.length,
      hiddenScoreMean: mean(runs.map((run) => run.hiddenGrader.score / Math.max(1, run.hiddenGrader.maxScore))),
      durationMeanMs: mean(runs.map((run) => run.durationMs)),
      tokensMean: runs.every((run) => run.tokens.total !== null)
        ? mean(runs.map((run) => run.tokens.total as number))
        : null,
      costMeanUsd: priced.length === runs.length ? mean(priced) : null,
      commandsMean: mean(runs.map((run) => run.commandCount)),
      filesMean: mean(runs.map((run) => run.fileCount)),
      accuracyPer100kTokensMean: runs.every((run) => run.tokens.total !== null)
        ? mean(runs.map((run) => run.hiddenGrader.score / Math.max(1, run.hiddenGrader.maxScore) * 100_000 /
          Math.max(1, run.tokens.total as number)))
        : null,
      duplicateSourceReadLinesMean: mean(runs.map((run) => run.navigation?.duplicateSourceReadLines ?? 0)),
      failedNavigationMean: mean(runs.map((run) => run.navigation?.failedNavigationCommandCount ?? 0)),
      failedChecks: [...failedCheckCounts]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([name, count]) => `${name} (${count}/${runs.length})`)
        .join(", ") || "—",
    }];
  }));
}

function evaluatorMetricRows(summary: BenchmarkSummary): Array<{ taskId: string; condition: Condition; metrics: string }> {
  return summary.tasks.flatMap((taskId) => summary.conditions.flatMap(({ condition }) => {
    const metricMaps = summary.runs.filter((run) => run.taskId === taskId && run.condition === condition).flatMap((run) => {
      const details = run.hiddenGrader.details;
      if (!details || typeof details !== "object") return [];
      const metrics = (details as { metrics?: unknown }).metrics;
      return metrics && typeof metrics === "object" && !Array.isArray(metrics) ? [metrics as Record<string, unknown>] : [];
    });
    if (!metricMaps.length) return [];
    const names = [...new Set(metricMaps.flatMap((metrics) => Object.keys(metrics)))].sort();
    const rendered = names.flatMap((name) => {
      const values = metricMaps.map((metrics) => metrics[name])
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (!values.length) return [];
      const value = mean(values);
      const isCount = /lines|bodies|calls|tokens/i.test(name);
      return [`${name}=${isCount ? Number(value.toFixed(2)) : `${(value * 100).toFixed(1)}%`}`];
    });
    return rendered.length ? [{ taskId, condition, metrics: rendered.join(", ") }] : [];
  }));
}

function taskBarChart(
  title: string,
  subtitle: string,
  summary: BenchmarkSummary,
  value: (item: TaskConditionMetrics) => number | null,
  format: (value: number) => string,
  fixedMax?: number,
): string {
  const entries = taskBreakdown(summary);
  const numeric = entries.flatMap((entry) => {
    const item = value(entry);
    return item === null ? [] : [item];
  });
  if (!numeric.length) return svgFrame(title, subtitle, noData("No values are available for this metric."));
  const max = fixedMax ?? Math.max(...numeric, 0.000001);
  let y = 118;
  const body: string[] = [];
  for (const taskId of summary.tasks) {
    const taskEntries = entries.filter((entry) => entry.taskId === taskId);
    if (!taskEntries.length) continue;
    body.push(`<text x="48" y="${y + 17}" font-family="Inter,ui-sans-serif,system-ui" font-size="15" font-weight="750" fill="#0f172a">${xml(taskId)}</text>`);
    y += 30;
    for (const entry of taskEntries) {
      const item = value(entry);
      const width = item === null ? 0 : 540 * Math.max(0, item) / Math.max(max, 0.000001);
      body.push(`<text x="70" y="${y + 20}" font-family="Inter,ui-sans-serif,system-ui" font-size="12" font-weight="600" fill="#475569">${xml(LABELS[entry.condition])}</text>
<rect x="320" y="${y}" width="540" height="27" rx="4" fill="#e7edf4"/><rect x="320" y="${y}" width="${width.toFixed(2)}" height="27" rx="4" fill="${COLORS[entry.condition]}"/>
<text x="${Math.max(332, 332 + width)}" y="${y + 19}" font-family="Inter,ui-sans-serif,system-ui" font-size="13" font-weight="700" fill="#0f172a">${item === null ? "N/A" : xml(format(item))}</text>
<text x="1018" y="${y + 19}" text-anchor="end" font-family="Inter,ui-sans-serif,system-ui" font-size="12" fill="#64748b">n=${entry.samples}</text>`);
      y += 36;
    }
    y += 14;
  }
  return svgFrame(title, subtitle, body.join("\n"), Math.max(470, y + CONDITION_LEGEND_SPACE));
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function efficiencyFrontier(summary: BenchmarkSummary): string {
  const entries = taskBreakdown(summary).filter((entry) => entry.tokensMean !== null);
  if (!entries.length) return svgFrame("Accuracy × token efficiency", "Task-faceted efficiency frontier.", noData("No task metrics are available."));
  const maxTokens = Math.max(...entries.map((entry) => entry.tokensMean ?? 0), 1);
  const maxDuration = Math.max(...entries.map((entry) => entry.durationMeanMs), 1);
  const left = 210;
  const right = 930;
  const width = right - left;
  const body: string[] = [];
  let y = 120;
  for (const taskId of summary.tasks) {
    const taskEntries = entries.filter((entry) => entry.taskId === taskId);
    if (!taskEntries.length) continue;
    const top = y + 30;
    const bottom = top + 140;
    body.push(`<text x="48" y="${y + 17}" font-family="Inter,ui-sans-serif,system-ui" font-size="15" font-weight="750" fill="#0f172a">${xml(taskId)}</text>`);
    body.push(`<rect x="${left}" y="${top}" width="${(width * .27).toFixed(1)}" height="${((bottom - top) * .27).toFixed(1)}" rx="8" fill="#dcfce7" opacity=".72"/>
<text x="${left + 9}" y="${top + 16}" font-family="Inter,ui-sans-serif,system-ui" font-size="10" font-weight="700" fill="#15803d">Preferred corner ↖</text>`);
    for (const tick of [0, .5, 1]) {
      const tickY = bottom - tick * (bottom - top);
      body.push(`<line x1="${left}" y1="${tickY}" x2="${right}" y2="${tickY}" stroke="${tick === 0 ? "#94a3b8" : "#dbe4ee"}" stroke-dasharray="${tick === 0 ? "0" : "4 5"}"/><text x="${left - 14}" y="${tickY + 4}" text-anchor="end" font-family="Inter,ui-sans-serif,system-ui" font-size="11" fill="#64748b">${Math.round(tick * 100)}%</text>`);
    }
    for (const tick of [0, .5, 1]) {
      const tickX = left + tick * width;
      body.push(`<line x1="${tickX}" y1="${top}" x2="${tickX}" y2="${bottom}" stroke="#e2e8f0"/><text x="${tickX}" y="${bottom + 20}" text-anchor="middle" font-family="Inter,ui-sans-serif,system-ui" font-size="11" fill="#64748b">${compactNumber(maxTokens * tick)}</text>`);
    }
    const pareto = taskEntries.filter((candidate) => !taskEntries.some((other) =>
      other !== candidate && (other.tokensMean ?? 0) <= (candidate.tokensMean ?? 0) && other.hiddenScoreMean >= candidate.hiddenScoreMean &&
      ((other.tokensMean ?? 0) < (candidate.tokensMean ?? 0) || other.hiddenScoreMean > candidate.hiddenScoreMean)));
    const frontierPoints = [...pareto].sort((a, b) => (a.tokensMean ?? 0) - (b.tokensMean ?? 0)).map((entry) => {
      const x = left + (entry.tokensMean ?? 0) / maxTokens * width;
      const pointY = bottom - entry.hiddenScoreMean * (bottom - top);
      return `${x.toFixed(2)},${pointY.toFixed(2)}`;
    }).join(" ");
    if (pareto.length > 1) body.push(`<polyline points="${frontierPoints}" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-dasharray="6 5" opacity=".8"/>`);
    taskEntries.forEach((entry, index) => {
      const cx = left + (entry.tokensMean ?? 0) / maxTokens * width;
      const cy = bottom - entry.hiddenScoreMean * (bottom - top);
      const radius = 7 + 17 * Math.sqrt(entry.durationMeanMs / maxDuration);
      const labelY = cy + (index % 3 - 1) * 13 + 4;
      const efficient = pareto.includes(entry);
      if (efficient) body.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(radius + 5).toFixed(2)}" fill="none" stroke="#16a34a" stroke-width="3" opacity=".9"/>`);
      body.push(`<circle data-task="${xml(taskId)}" data-condition="${entry.condition}" data-pareto="${efficient}" data-tokens="${entry.tokensMean}" data-score="${entry.hiddenScoreMean}" data-duration-ms="${entry.durationMeanMs}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="${COLORS[entry.condition]}" fill-opacity=".78" stroke="#fff" stroke-width="2"/>
<text x="${Math.min(right - 3, cx + radius + 5)}" y="${labelY.toFixed(2)}" text-anchor="${cx + radius + 45 > right ? "end" : "start"}" font-family="Inter,ui-sans-serif,system-ui" font-size="11" font-weight="700" fill="#334155">${xml(conditionCode(entry.condition))}</text>`);
    });
    body.push(`<text x="${(left + right) / 2}" y="${bottom + 39}" text-anchor="middle" font-family="Inter,ui-sans-serif,system-ui" font-size="11" font-weight="600" fill="#64748b">Mean total tokens →</text>`);
    y += 225;
  }
  body.push(`<circle cx="59" cy="${y - 1}" r="8" fill="none" stroke="#16a34a" stroke-width="3"/><text x="76" y="${y + 3}" font-family="Inter,ui-sans-serif,system-ui" font-size="12" fill="#64748b">Green ring = Pareto-efficient (no condition is both more accurate and cheaper in tokens). Bubble size = runtime.</text>`);
  return svgFrame("Accuracy × token efficiency", "Each task is a separate panel; point codes use A = architecture map, S = skeleton, C = call graph.", body.join("\n"), Math.max(470, y + CONDITION_LEGEND_SPACE));
}

interface PairedTaskDelta {
  taskId: string;
  condition: Condition;
  pairs: number;
  delta: number;
}

function pairedTaskDeltas(summary: BenchmarkSummary, metric: (run: RunResult) => number): PairedTaskDelta[] {
  const rawByPair = new Map(summary.runs.filter((run) => run.condition === "regular-code").map((run) => [run.pairId, run]));
  return summary.tasks.flatMap((taskId) => summary.conditions.flatMap(({ condition }) => {
    if (condition === "regular-code") return [];
    const deltas = summary.runs
      .filter((run) => run.taskId === taskId && run.condition === condition)
      .flatMap((run) => {
        const raw = rawByPair.get(run.pairId);
        return raw && raw.taskId === taskId ? [metric(run) - metric(raw)] : [];
      });
    return deltas.length ? [{ taskId, condition, pairs: deltas.length, delta: mean(deltas) }] : [];
  }));
}

function pairedDeltaChart(
  title: string,
  subtitle: string,
  summary: BenchmarkSummary,
  metric: (run: RunResult) => number,
  format: (value: number) => string,
): string {
  const entries = pairedTaskDeltas(summary, metric);
  if (!entries.length) return svgFrame(title, subtitle, noData("Select regular code and at least one paired comparison condition."));
  const max = Math.max(...entries.map((entry) => Math.abs(entry.delta)), 0.000001);
  const center = 540;
  const span = 340;
  let y = 120;
  const body: string[] = [];
  for (const taskId of summary.tasks) {
    const taskEntries = entries.filter((entry) => entry.taskId === taskId);
    if (!taskEntries.length) continue;
    body.push(`<text x="48" y="${y + 17}" font-family="Inter,ui-sans-serif,system-ui" font-size="15" font-weight="750" fill="#0f172a">${xml(taskId)}</text>`);
    y += 31;
    for (const entry of taskEntries) {
      const width = Math.abs(entry.delta) / max * span;
      const x = entry.delta < 0 ? center - width : center;
      body.push(`<text x="70" y="${y + 20}" font-family="Inter,ui-sans-serif,system-ui" font-size="13" font-weight="600" fill="#475569">${xml(LABELS[entry.condition])}</text>
<line x1="${center}" y1="${y - 4}" x2="${center}" y2="${y + 31}" stroke="#64748b"/>
<rect data-task="${xml(taskId)}" data-condition="${entry.condition}" data-delta="${entry.delta}" data-pairs="${entry.pairs}" x="${x.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="27" rx="3" fill="${COLORS[entry.condition]}"/>
<circle cx="${center}" cy="${y + 13.5}" r="${width < 1 ? 4 : 0}" fill="${COLORS[entry.condition]}"/>
<text x="${entry.delta < 0 ? x - 8 : x + width + 8}" y="${y + 19}" text-anchor="${entry.delta < 0 ? "end" : "start"}" font-family="Inter,ui-sans-serif,system-ui" font-size="13" font-weight="700" fill="#0f172a">${xml(format(entry.delta))}</text>
<text x="1018" y="${y + 19}" text-anchor="end" font-family="Inter,ui-sans-serif,system-ui" font-size="12" fill="#64748b">${entry.pairs} pair${entry.pairs === 1 ? "" : "s"}</text>`);
      y += 37;
    }
    y += 14;
  }
  return svgFrame(title, subtitle, body.join("\n"), Math.max(470, y + CONDITION_LEGEND_SPACE));
}

export function renderGraphics(summary: BenchmarkSummary): Record<string, string> {
  return renderPublicationGraphics(summary);
}

function tokenValue(value: number | null): string {
  return value === null ? "N/A" : Math.round(value).toLocaleString();
}

function usageProvenance(run: RunResult): string {
  const fields = run.tokens.provenance.fields;
  const event = `${run.tokens.provenance.eventType} line${run.tokens.provenance.eventLines.length === 1 ? "" : "s"} ${run.tokens.provenance.eventLines.join(",") || "N/A"}`;
  const raw = run.tokens.provenance.rawEventFile ?? "events.jsonl";
  return `${event}; totalInput=${fields.input ?? "N/A"}; uncachedInput=${fields.uncachedInput ?? "N/A"}; cachedInput=${fields.cachedInput ?? "N/A"}; output=${fields.output ?? "N/A"}; reasoning=${fields.reasoning ?? "N/A"}; total=${fields.total ?? "N/A"}; raw=${raw}`;
}

function markdown(summary: BenchmarkSummary): string {
  const table = summary.conditions.map((item) => {
    const nav = navigationOf(item);
    return `| ${LABELS[item.condition]} | ${item.successes}/${item.samples} (${(item.successRate * 100).toFixed(1)}%) | ${(item.hiddenScoreMean * 100).toFixed(1)}% | ${(item.durationMeanMs / 1000).toFixed(1)}s | ${tokenValue(item.tokensMean.input)} | ${tokenValue(item.tokensMean.uncachedInput)} | ${tokenValue(item.tokensMean.cachedInput)} | ${tokenValue(item.tokensMean.output)} | ${tokenValue(item.tokensMean.reasoning)} | ${tokenValue(item.tokensMean.total)} | ${item.costMeanUsd === null ? "N/A" : `$${item.costMeanUsd.toFixed(4)}`} | ${item.accuracyPer100kTokensMean === null ? "N/A" : item.accuracyPer100kTokensMean.toFixed(3)} | ${nav.outlineAccessCommandCount}/${nav.sourceAccessCommandCount}/${nav.mixedAccessCommandCount} | ${nav.duplicateSourceReadLines} | ${nav.failedNavigationCommandCount} | ${item.pairedVsRaw.wins}/${item.pairedVsRaw.losses}/${item.pairedVsRaw.ties} |`;
  }).join("\n");
  const taskTable = taskBreakdown(summary).map((item) => `| ${item.taskId} | ${LABELS[item.condition]} | ${item.successes}/${item.samples} (${(item.successRate * 100).toFixed(1)}%) | ${(item.hiddenScoreMean * 100).toFixed(1)}% | ${(item.durationMeanMs / 1000).toFixed(1)}s | ${tokenValue(item.tokensMean)} | ${item.costMeanUsd === null ? "N/A" : `$${item.costMeanUsd.toFixed(4)}`} | ${item.commandsMean.toFixed(2)} | ${item.filesMean.toFixed(2)} | ${item.failedChecks} |`).join("\n");
  const rawRuns = summary.runs.map((run) => `| ${run.taskId} | ${LABELS[run.condition]} | ${run.run} | ${run.status} | ${(run.hiddenGrader.score / Math.max(1, run.hiddenGrader.maxScore) * 100).toFixed(1)}% | ${(run.durationMs / 1000).toFixed(1)}s | ${tokenValue(run.tokens.input)} | ${tokenValue(run.tokens.uncachedInput)} | ${tokenValue(run.tokens.cachedInput)} | ${tokenValue(run.tokens.output)} | ${tokenValue(run.tokens.reasoning)} | ${tokenValue(run.tokens.total)} | ${usageProvenance(run)} | ${run.baselineTreeHash.slice(0, 12)} | ${run.promptSha256.slice(0, 12)} |`).join("\n");
  const evaluatorTable = evaluatorMetricRows(summary).map((item) => `| ${item.taskId} | ${LABELS[item.condition]} | ${item.metrics} |`).join("\n");
  const images = Object.keys(renderGraphics(summary)).map((file) => `![${file.replace(".svg", "").replaceAll("-", " ")}](graphics/${file})`).join("\n\n");
  const warnings = (summary.warnings ?? []).length ? `\n\n## Warnings\n\n${summary.warnings!.map((item) => `- ${item}`).join("\n")}` : "";
  return `# project-outline benchmark report\n\nGenerated ${summary.generatedAt}. ${summary.totalRuns} runs across ${summary.tasks.length} task(s). Every task-condition cell uses exactly three fresh runs, and every aggregate shown below is an arithmetic mean. Hidden behavioral tests measure correctness; efficiency and navigation timing are reported separately. Cost is a token-price model, not an observed bill.${warnings}\n\n## Condition key\n\nRegular code is the repository without generated project-outline aids. The targeted default compares regular code with each generated artifact in isolation and with Full MapBench (all three artifacts). The architecture map is one system-level index; the skeleton is a mirrored source tree of declarations and signatures without implementation bodies; the call graph contains symbol relationships plus its query helper. Generated conditions receive the same neutral root AGENTS.md notice naming the available paths so discoverability is held constant; it supplies no navigation strategy.\n\n## Arithmetic mean by condition\n\n| Condition | Success | Hidden score | Duration | Total input | Uncached input | Cached input | Output | Reasoning | Total | Modeled cost | Accuracy/100k | Generated/source/mixed commands | Duplicate lines | Failed nav | W/L/T vs regular code |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\n## Three raw runs per task and condition\n\nThese are the unaggregated values used by the means. Codex \`input_tokens\` includes cached input. Uncached input is the exact difference between reported input and cached input; cached input is not added to total. Total is directly reported when available, otherwise it is the exact sum of reported total input and output.\n\n| Task | Condition | Run | Status | Hidden score | Duration | Total input | Uncached input | Cached input | Output | Reasoning | Total | Token provenance | Tree | Prompt |\n|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|\n${rawRuns}\n\n## Task-by-task arithmetic means\n\n| Task | Condition | Success | Hidden score | Duration | Tokens | Modeled cost | Commands | Files | Failed rubric checks (runs) |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---|\n${taskTable}\n\n## Task-specific evaluator means\n\nPrivate-grader arithmetic means include localization recall, MRR, source-line use, and execution-path node, edge, ordering, validation, and side-effect measurements when applicable.\n\n| Task | Condition | Metrics |\n|---|---|---|\n${evaluatorTable || "| — | — | No task-specific metrics |"}\n\n${images}\n`;
}

function html(summary: BenchmarkSummary, graphics: Record<string, string>): string {
  const cards = Object.entries(graphics).map(([name, content]) => `<section class="graphic" id="${name.replace(".svg", "")}">${content}</section>`).join("\n");
  const rows = summary.conditions.map((item) => { const nav = navigationOf(item); return `<tr><th>${LABELS[item.condition]}</th><td>${item.successes}/${item.samples}</td><td>${(item.hiddenScoreMean * 100).toFixed(1)}%</td><td>${(item.durationMeanMs / 1000).toFixed(1)}s</td><td>${tokenValue(item.tokensMean.input)}</td><td>${tokenValue(item.tokensMean.uncachedInput)}</td><td>${tokenValue(item.tokensMean.cachedInput)}</td><td>${tokenValue(item.tokensMean.output)}</td><td>${tokenValue(item.tokensMean.reasoning)}</td><td>${tokenValue(item.tokensMean.total)}</td><td>${item.costMeanUsd === null ? "N/A" : `$${item.costMeanUsd.toFixed(4)}`}</td><td>${item.accuracyPer100kTokensMean === null ? "N/A" : item.accuracyPer100kTokensMean.toFixed(3)}</td><td>${nav.outlineAccessCommandCount}/${nav.sourceAccessCommandCount}/${nav.mixedAccessCommandCount}</td><td>${nav.duplicateSourceReadLines}</td><td>${nav.failedNavigationCommandCount}</td></tr>`; }).join("");
  const taskRows = taskBreakdown(summary).map((item) => `<tr><th>${xml(item.taskId)}</th><td>${LABELS[item.condition]}</td><td>${item.successes}/${item.samples}</td><td>${(item.hiddenScoreMean * 100).toFixed(1)}%</td><td>${(item.durationMeanMs / 1000).toFixed(1)}s</td><td>${tokenValue(item.tokensMean)}</td><td>${item.costMeanUsd === null ? "N/A" : `$${item.costMeanUsd.toFixed(4)}`}</td><td>${item.commandsMean.toFixed(2)}</td><td>${item.filesMean.toFixed(2)}</td><td>${xml(item.failedChecks)}</td></tr>`).join("");
  const rawRows = summary.runs.map((run) => `<tr><th>${xml(run.taskId)}</th><td>${LABELS[run.condition]}</td><td>${run.run}</td><td>${run.status}</td><td>${(run.hiddenGrader.score / Math.max(1, run.hiddenGrader.maxScore) * 100).toFixed(1)}%</td><td>${(run.durationMs / 1000).toFixed(1)}s</td><td>${tokenValue(run.tokens.input)}</td><td>${tokenValue(run.tokens.uncachedInput)}</td><td>${tokenValue(run.tokens.cachedInput)}</td><td>${tokenValue(run.tokens.output)}</td><td>${tokenValue(run.tokens.reasoning)}</td><td>${tokenValue(run.tokens.total)}</td><td>${xml(usageProvenance(run))}</td><td>${run.baselineTreeHash.slice(0, 12)}</td><td>${run.promptSha256.slice(0, 12)}</td></tr>`).join("");
  const evaluatorRows = evaluatorMetricRows(summary).map((item) => `<tr><th>${xml(item.taskId)}</th><td>${LABELS[item.condition]}</td><td>${xml(item.metrics)}</td></tr>`).join("");
  const warnings = (summary.warnings ?? []).length ? `<section class="warnings"><strong>Warnings</strong><ul>${summary.warnings!.map((item) => `<li>${xml(item)}</li>`).join("")}</ul></section>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>project-outline benchmark</title><style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui;background:#eef3f8;color:#0f172a}body{margin:0}.wrap{max-width:1180px;margin:auto;padding:56px 28px 80px}header{padding:40px;border-radius:22px;background:linear-gradient(135deg,#0f172a,#134e4a);color:white;box-shadow:0 22px 70px #0f172a22}h1{font-size:42px;margin:0 0 10px}h2{font-size:20px;margin:0 0 18px}header p{color:#ccfbf1;margin:0;font-size:17px}.meta{margin-top:22px;font-size:13px;color:#99f6e4}.warnings{margin-top:28px;padding:20px 24px;border:1px solid #f59e0b;background:#fffbeb;border-radius:12px}.table-wrap,.graphic{margin-top:28px;background:white;border:1px solid #dbe4ee;overflow:hidden;box-shadow:0 12px 40px #0f172a0d}.table-wrap{padding:24px;overflow:auto;border-radius:16px}.graphic{border-radius:16px}table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:13px;border-bottom:1px solid #e2e8f0;font-size:14px}th:first-child{text-align:left}thead th{color:#64748b;font-size:12px;text-transform:uppercase}.graphic svg{display:block;width:100%;height:auto}footer{color:#64748b;font-size:13px;margin:30px 4px}</style></head><body><main class="wrap"><header><h1>project-outline benchmark</h1><p>Repository architecture comprehension accuracy, efficiency, and controlled component ablations.</p><div class="meta">${summary.totalRuns} runs · ${summary.tasks.length} tasks · arithmetic means of three fresh runs · generated ${escapeHtml(summary.generatedAt)}</div></header>${warnings}<section class="table-wrap"><h2>Token provenance</h2><p>Token metrics come only from Codex <code>turn.completed.usage</code>. Codex total input includes cached input; uncached input is their exact difference and cached input is never added to total. Missing fields remain N/A. Raw usage events are linked by each run's provenance. Modeled cost is not an observed bill.</p></section><section class="table-wrap"><h2>Arithmetic mean by condition</h2><table><thead><tr><th>Condition</th><th>Success</th><th>Hidden score</th><th>Duration</th><th>Total input</th><th>Uncached</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Modeled cost</th><th>Accuracy/100k</th><th>Generated/source/mixed</th><th>Duplicate lines</th><th>Failed nav</th></tr></thead><tbody>${rows}</tbody></table></section><section class="table-wrap"><h2>Three raw runs per task and condition</h2><table><thead><tr><th>Task</th><th>Condition</th><th>Run</th><th>Status</th><th>Score</th><th>Duration</th><th>Total input</th><th>Uncached</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Provenance</th><th>Tree</th><th>Prompt</th></tr></thead><tbody>${rawRows}</tbody></table></section><section class="table-wrap"><h2>Task-by-task arithmetic means</h2><table><thead><tr><th>Task</th><th>Condition</th><th>Success</th><th>Hidden score</th><th>Duration</th><th>Tokens</th><th>Modeled cost</th><th>Commands</th><th>Files</th><th>Failed rubric checks (runs)</th></tr></thead><tbody>${taskRows}</tbody></table></section><section class="table-wrap"><h2>Task-specific evaluator means</h2><p>Private-grader arithmetic means for localization and execution-path quality.</p><table><thead><tr><th>Task</th><th>Condition</th><th>Metrics</th></tr></thead><tbody>${evaluatorRows || "<tr><th>—</th><td>—</td><td>No task-specific metrics</td></tr>"}</tbody></table></section>${cards}<footer>Self-contained report generated deterministically from persisted run artifacts.</footer></main></body></html>\n`;
}

export async function generateReport(resultsRoot: string, summary: BenchmarkSummary): Promise<void> {
  const graphics = renderGraphics(summary);
  const directory = path.join(resultsRoot, "graphics");
  await fs.mkdir(directory, { recursive: true });
  const staleGraphics = (await fs.readdir(directory))
    .filter((name) => name.endsWith(".svg") && !Object.hasOwn(graphics, name));
  await Promise.all(staleGraphics.map((name) => fs.rm(path.join(directory, name), { force: true })));
  await Promise.all(Object.entries(graphics).map(([name, contents]) => fs.writeFile(path.join(directory, name), contents, "utf8")));
  await Promise.all([
    fs.writeFile(path.join(resultsRoot, "summary.md"), markdown(summary), "utf8"),
    fs.writeFile(path.join(resultsRoot, "report.html"), html(summary, graphics), "utf8"),
  ]);
}
