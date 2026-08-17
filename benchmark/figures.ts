import type { BenchmarkSummary, Condition, RunResult, SummaryCondition } from "./types.js";
import { CONDITION_FACTORS } from "./types.js";
import { escapeHtml, mean } from "./util.js";

const COLORS: Record<Condition, string> = {
  "regular-code": "#64748b",
  "outline-only": "#2563a6",
  "skeleton-only": "#d97706",
  "callgraph-only": "#7c3aed",
  "outline-skeleton": "#0891b2",
  "outline-callgraph": "#0f9f72",
  "skeleton-callgraph": "#a16207",
  "all-outline-aids": "#0f766e",
};

const LABELS: Record<Condition, string> = {
  "regular-code": "Baseline",
  "outline-only": "Architecture map",
  "skeleton-only": "Skeleton",
  "callgraph-only": "Call graph",
  "outline-skeleton": "Map + skeleton",
  "outline-callgraph": "Map + call graph",
  "skeleton-callgraph": "Skeleton + call graph",
  "all-outline-aids": "Full MapBench",
};

const FONT = "Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
const INK = "#172033";
const TRACK = "#e2e8f0";
const TOKEN_PARTS = [
  { key: "uncached", label: "Uncached input", color: "#147d75" },
  { key: "cached", label: "Cached input", color: "#5eead4" },
  { key: "visible", label: "Visible output", color: "#7c3aed" },
  { key: "reasoning", label: "Reasoning", color: "#f59e0b" },
] as const;

function xml(value: unknown): string {
  return escapeHtml(String(value));
}

function frame(title: string, body: string, height: number, description = title): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${xml(title)}</title><desc id="desc">${xml(description)}</desc>
<rect x=".5" y=".5" width="1079" height="${height - 1}" rx="22" fill="#f8fafc" stroke="#dbe4ee"/>
<text x="48" y="57" font-family="${FONT}" font-size="26" font-weight="750" fill="${INK}">${xml(title)}</text>
${body}
</svg>\n`;
}

function conditionCode(condition: Condition): string {
  if (condition === "regular-code") return "Base";
  if (condition === "all-outline-aids") return "Full";
  const factors = CONDITION_FACTORS[condition];
  return (["outline", "skeleton", "callgraph"] as const)
    .filter((factor) => factors[factor])
    .map((factor) => ({ outline: "M", skeleton: "S", callgraph: "G" })[factor])
    .join("+");
}

function axisTicks(left: number, right: number, top: number, bottom: number): string {
  return [0, .25, .5, .75, 1].map((tick) => {
    const x = left + tick * (right - left);
    return `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="#e4e9ef"/><text x="${x}" y="${bottom + 25}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#647184">${Math.round(tick * 100)}%</text>`;
  }).join("\n");
}

function mainPerformance(summary: BenchmarkSummary): string {
  const rows = summary.conditions;
  const left = 292;
  const right = 930;
  const top = 105;
  const bottom = top + Math.max(1, rows.length - 1) * 47 + 20;
  const height = Math.max(350, bottom + 72);
  const marks = rows.map((entry, index) => {
    const y = top + index * 47;
    const x = left + entry.successRate * (right - left);
    return `<text x="${left - 18}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="600" fill="#273448">${xml(LABELS[entry.condition])}</text>
