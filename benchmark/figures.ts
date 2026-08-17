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

function xml(value: unknown): string {
  return escapeHtml(String(value));
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

function frame(title: string, subtitle: string, body: string, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${xml(title)}</title><desc id="desc">${xml(subtitle)}</desc>
<rect width="1080" height="${height}" fill="#ffffff"/>
<text x="54" y="48" font-family="${FONT}" font-size="24" font-weight="700" fill="#172033">${xml(title)}</text>
<text x="54" y="74" font-family="${FONT}" font-size="13" fill="#5f6b7a">${xml(subtitle)}</text>
${body}
</svg>\n`;
}

function wilson(successes: number, samples: number): [number, number] {
  if (samples <= 0) return [0, 0];
  const z = 1.959963984540054;
  const p = successes / samples;
  const z2 = z * z;
  const denominator = 1 + z2 / samples;
  const center = (p + z2 / (2 * samples)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * samples)) / samples) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function axisTicks(left: number, right: number, top: number, bottom: number, format = (value: number) => `${Math.round(value * 100)}%`): string {
  return [0, .25, .5, .75, 1].map((tick) => {
    const x = left + tick * (right - left);
    return `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="#e4e9ef" stroke-width="1"/>
<text x="${x}" y="${bottom + 25}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#647184">${xml(format(tick))}</text>`;
  }).join("\n");
}

function mainPerformance(summary: BenchmarkSummary): string {
  const rows = summary.conditions;
  const height = Math.max(390, 150 + rows.length * 47 + 62);
  const left = 292;
  const right = 930;
  const top = 112;
  const bottom = top + Math.max(1, rows.length - 1) * 47 + 20;
  const marks = rows.map((entry, index) => {
    const y = top + index * 47;
    const [low, high] = wilson(entry.successes, entry.samples);
    const x = left + entry.successRate * (right - left);
    const xLow = left + low * (right - left);
    const xHigh = left + high * (right - left);
    return `<text x="${left - 18}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="600" fill="#273448">${xml(LABELS[entry.condition])}</text>
<line x1="${xLow.toFixed(2)}" y1="${y}" x2="${xHigh.toFixed(2)}" y2="${y}" stroke="${COLORS[entry.condition]}" stroke-width="3"/>
<line x1="${xLow.toFixed(2)}" y1="${y - 6}" x2="${xLow.toFixed(2)}" y2="${y + 6}" stroke="${COLORS[entry.condition]}" stroke-width="2"/>
<line x1="${xHigh.toFixed(2)}" y1="${y - 6}" x2="${xHigh.toFixed(2)}" y2="${y + 6}" stroke="${COLORS[entry.condition]}" stroke-width="2"/>
<circle data-condition="${entry.condition}" data-successes="${entry.successes}" data-samples="${entry.samples}" data-rate="${entry.successRate}" data-ci-low="${low}" data-ci-high="${high}" cx="${x.toFixed(2)}" cy="${y}" r="7" fill="${COLORS[entry.condition]}" stroke="#ffffff" stroke-width="2"/>
<text x="${right + 20}" y="${y + 4}" font-family="${FONT}" font-size="12" font-weight="600" fill="#273448">${(entry.successRate * 100).toFixed(1)}%</text>
<text x="1018" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="11" fill="#647184">${entry.successes}/${entry.samples}</text>`;
  }).join("\n");
  const body = `${axisTicks(left, right, top - 22, bottom)}
${marks}
<text x="${(left + right) / 2}" y="${bottom + 51}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#445166">Pass rate</text>`;
  return frame("Figure 1. Pass rate by condition", "Points are observed pass fractions; whiskers are 95% Wilson binomial confidence intervals.", body, height);
}

function heatmap(summary: BenchmarkSummary): string {
  const conditions = summary.conditions.map((entry) => entry.condition);
  const left = 304;
  const top = 132;
  const usable = 718;
  const cellWidth = usable / Math.max(1, conditions.length);
  const rowHeight = 43;
  const height = Math.max(390, top + summary.tasks.length * rowHeight + 104);
  const headers = conditions.map((condition, index) => `<text x="${left + (index + .5) * cellWidth}" y="${top - 18}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="700" fill="#445166">${xml(conditionCode(condition))}</text>`).join("\n");
  const rows = summary.tasks.map((task, row) => {
    const y = top + row * rowHeight;
    const cells = conditions.map((condition, col) => {
      const runs = summary.runs.filter((run) => run.taskId === task && run.condition === condition);
      const successes = runs.filter((run) => run.hiddenGrader.passed).length;
      const rate = runs.length ? successes / runs.length : null;
      const lightness = rate === null ? 94 : 96 - rate * 58;
      const fill = rate === null ? "#eef1f4" : `hsl(171 55% ${lightness.toFixed(1)}%)`;
      const text = rate === null ? "—" : `${successes}/${runs.length}`;
      const textColor = rate !== null && rate >= .58 ? "#ffffff" : "#17453f";
      return `<rect data-task="${xml(task)}" data-condition="${condition}" data-successes="${successes}" data-samples="${runs.length}" x="${(left + col * cellWidth + 2).toFixed(2)}" y="${y}" width="${Math.max(12, cellWidth - 4).toFixed(2)}" height="35" fill="${fill}"/>
<text x="${(left + (col + .5) * cellWidth).toFixed(2)}" y="${y + 23}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="700" fill="${textColor}">${text}</text>`;
    }).join("\n");
    return `<text x="${left - 16}" y="${y + 23}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#273448">${xml(task)}</text>${cells}`;
  }).join("\n");
  const legendY = top + summary.tasks.length * rowHeight + 35;
  const legend = `<text x="54" y="${legendY + 11}" font-family="${FONT}" font-size="11" fill="#647184">Cells show passes / repetitions</text>
${conditions.map((condition, index) => `<circle cx="${304 + (index % 4) * 180}" cy="${legendY + 38 + Math.floor(index / 4) * 22}" r="5" fill="${COLORS[condition]}"/><text x="${315 + (index % 4) * 180}" y="${legendY + 42 + Math.floor(index / 4) * 22}" font-family="${FONT}" font-size="10.5" fill="#526074">${xml(conditionCode(condition))} = ${xml(LABELS[condition])}</text>`).join("\n")}`;
  return frame("Figure 2. Task × condition pass rate", "Each cell is the fraction of actual benchmark repetitions that passed the private grader.", `${headers}\n${rows}\n${legend}`, height);
}

interface FrontierPoint {
  condition: Condition;
  successRate: number;
  successes: number;
  samples: number;
  cost: number;
}

function pareto(points: FrontierPoint[]): FrontierPoint[] {
  return points.filter((candidate) => !points.some((other) => other !== candidate &&
    other.cost <= candidate.cost && other.successRate >= candidate.successRate &&
    (other.cost < candidate.cost || other.successRate > candidate.successRate)));
}

function extent(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [Math.max(0, min * .9), max === 0 ? 1 : max * 1.1];
  const pad = (max - min) * .12;
  return [Math.max(0, min - pad), max + pad];
}

function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function frontierPanel(
  summary: BenchmarkSummary,
  panel: "a" | "b",
  x: number,
  title: string,
  metric: (entry: SummaryCondition) => number | null,
  formatter: (value: number) => string,
): string {
  const points: FrontierPoint[] = summary.conditions.flatMap((entry) => {
    const cost = metric(entry);
    return cost === null ? [] : [{ condition: entry.condition, successRate: entry.successRate, successes: entry.successes, samples: entry.samples, cost }];
  });
  const left = x + 62;
  const right = x + 452;
  const top = 142;
  const bottom = 450;
  if (!points.length) return `<text x="${x}" y="112" font-family="${FONT}" font-size="15" font-weight="700" fill="#273448">(${panel}) ${xml(title)}</text>
<text x="${(left + right) / 2}" y="290" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#8090a2">No reported values</text>`;
  const [domainMin, domainMax] = extent(points.map((point) => point.cost));
  const scaleX = (value: number): number => left + (value - domainMin) / Math.max(1e-9, domainMax - domainMin) * (right - left);
  const scaleY = (value: number): number => bottom - value * (bottom - top);
  const xTicks = [0, .25, .5, .75, 1].map((tick) => domainMin + tick * (domainMax - domainMin));
  const grid = `<text x="${x}" y="112" font-family="${FONT}" font-size="15" font-weight="700" fill="#273448">(${panel}) ${xml(title)}</text>
${[0, .25, .5, .75, 1].map((tick) => `<line x1="${left}" y1="${scaleY(tick)}" x2="${right}" y2="${scaleY(tick)}" stroke="#e4e9ef"/><text x="${left - 10}" y="${scaleY(tick) + 4}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#647184">${Math.round(tick * 100)}%</text>`).join("\n")}
${xTicks.map((tick) => `<line x1="${scaleX(tick)}" y1="${top}" x2="${scaleX(tick)}" y2="${bottom}" stroke="#eef1f4"/><text x="${scaleX(tick)}" y="${bottom + 22}" text-anchor="middle" font-family="${FONT}" font-size="10.5" fill="#647184">${xml(formatter(tick))}</text>`).join("\n")}`;
  const efficient = pareto(points).sort((a, b) => a.cost - b.cost);
  const frontier = efficient.length > 1
    ? `<polyline points="${efficient.map((point) => `${scaleX(point.cost).toFixed(2)},${scaleY(point.successRate).toFixed(2)}`).join(" ")}" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="5 4"/>`
    : "";
  const marks = points.map((point, index) => {
    const [low, high] = wilson(point.successes, point.samples);
    const cx = scaleX(point.cost);
    const cy = scaleY(point.successRate);
    const dx = index % 2 ? -10 : 10;
    const anchor = dx < 0 ? "end" : "start";
    return `<line x1="${cx.toFixed(2)}" y1="${scaleY(low).toFixed(2)}" x2="${cx.toFixed(2)}" y2="${scaleY(high).toFixed(2)}" stroke="${COLORS[point.condition]}" stroke-width="1.5" opacity=".55"/>
<circle data-panel="${panel}" data-condition="${point.condition}" data-cost="${point.cost}" data-pass-rate="${point.successRate}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="6" fill="${COLORS[point.condition]}" stroke="#ffffff" stroke-width="1.5"/>
<text x="${(cx + dx).toFixed(2)}" y="${(cy - 9).toFixed(2)}" text-anchor="${anchor}" font-family="${FONT}" font-size="10.5" font-weight="700" fill="#344156">${xml(conditionCode(point.condition))}</text>`;
  }).join("\n");
  return `${grid}\n${frontier}\n${marks}
<text x="${(left + right) / 2}" y="${bottom + 49}" text-anchor="middle" font-family="${FONT}" font-size="11.5" font-weight="600" fill="#445166">${xml(title)}</text>`;
}

function efficiencyFrontiers(summary: BenchmarkSummary): string {
  const tokenPanel = frontierPanel(summary, "a", 48, "Mean total tokens", (entry) => entry.tokensMean.total, compact);
  const runtimePanel = frontierPanel(summary, "b", 568, "Mean runtime (seconds)", (entry) => entry.durationMeanMs / 1000, (value) => value.toFixed(1));
  const conditions = summary.conditions.map((entry) => entry.condition);
  const legend = conditions.map((condition, index) => `<circle cx="${64 + (index % 4) * 250}" cy="${548 + Math.floor(index / 4) * 24}" r="5" fill="${COLORS[condition]}"/><text x="${76 + (index % 4) * 250}" y="${552 + Math.floor(index / 4) * 24}" font-family="${FONT}" font-size="10.5" fill="#526074">${xml(conditionCode(condition))} = ${xml(LABELS[condition])}</text>`).join("\n");
  return frame("Figure 3. Efficiency frontiers", "Higher pass rate and lower resource use are preferred. Dashed lines connect non-dominated conditions; vertical whiskers are 95% Wilson intervals.", `${tokenPanel}\n${runtimePanel}\n${legend}`, 625);
}

interface EditCostPoint {
  run: RunResult;
  elapsedMs: number;
  observed: boolean;
  legacyCensor: boolean;
}

function editCost(run: RunResult): EditCostPoint | null {
  if (run.editNavigation) {
    const elapsedMs = run.editNavigation.firstSourceEditObserved
      ? run.editNavigation.elapsedMs
      : run.editNavigation.censoredAtMs;
    return elapsedMs === null ? null : { run, elapsedMs, observed: run.editNavigation.firstSourceEditObserved, legacyCensor: false };
  }
  if (run.filesChanged.length === 0) return { run, elapsedMs: run.durationMs, observed: false, legacyCensor: true };
  return null;
}

function navigationCost(summary: BenchmarkSummary): string {
  const conditions = summary.conditions.map((entry) => entry.condition);
  const byCondition = new Map(conditions.map((condition) => [condition, summary.runs
    .filter((run) => run.condition === condition)
    .flatMap((run) => {
      const value = editCost(run);
      return value ? [value] : [];
    })]));
  const points = [...byCondition.values()].flat();
  const height = Math.max(410, 150 + conditions.length * 47 + 74);
  if (!points.length) return frame("Figure 4. Navigation cost before the first source edit", "Exact wall-clock time is recorded from the live Codex event stream; legacy edited runs without timing are omitted.", `<text x="540" y="245" text-anchor="middle" font-family="${FONT}" font-size="15" fill="#8090a2">No timed source-edit events are available.</text>`, height);
  const left = 292;
  const right = 930;
  const top = 118;
  const bottom = top + Math.max(1, conditions.length - 1) * 47 + 20;
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
      if (point.observed) return `<circle data-condition="${condition}" data-run="${point.run.run}" data-observed="true" data-elapsed-ms="${point.elapsedMs}" cx="${cx.toFixed(2)}" cy="${cy}" r="5.5" fill="${COLORS[condition]}" stroke="#ffffff" stroke-width="1.5"/>`;
      return `<path data-condition="${condition}" data-run="${point.run.run}" data-observed="false" data-elapsed-ms="${point.elapsedMs}" d="M ${cx.toFixed(2)} ${cy - 6} L ${(cx + 6).toFixed(2)} ${cy + 5} L ${(cx - 6).toFixed(2)} ${cy + 5} Z" fill="#ffffff" stroke="${COLORS[condition]}" stroke-width="2"/>`;
    }).join("\n");
    return `<text x="${left - 18}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="600" fill="#273448">${xml(LABELS[condition])}</text>
<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#edf0f4"/>
${median === null ? "" : `<line x1="${scaleX(median)}" y1="${y - 13}" x2="${scaleX(median)}" y2="${y + 13}" stroke="#172033" stroke-width="2"/>`}
${marks}
<text x="1018" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#647184">${observed.length} edit · ${values.length - observed.length} censored</text>`;
  }).join("\n");
  const legendY = bottom + 57;
  const legend = `<circle cx="${left}" cy="${legendY}" r="5.5" fill="#0f766e"/><text x="${left + 12}" y="${legendY + 4}" font-family="${FONT}" font-size="11" fill="#526074">first source edit</text>
<path d="M ${left + 155} ${legendY - 6} L ${left + 161} ${legendY + 5} L ${left + 149} ${legendY + 5} Z" fill="#ffffff" stroke="#0f766e" stroke-width="2"/><text x="${left + 170}" y="${legendY + 4}" font-family="${FONT}" font-size="11" fill="#526074">no edit by run end (right-censored)</text>`;
  return frame("Figure 4. Navigation cost before the first source edit", "Distribution of elapsed wall-clock time by condition. Vertical bars mark medians among observed edits; triangles are right-censored runs.", `${grid}\n${rows}
<text x="${(left + right) / 2}" y="${bottom + 49}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#445166">Time from run start (seconds)</text>\n${legend}`, height);
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
  const top = 124;
  const rowHeight = 48;
  const bottom = top + Math.max(1, summary.tasks.length - 1) * rowHeight + 20;
  const height = Math.max(390, bottom + 78);
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
    return `<text x="${left - 18}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#273448">${xml(task)}</text>
<line x1="${center}" y1="${y}" x2="${scaleX(delta)}" y2="${y}" stroke="${color}" stroke-width="3"/>
${pairMarks}<circle data-task="${xml(task)}" data-condition="all-outline-aids" data-delta="${delta}" data-pairs="${deltas.length}" cx="${scaleX(delta)}" cy="${y}" r="7" fill="${color}" stroke="#ffffff" stroke-width="2"/>
<text x="${labelX}" y="${y + 4}" text-anchor="${labelOnLeft ? "end" : "start"}" font-family="${FONT}" font-size="11" font-weight="700" fill="#273448">${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}</text>
<text x="1018" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="#647184">${positive}↑ ${ties}– ${negative}↓ · n=${deltas.length}</text>`;
  }).join("\n");
  return frame("Figure 5. Per-task Full MapBench treatment effect", "Paired pass-rate difference (Full MapBench − Baseline) in percentage points for every task; faint points are matched repetitions.", `${grid}\n${rows}
<text x="${(left + right) / 2}" y="${bottom + 51}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="#445166">Paired pass-rate effect (percentage points)</text>`, height);
}

export function renderPublicationGraphics(summary: BenchmarkSummary): Record<string, string> {
  return {
    "figure-1-main-performance.svg": mainPerformance(summary),
    "figure-2-task-condition-heatmap.svg": heatmap(summary),
    "figure-3-efficiency-frontiers.svg": efficiencyFrontiers(summary),
    "figure-4-navigation-cost.svg": navigationCost(summary),
    "figure-5-per-task-treatment-effect.svg": treatmentEffect(summary),
  };
}
