import type { CommandRecord, EditNavigationCost, Pricing, TokenUsage } from "./types.js";
import { accessedPaths, navigationKind, readRanges } from "./navigation.js";
import { deriveAccessTelemetry, deriveBehavioralTelemetry, type PiTraceEvent } from "./telemetry.js";

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export interface RawUsageEvent {
  line: number;
  event: Record<string, unknown>;
}

function usageFrom(raw: RawUsageEvent): Record<string, unknown> | null {
  const message = raw.event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const usage = (message as Record<string, unknown>).usage;
  return usage && typeof usage === "object" && !Array.isArray(usage) ? usage as Record<string, unknown> : null;
}

function authoritativeSum(events: RawUsageEvent[], keys: string[]): { value: number | null; field: string | null } {
  if (!events.length) return { value: null, field: null };
  const values = events.map((event) => {
    const usage = usageFrom(event);
    if (!usage) return null;
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
  return { value: present.reduce((sum, value) => sum + value.value, 0), field: `message.usage.${key}` };
}

function toolCommand(toolName: string, args: unknown, result: unknown, isError: boolean): CommandRecord {
  const serializedArgs = JSON.stringify(args ?? {});
  const text = `${toolName} ${serializedArgs}`;
  const output = JSON.stringify(result ?? "");
  return {
    command: text,
    status: isError ? "failed" : "completed",
    exitCode: null,
    failed: isError,
    outputBytes: Buffer.byteLength(output),
    navigation: navigationKind(text),
    accessedPaths: accessedPaths(text),
    readRanges: readRanges(text),
  };
}

const SOURCE_CODE_PATH = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)$/i;
const SOURCE_CODE_TOKEN = /(?:\.?\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)/gi;
function sourceEditPaths(toolName: string, args: unknown): string[] {
  const payload = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const paths = toolName === "edit" || toolName === "write"
    ? [payload.path, payload.file, payload.file_path].filter((value): value is string => typeof value === "string")
    : [];
  if (toolName === "bash" && typeof payload.command === "string") {
    const mutates = /\bapply_patch\b|\bpatch\s+-p\d|\b(?:sed|perl)\b[^\n]*(?:\s-i\b|--in-place)|(?:^|[;&|]\s*)tee\s|(?:^|[^<])>{1,2}\s*[^&]/i.test(payload.command);
    if (mutates) paths.push(...accessedPaths(payload.command), ...(payload.command.match(SOURCE_CODE_TOKEN) ?? []));
  }
  return [...new Set(paths.map((value) => value.replace(/^\.\//, "")))]
    .filter((value) => !value.startsWith(".mapbench/") && !value.includes("/.mapbench/") && SOURCE_CODE_PATH.test(value));
}

export function parsePiEvents(contents: string, stdoutLineElapsedMs: number[] = []): {
  tokens: TokenUsage;
  usageEvents: RawUsageEvent[];
  behavioralTelemetry: ReturnType<typeof deriveBehavioralTelemetry>;
  accessTelemetry: ReturnType<typeof deriveAccessTelemetry>;
  commands: CommandRecord[];
  editNavigation: Omit<EditNavigationCost, "censoredAtMs">;
  finalResponse: string;
  errors: string[];
} {
  const commands: CommandRecord[] = [];
  const errors: string[] = [];
  const usageEvents: RawUsageEvent[] = [];
  const traceEvents: PiTraceEvent[] = [];
  const activeTools = new Map<string, { name: string; args: unknown; line: number }>();
  let firstSourceEditLine: number | null = null;
  let finalResponse = "";
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { errors.push(`Invalid JSONL: ${line.slice(0, 120)}`); continue; }
    traceEvents.push({ line: index + 1, event });
    const type = String(event.type ?? "");
    if (type === "message_end" && event.message && typeof event.message === "object" && !Array.isArray(event.message)) {
      const message = event.message as Record<string, unknown>;
      if (message.role === "assistant" && message.usage && typeof message.usage === "object") {
        usageEvents.push({ line: index + 1, event });
        const content = Array.isArray(message.content) ? message.content : [];
        finalResponse = content.flatMap((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text"
          ? [String((item as Record<string, unknown>).text ?? "")] : []).join("");
        if (message.errorMessage) errors.push(String(message.errorMessage));
      }
    }
    if (type === "tool_execution_start") {
      activeTools.set(String(event.toolCallId ?? ""), { name: String(event.toolName ?? "unknown"), args: event.args, line: index + 1 });
    }
    if (type === "tool_execution_end") {
      const started = activeTools.get(String(event.toolCallId ?? ""));
      const name = String(event.toolName ?? started?.name ?? "unknown");
      const args = started?.args ?? {};
      const failed = event.isError === true;
      commands.push(toolCommand(name, args, event.result, failed));
      if (firstSourceEditLine === null && sourceEditPaths(name, args).length > 0) firstSourceEditLine = index + 1;
    }
    if (type.includes("error")) errors.push(String(event.message ?? event.error ?? type));
  }
  const uncached = authoritativeSum(usageEvents, ["input"]);
  const cachedInput = authoritativeSum(usageEvents, ["cacheRead"]);
  const cacheWrite = authoritativeSum(usageEvents, ["cacheWrite"]);
  const input = uncached.value !== null && cachedInput.value !== null && cacheWrite.value !== null
    ? uncached.value + cachedInput.value + cacheWrite.value : null;
  const uncachedInput = uncached.value !== null && cacheWrite.value !== null ? uncached.value + cacheWrite.value : null;
  const output = authoritativeSum(usageEvents, ["output"]);
  const reasoning = authoritativeSum(usageEvents, ["reasoning"]);
  const reportedTotal = authoritativeSum(usageEvents, ["totalTokens"]);
  const derivedTotal = reportedTotal.value === null && input !== null && output.value !== null
    ? input + output.value
    : null;
  const tokens: TokenUsage = {
    input,
    uncachedInput,
    cachedInput: cachedInput.value,
    output: output.value,
    reasoning: reasoning.value,
    total: reportedTotal.value ?? derivedTotal,
    provenance: {
      source: "pi-jsonl",
      eventType: "message_end",
      eventLines: usageEvents.map(({ line }) => line),
      rawEventFile: null,
      fields: {
        input: input === null ? null : "derived: message.usage.input + cacheRead + cacheWrite",
        uncachedInput: uncachedInput === null ? null : "derived: message.usage.input + cacheWrite",
        cachedInput: cachedInput.field,
        output: output.field,
        reasoning: reasoning.field,
        total: reportedTotal.field ?? (derivedTotal === null ? null : "derived: total input + message.usage.output"),
      },
    },
  };
  return {
    tokens,
    usageEvents,
    behavioralTelemetry: deriveBehavioralTelemetry(traceEvents),
    accessTelemetry: deriveAccessTelemetry(traceEvents, stdoutLineElapsedMs),
    commands,
    finalResponse,
    editNavigation: {
      firstSourceEditObserved: firstSourceEditLine !== null,
      elapsedMs: firstSourceEditLine === null ? null : stdoutLineElapsedMs[firstSourceEditLine - 1] ?? null,
      eventLine: firstSourceEditLine,
    },
    errors,
  };
}

/** Harness-neutral alias used by graders that consume the current Pi trace format. */
export const parseAgentEvents = parsePiEvents;

export function estimateCost(tokens: TokenUsage, pricing: Pricing | undefined): number | null {
  if (!pricing || tokens.uncachedInput === null || tokens.cachedInput === null || tokens.output === null) return null;
  // Pi's authoritative usage contract prices `output` as a single total. Standard
  // Pi events do not expose a separate reasoning count, so never require, infer,
  // subtract, or double-charge one here.
  return (
    tokens.uncachedInput * pricing.inputPerMillion +
    tokens.cachedInput * pricing.cachedInputPerMillion +
    tokens.output * pricing.outputPerMillion
  ) / 1_000_000;
}