<circle data-condition="${entry.condition}" data-successes="${entry.successes}" data-samples="${entry.samples}" data-rate="${entry.successRate}" cx="${x.toFixed(2)}" cy="${y}" r="7" fill="${COLORS[entry.condition]}" stroke="#fff" stroke-width="2"/>
<text x="${right + 20}" y="${y + 4}" font-family="${FONT}" font-size="12" font-weight="600" fill="#273448">${(entry.successRate * 100).toFixed(1)}%</text><text x="1018" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="11" fill="#647184">${entry.successes}/${entry.samples}</text>`;
  }).join("\n");
  return frame("Pass rate by condition", `${axisTicks(left, right, top - 22, bottom)}\n${marks}<text x="${(left + right) / 2}" y="${bottom + 51}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#445166">Pass rate</text>`, height, "Observed mean pass rate by condition.");
}

function heatmap(summary: BenchmarkSummary): string {
  const conditions = summary.conditions.map((entry) => entry.condition);
  const left = 304;
  const top = 105;
  const usable = 718;
  const cellWidth = usable / Math.max(1, conditions.length);
  const rowHeight = 43;
  const height = Math.max(350, top + summary.tasks.length * rowHeight + 100);
  const headers = conditions.map((condition, index) => `<text x="${left + (index + .5) * cellWidth}" y="${top - 18}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="700" fill="#445166">${xml(conditionCode(condition))}</text>`).join("\n");
  const rows = summary.tasks.map((task, row) => {
    const y = top + row * rowHeight;
    const cells = conditions.map((condition, col) => {
      const runs = summary.runs.filter((run) => run.taskId === task && run.condition === condition);
      const successes = runs.filter((run) => run.hiddenGrader.passed).length;
      const rate = runs.length ? successes / runs.length : null;
      const lightness = rate === null ? 94 : 96 - rate * 58;
      const fill = rate === null ? "#eef1f4" : `hsl(171 55% ${lightness.toFixed(1)}%)`;
      const textColor = rate !== null && rate >= .58 ? "#fff" : "#17453f";
      return `<rect data-task="${xml(task)}" data-condition="${condition}" data-successes="${successes}" data-samples="${runs.length}" x="${(left + col * cellWidth + 2).toFixed(2)}" y="${y}" width="${Math.max(12, cellWidth - 4).toFixed(2)}" height="35" rx="4" fill="${fill}"/><text x="${(left + (col + .5) * cellWidth).toFixed(2)}" y="${y + 23}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="700" fill="${textColor}">${rate === null ? "—" : `${successes}/${runs.length}`}</text>`;
    }).join("\n");
    return `<text x="${left - 16}" y="${y + 23}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#273448">${xml(task)}</text>${cells}`;
  }).join("\n");
  const legendY = top + summary.tasks.length * rowHeight + 28;
  const legend = conditions.map((condition, index) => `<circle cx="${304 + (index % 4) * 180}" cy="${legendY + Math.floor(index / 4) * 22}" r="5" fill="${COLORS[condition]}"/><text x="${315 + (index % 4) * 180}" y="${legendY + 4 + Math.floor(index / 4) * 22}" font-family="${FONT}" font-size="10.5" fill="#526074">${xml(conditionCode(condition))} = ${xml(LABELS[condition])}</text>`).join("\n");
  return frame("Task × condition pass rate", `${headers}\n${rows}\n${legend}`, height, "Passes per repetition for each task and condition.");
}

interface FrontierPoint { condition: Condition; successRate: number; cost: number }

function pareto(points: FrontierPoint[]): FrontierPoint[] {
  return points.filter((candidate) => !points.some((other) => other !== candidate && other.cost <= candidate.cost && other.successRate >= candidate.successRate && (other.cost < candidate.cost || other.successRate > candidate.successRate)));
}

function extent(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [Math.max(0, min * .9), max === 0 ? 1 : max * 1.1];
  const pad = (max - min) * .12;
  return [Math.max(0, min - pad), max + pad];
}

