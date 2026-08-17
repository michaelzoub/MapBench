import type { CommandRecord, EditNavigationCost, Pricing, TokenUsage } from "./types.js";
import { accessedPaths, navigationKind, readRanges } from "./navigation.js";

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export interface RawUsageEvent {
  line: number;
  event: Record<string, unknown>;
}

function authoritativeSum(events: RawUsageEvent[], keys: string[]): { value: number | null; field: string | null } {
  if (!events.length) return { value: null, field: null };
  const values = events.map(({ event }) => {
    const usage = event.usage as Record<string, unknown>;
    for (const key of keys) {
      const value = finiteNumber(usage[key]);
      if (value !== null) return { value, key };
    }
    return null;
  });
  if (values.some((value) => value === null)) return { value: null, field: null };
  const present = values as Array<{ value: number; key: string }>;
  const key = present[0].key;
  if (present.some((value) => value.key !== key)) return { value: null, field: null };
  return { value: present.reduce((sum, value) => sum + value.value, 0), field: `usage.${key}` };
}

function commandFrom(item: Record<string, unknown>): CommandRecord | undefined {
  const payload = (item.item && typeof item.item === "object" ? item.item : item) as Record<string, unknown>;
  const type = String(payload.type ?? item.type ?? "");
  if (!type.includes("command")) return undefined;
  const command = payload.command;
  const text = Array.isArray(command) ? command.map(String).join(" ") : String(command ?? payload.cmd ?? "");
  if (!text) return undefined;
  const status = String(payload.status ?? item.status ?? "unknown");
  const exitCode = typeof payload.exit_code === "number" ? payload.exit_code :
    typeof payload.exitCode === "number" ? payload.exitCode : null;
  const output = typeof payload.aggregated_output === "string" ? payload.aggregated_output :
    typeof payload.output === "string" ? payload.output : "";
  return {
    command: text,
    status,
    exitCode,
    failed: exitCode !== null ? exitCode !== 0 : /fail|error/i.test(status),
    outputBytes: Buffer.byteLength(output),
    navigation: navigationKind(text),
    accessedPaths: accessedPaths(text),
    readRanges: readRanges(text),
  };
}

const SOURCE_CODE_PATH = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)$/i;
const SOURCE_CODE_TOKEN = /(?:\.?\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)/gi;

function sourceEditPaths(event: Record<string, unknown>): string[] {
  const payload = (event.item && typeof event.item === "object" ? event.item : event) as Record<string, unknown>;
  const type = String(payload.type ?? event.type ?? "");
  const paths: string[] = [];
  const changes = payload.changes;
  if (/file.*change|change.*file/i.test(type) && Array.isArray(changes)) {
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const item = change as Record<string, unknown>;
      const candidate = item.path ?? item.file ?? item.file_path;
      if (typeof candidate === "string") paths.push(candidate);
    }
  }
  const command = Array.isArray(payload.command)
    ? payload.command.map(String).join(" ")
    : String(payload.command ?? payload.cmd ?? "");
  const mutates = /\bapply_patch\b|\bpatch\s+-p\d|\b(?:sed|perl)\b[^\n]*(?:\s-i\b|--in-place)|(?:^|[;&|]\s*)tee\s|(?:^|[^<])>{1,2}\s*[^&]/i.test(command);
  if (mutates) paths.push(...accessedPaths(command), ...(command.match(SOURCE_CODE_TOKEN) ?? []));
  return [...new Set(paths.map((value) => value.replace(/^\.\//, "")))]
    .filter((value) => !value.startsWith(".project-outline/") && !value.includes("/.project-outline/") && SOURCE_CODE_PATH.test(value));
}

export function parseCodexEvents(contents: string, stdoutLineElapsedMs: number[] = []): {
  tokens: TokenUsage;
  usageEvents: RawUsageEvent[];
  commands: CommandRecord[];
  editNavigation: Omit<EditNavigationCost, "censoredAtMs">;
  errors: string[];
} {
  const commands: CommandRecord[] = [];
  const errors: string[] = [];
  const usageEvents: RawUsageEvent[] = [];
  let firstSourceEditLine: number | null = null;
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { errors.push(`Invalid JSONL: ${line.slice(0, 120)}`); continue; }
    const type = String(event.type ?? "");
    if (type === "turn.completed" && event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)) {
      usageEvents.push({ line: index + 1, event });
    }
    if (type === "item.completed" || (!type.includes("started") && !type.includes("delta"))) {
      const command = commandFrom(event);
      if (command) commands.push(command);
      if (firstSourceEditLine === null && sourceEditPaths(event).length > 0) firstSourceEditLine = index + 1;
    }
    if (type.includes("error")) errors.push(String(event.message ?? event.error ?? type));
  }
  const input = authoritativeSum(usageEvents, ["input_tokens", "input"]);
  const cachedInput = authoritativeSum(usageEvents, ["cached_input_tokens", "cached_input"]);
  const uncachedInput = input.value !== null && cachedInput.value !== null && cachedInput.value <= input.value
    ? input.value - cachedInput.value
    : null;
  const output = authoritativeSum(usageEvents, ["output_tokens", "output"]);
  const reasoning = authoritativeSum(usageEvents, ["reasoning_output_tokens", "reasoning_tokens"]);
  const reportedTotal = authoritativeSum(usageEvents, ["total_tokens", "total"]);
  const derivedTotal = reportedTotal.value === null && input.value !== null && output.value !== null
    ? input.value + output.value
    : null;
  const tokens: TokenUsage = {
    input: input.value,
    uncachedInput,
    cachedInput: cachedInput.value,
    output: output.value,
    reasoning: reasoning.value,
    total: reportedTotal.value ?? derivedTotal,
    provenance: {
      source: "codex-jsonl",
      eventType: "turn.completed",
      eventLines: usageEvents.map(({ line }) => line),
      rawEventFile: null,
      fields: {
        input: input.field,
        uncachedInput: uncachedInput === null ? null : "derived: usage.input_tokens - usage.cached_input_tokens",
        cachedInput: cachedInput.field,
        output: output.field,
        reasoning: reasoning.field,
        total: reportedTotal.field ?? (derivedTotal === null ? null : "derived: usage.input_tokens + usage.output_tokens"),
      },
    },
  };
  return {
    tokens,
    usageEvents,
    commands,
    editNavigation: {
      firstSourceEditObserved: firstSourceEditLine !== null,
      elapsedMs: firstSourceEditLine === null ? null : stdoutLineElapsedMs[firstSourceEditLine - 1] ?? null,
      eventLine: firstSourceEditLine,
    },
    errors,
  };
}

export function estimateCost(tokens: TokenUsage, pricing: Pricing | undefined): number | null {
  if (!pricing || tokens.uncachedInput === null || tokens.cachedInput === null || tokens.output === null || tokens.reasoning === null) return null;
  const outputWithoutReasoning = Math.max(0, tokens.output - tokens.reasoning);
  return (
    tokens.uncachedInput * pricing.inputPerMillion +
    tokens.cachedInput * pricing.cachedInputPerMillion +
    outputWithoutReasoning * pricing.outputPerMillion +
    tokens.reasoning * (pricing.reasoningPerMillion ?? pricing.outputPerMillion)
  ) / 1_000_000;
}
