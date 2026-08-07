import type { CommandRecord, Pricing, TokenUsage } from "./types.js";
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

export function parseCodexEvents(contents: string): {
  tokens: TokenUsage;
  usageEvents: RawUsageEvent[];
  commands: CommandRecord[];
  errors: string[];
} {
  const commands: CommandRecord[] = [];
  const errors: string[] = [];
  const usageEvents: RawUsageEvent[] = [];
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
  return { tokens, usageEvents, commands, errors };
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