function frontierChart(title: string, summary: BenchmarkSummary, metric: (entry: SummaryCondition) => number | null, formatter: (value: number) => string, axisLabel: string): string {
  const points = summary.conditions.flatMap((entry) => {
    const cost = metric(entry);
    return cost === null ? [] : [{ condition: entry.condition, successRate: entry.successRate, cost }];
  });
  const left = 110;
  const right = 1018;
  const top = 92;
  const bottom = 405;
  const height = 485;
  if (!points.length) return frame(title, `<text x="540" y="250" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#8090a2">No reported values</text>`, height);
  const [domainMin, domainMax] = extent(points.map((point) => point.cost));
  const scaleX = (value: number): number => left + (value - domainMin) / Math.max(1e-9, domainMax - domainMin) * (right - left);
  const scaleY = (value: number): number => bottom - value * (bottom - top);
  const xTicks = [0, .25, .5, .75, 1].map((tick) => domainMin + tick * (domainMax - domainMin));
  const grid = `${[0, .25, .5, .75, 1].map((tick) => `<line x1="${left}" y1="${scaleY(tick)}" x2="${right}" y2="${scaleY(tick)}" stroke="#e4e9ef"/><text x="${left - 10}" y="${scaleY(tick) + 4}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#647184">${Math.round(tick * 100)}%</text>`).join("\n")}
${xTicks.map((tick) => `<line x1="${scaleX(tick)}" y1="${top}" x2="${scaleX(tick)}" y2="${bottom}" stroke="#eef1f4"/><text x="${scaleX(tick)}" y="${bottom + 22}" text-anchor="middle" font-family="${FONT}" font-size="10.5" fill="#647184">${xml(formatter(tick))}</text>`).join("\n")}`;
  const efficient = pareto(points).sort((a, b) => a.cost - b.cost);
  const frontier = efficient.length > 1 ? `<polyline points="${efficient.map((point) => `${scaleX(point.cost).toFixed(2)},${scaleY(point.successRate).toFixed(2)}`).join(" ")}" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="5 4"/>` : "";
  const marks = points.map((point, index) => {
    const cx = scaleX(point.cost);
    const cy = scaleY(point.successRate);
    const dx = index % 2 ? -10 : 10;
    return `<circle data-condition="${point.condition}" data-cost="${point.cost}" data-pass-rate="${point.successRate}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="6" fill="${COLORS[point.condition]}" stroke="#fff" stroke-width="1.5"/><text x="${(cx + dx).toFixed(2)}" y="${(cy - 9).toFixed(2)}" text-anchor="${dx < 0 ? "end" : "start"}" font-family="${FONT}" font-size="10.5" font-weight="700" fill="#344156">${xml(conditionCode(point.condition))}</text>`;
  }).join("\n");
  return frame(title, `${grid}\n${frontier}\n${marks}<text x="${(left + right) / 2}" y="${bottom + 52}" text-anchor="middle" font-family="${FONT}" font-size="11.5" font-weight="600" fill="#445166">${xml(axisLabel)}</text>`, height, `${title} against observed pass rate; dashed lines connect non-dominated conditions.`);
}

interface EditCostPoint { run: RunResult; elapsedMs: number; observed: boolean }

function editCost(run: RunResult): EditCostPoint | null {
  if (run.editNavigation) {
    const elapsedMs = run.editNavigation.firstSourceEditObserved ? run.editNavigation.elapsedMs : run.editNavigation.censoredAtMs;
    return elapsedMs === null ? null : { run, elapsedMs, observed: run.editNavigation.firstSourceEditObserved };
  }
  return run.filesChanged.length === 0 ? { run, elapsedMs: run.durationMs, observed: false } : null;
}

function navigationCost(summary: BenchmarkSummary): string {
  const conditions = summary.conditions.map((entry) => entry.condition);
  const byCondition = new Map(conditions.map((condition) => [condition, summary.runs.filter((run) => run.condition === condition).flatMap((run) => { const value = editCost(run); return value ? [value] : []; })]));
  const points = [...byCondition.values()].flat();
  const top = 105;
  const left = 292;
  const right = 930;
  const bottom = top + Math.max(1, conditions.length - 1) * 47 + 20;
  const height = Math.max(350, bottom + 95);
  if (!points.length) return frame("Navigation cost before the first source edit", `<text x="540" y="220" text-anchor="middle" font-family="${FONT}" font-size="15" fill="#8090a2">No timed source-edit events are available.</text>`, height);
  const maxSeconds = Math.max(...points.map((point) => point.elapsedMs / 1000), 1) * 1.08;
  const scaleX = (seconds: number): number => left + seconds / maxSeconds * (right - left);
  const ticks = [0, .25, .5, .75, 1].map((fraction) => fraction * maxSeconds);
  const grid = ticks.map((tick) => `<line x1="${scaleX(tick)}" y1="${top - 22}" x2="${scaleX(tick)}" y2="${bottom}" stroke="#e4e9ef"/><text x="${scaleX(tick)}" y="${bottom + 25}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#647184">${tick.toFixed(0)}</text>`).join("\n");
  const rows = conditions.map((condition, row) => {
    const values = byCondition.get(condition) ?? [];
    const y = top + row * 47;
    const observed = values.filter((point) => point.observed);
    const sorted = observed.map((point) => point.elapsedMs / 1000).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const marks = values.map((point, index) => {
      const cx = scaleX(point.elapsedMs / 1000);
      const cy = y + [-8, 0, 8][index % 3];
      return point.observed ? `<circle data-condition="${condition}" data-run="${point.run.run}" data-observed="true" data-elapsed-ms="${point.elapsedMs}" cx="${cx.toFixed(2)}" cy="${cy}" r="5.5" fill="${COLORS[condition]}" stroke="#fff" stroke-width="1.5"/>` : `<path data-condition="${condition}" data-run="${point.run.run}" data-observed="false" data-elapsed-ms="${point.elapsedMs}" d="M ${cx.toFixed(2)} ${cy - 6} L ${(cx + 6).toFixed(2)} ${cy + 5} L ${(cx - 6).toFixed(2)} ${cy + 5} Z" fill="#fff" stroke="${COLORS[condition]}" stroke-width="2"/>`;
    }).join("\n");
    return `<text x="${left - 18}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="600" fill="#273448">${xml(LABELS[condition])}</text><line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#edf0f4"/>${median === null ? "" : `<line x1="${scaleX(median)}" y1="${y - 13}" x2="${scaleX(median)}" y2="${y + 13}" stroke="#172033" stroke-width="2"/>`}${marks}<text x="1018" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#647184">${observed.length} edit · ${values.length - observed.length} censored</text>`;
  }).join("\n");
  const legendY = bottom + 57;
  const legend = `<circle cx="${left}" cy="${legendY}" r="5.5" fill="#0f766e"/><text x="${left + 12}" y="${legendY + 4}" font-family="${FONT}" font-size="11" fill="#526074">first source edit</text><path d="M ${left + 155} ${legendY - 6} L ${left + 161} ${legendY + 5} L ${left + 149} ${legendY + 5} Z" fill="#fff" stroke="#0f766e" stroke-width="2"/><text x="${left + 170}" y="${legendY + 4}" font-family="${FONT}" font-size="11" fill="#526074">no edit by run end</text>`;
  return frame("Navigation cost before the first source edit", `${grid}\n${rows}<text x="${(left + right) / 2}" y="${bottom + 49}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#445166">Time from run start (seconds)</text>${legend}`, height, "Distribution of elapsed time to first source edit; triangles mark no-edit runs.");
}

function pairedPassDeltas(summary: BenchmarkSummary, taskId: string): number[] {
  const baseline = new Map(summary.runs
    .filter((run) => run.taskId === taskId && run.condition === "regular-code")
    .map((run) => [run.pairId, run]));
  return summary.runs
    .filter((run) => run.taskId === taskId && run.condition === "all-outline-aids")
    .flatMap((run) => {
      const raw = baseline.get(run.pairId);
      return raw ? [Number(run.hiddenGrader.passed) - Number(raw.hiddenGrader.passed)] : [];
    });
}

function treatmentEffect(summary: BenchmarkSummary): string {
  const left = 300;
  const right = 930;
  const center = (left + right) / 2;
  const top = 105;
  const rowHeight = 48;
  const bottom = top + Math.max(1, summary.tasks.length - 1) * rowHeight + 20;
  const height = Math.max(350, bottom + 72);
  const scaleX = (value: number): number => left + (value + 1) / 2 * (right - left);
  const grid = [-1, -.5, 0, .5, 1].map((tick) => `<line x1="${scaleX(tick)}" y1="${top - 25}" x2="${scaleX(tick)}" y2="${bottom}" stroke="${tick === 0 ? "#8793a3" : "#e4e9ef"}" stroke-width="${tick === 0 ? 1.5 : 1}"/><text x="${scaleX(tick)}" y="${bottom + 25}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#647184">${tick > 0 ? "+" : ""}${Math.round(tick * 100)}</text>`).join("\n");
  const rows = summary.tasks.map((task, row) => {
    const deltas = pairedPassDeltas(summary, task);
    const y = top + row * rowHeight;
    if (!deltas.length) return `<text x="${left - 18}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#273448">${xml(task)}</text><text x="${center}" y="${y + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#8793a3">N/A</text><text x="1018" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#8793a3">no matched Full pairs</text>`;
    const delta = mean(deltas);
    const positive = deltas.filter((value) => value > 0).length;
    const negative = deltas.filter((value) => value < 0).length;
    const ties = deltas.length - positive - negative;
    const color = delta > 0 ? "#0f8a62" : delta < 0 ? "#c2414b" : "#64748b";
    const pairMarks = deltas.map((value, index) => `<circle cx="${scaleX(value)}" cy="${y + [-8, 0, 8][index % 3]}" r="3.5" fill="${color}" opacity=".35"/>`).join("");
    const labelOnLeft = delta > .72 || (delta < 0 && delta >= -.72);
    const labelX = scaleX(delta) + (labelOnLeft ? -13 : 13);
    return `<text x="${left - 18}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#273448">${xml(task)}</text><line x1="${center}" y1="${y}" x2="${scaleX(delta)}" y2="${y}" stroke="${color}" stroke-width="3"/>${pairMarks}<circle data-task="${xml(task)}" data-condition="all-outline-aids" data-delta="${delta}" data-pairs="${deltas.length}" cx="${scaleX(delta)}" cy="${y}" r="7" fill="${color}" stroke="#fff" stroke-width="2"/><text x="${labelX}" y="${y + 4}" text-anchor="${labelOnLeft ? "end" : "start"}" font-family="${FONT}" font-size="11" font-weight="700" fill="#273448">${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}</text><text x="1018" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#647184">${positive}↑ ${ties}– ${negative}↓ · n=${deltas.length}</text>`;
  }).join("\n");
  return frame("Per-task Full MapBench treatment effect", `${grid}\n${rows}<text x="${(left + right) / 2}" y="${bottom + 51}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#445166">Paired pass-rate effect (percentage points)</text>`, height, "Paired pass-rate difference between Full MapBench and Baseline.");
}

interface TokenBreakdown {
  uncached: number;
  cached: number;
  visible: number;
  reasoning: number;
  total: number;
}

function runTokenBreakdown(run: RunResult): TokenBreakdown | null {
  const { input, cachedInput, output, total } = run.tokens;
  if (input === null || cachedInput === null || output === null || total === null) return null;
  const reasoning = run.tokens.reasoning ?? 0;
  return {
    uncached: run.tokens.uncachedInput ?? Math.max(0, input - cachedInput),
    cached: cachedInput,
    visible: Math.max(0, output - reasoning),
    reasoning,
    total,
  };
}

function medianTokenBreakdown(runs: RunResult[]): TokenBreakdown | null {
  const values = runs.flatMap((run) => {
    const breakdown = runTokenBreakdown(run);
    return breakdown ? [breakdown] : [];
  }).sort((left, right) => left.total - right.total);
  if (!values.length) return null;
  const upper = values[Math.floor(values.length / 2)];
  if (values.length % 2) return upper;
  const lower = values[values.length / 2 - 1];
  return {
    uncached: (lower.uncached + upper.uncached) / 2,
    cached: (lower.cached + upper.cached) / 2,
    visible: (lower.visible + upper.visible) / 2,
    reasoning: (lower.reasoning + upper.reasoning) / 2,
    total: (lower.total + upper.total) / 2,
  };
}

function tokenBreakdown(summary: BenchmarkSummary): string {
  const rows = summary.conditions.map((entry) => ({
    condition: entry.condition,
    breakdown: medianTokenBreakdown(summary.runs.filter((run) => run.condition === entry.condition)),
  }));
  const max = Math.max(...rows.flatMap((row) => row.breakdown ? [row.breakdown.total] : []), 1);
  const left = 190;
  const right = 890;
  const valueX = 910;
  const top = 96;
  const rowHeight = 54;
  const barHeight = 28;
  const legendY = top + rows.length * rowHeight + 4;
  const height = legendY + 54;
  const body = rows.map((row, index) => {
    const y = top + index * rowHeight;
    const clipId = `median-token-row-${index}`;
    let x = left;
    const segments = row.breakdown ? TOKEN_PARTS.map((part) => {
      const amount = row.breakdown![part.key];
      const width = amount / max * (right - left);
      const segment = `<rect data-token-part="${part.key}" data-value="${amount}" x="${x.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="${barHeight}" fill="${part.color}"/>`;
      x += width;
      return segment;
    }).join("\n") : "";
    return `<g data-condition="${row.condition}" data-median-total="${row.breakdown?.total ?? ""}">
<text x="48" y="${y + 20}" font-family="${FONT}" font-size="14" font-weight="650" fill="#334155">${xml(LABELS[row.condition])}</text>
<defs><clipPath id="${clipId}"><rect x="${left}" y="${y}" width="${right - left}" height="${barHeight}" rx="6"/></clipPath></defs>
<rect x="${left}" y="${y}" width="${right - left}" height="${barHeight}" rx="6" fill="${TRACK}"/>
<g clip-path="url(#${clipId})">${segments}</g>
<text x="${valueX}" y="${y + 20}" font-family="${FONT}" font-size="13" fill="#42526a">${row.breakdown ? Math.round(row.breakdown.total).toLocaleString("en-US") : "N/A"}</text>
</g>`;
  }).join("\n");
  const legend = TOKEN_PARTS.map((part, index) => {
    const x = 48 + index * 180;
    return `<rect x="${x}" y="${legendY}" width="12" height="12" rx="2" fill="${part.color}"/><text x="${x + 18}" y="${legendY + 11}" font-family="${FONT}" font-size="12" fill="#526681">${part.label}</text>`;
  }).join("\n");
  return frame(
    "Median token breakdown",
    `${body}\n${legend}`,
    height,
    "Breakdown of the median-total-token run by condition. Cached input is part of input; reasoning is separated from visible output when reported.",
  );
}

export function renderPublicationGraphics(summary: BenchmarkSummary): Record<string, string> {
  return {
    "figure-1-main-performance.svg": mainPerformance(summary),
    "figure-2-task-condition-heatmap.svg": heatmap(summary),
    "figure-3a-mean-total-tokens.svg": frontierChart(
      "Mean total tokens",
      summary,
      (entry) => entry.tokensMean.total,
      (value) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value),
      "Mean total tokens",
    ),
    "figure-3b-mean-runtime.svg": frontierChart(
      "Mean runtime (seconds)",
      summary,
      (entry) => entry.durationMeanMs / 1000,
      (value) => value.toFixed(1),
      "Mean runtime (seconds)",
    ),
    "figure-4-navigation-cost.svg": navigationCost(summary),
    "figure-5-per-task-treatment-effect.svg": treatmentEffect(summary),
    "figure-6-median-token-breakdown.svg": tokenBreakdown(summary),
  };
}
