import type {
  AccessKind,
  AccessRecord,
  AccessTelemetry,
  BehavioralTelemetry,
  GraderResult,
  TelemetryAggregate,
  TelemetryStatistics,
  TokenCounts,
  TokenUsage,
  TrialTelemetry,
} from "./types.js";
import { accessedPaths } from "./navigation.js";
import { mean } from "./util.js";

export interface PiTraceEvent {
  line: number;
  event: Record<string, unknown>;
}

interface ToolInvocation {
  name: string;
  args: unknown;
  failed: boolean;
  completed: boolean;
  eventIndex: number;
  elapsedMs: number | null;
}

const SOURCE_EXTENSION = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)(?:\b|$)/i;
const SOURCE_PATH = /(?:\.?\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)\b/gi;
const ARTIFACT_PATH = /(?:^|[\s"'`/])\.mapbench(?:\/[^\s"'`;&|)]*)?/i;
const SHELL_SEARCH = /(?:^|[;&|]\s*|\s)(?:grep|find|rg|ag|ack)\b/i;
const SHELL_READ = /(?:^|[;&|]\s*|\s)(?:cat|sed\s+-n|head|tail|less|more)\b/i;
const SHELL_EDIT = /\bapply_patch\b|\bpatch\s+-p\d|\b(?:sed|perl)\b[^\n]*(?:\s-i\b|--in-place)|(?:^|[;&|]\s*)tee\s|(?:^|[^<])>{1,2}\s*[^&]/i;

/**
 * Stable MapBench telemetry semantics. Every behavioral counter is defined here
 * and counts tool invocations, never output chunks, result size, or model prose.
 */
export const TELEMETRY_DEFINITIONS = Object.freeze({
  passed: "hidden grader / DeepSWE verifier pass/fail; never efficiency-adjusted",
  verifierScore: "hidden grader raw score, maximum score, and raw/max normalized score",
  modelTurns: "assistant message_end events",
  toolCalls: "unique Pi tool invocations observed at start or end",
  sourceFileReads: "read-tool or shell-read invocations targeting repository source code outside .mapbench/",
  artifactReads: "read-tool or shell-read invocations targeting generated .mapbench/ artifacts",
  graphQueries: "mapbench_query invocations",
  searches: "grep/find/search tool invocations or shell invocations containing grep/find/rg/ag/ack",
  edits: "edit/write/apply_patch tool invocations or mutating shell invocations",
  shellCommands: "bash/shell invocations",
  failedToolCalls: "tool invocations whose tool_execution_end event has isError=true",
  accesses: "ordered file-read and mapbench_query attempts from Pi tool events; success requires a non-error tool_execution_end",
  failedAccesses: "file-read and mapbench_query attempts whose tool_execution_end has isError=true, retained separately in attempt order",
  incompleteAccesses: "file-read and mapbench_query attempts with no matching tool_execution_end, retained separately in attempt order",
  openedFiles: "successful file reads in access order, including repeated paths",
  sourceFileReadCount: "successful source-file access records",
  artifactReadCount: "successful .mapbench/ file access records",
  graphQueryCount: "mapbench_query access attempts, counted independently from file reads",
  tokens: "authoritative Pi message_end usage totals; unavailable fields remain null",
  runtimeMs: "wall-clock Pi agent-process invocation time, excluding verifier and report generation",
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizedToolName(value: string): string {
  return value.toLowerCase().split(/[.:/]/).at(-1) ?? value.toLowerCase();
}

function explicitPaths(args: unknown): string[] {
  const payload = record(args);
  const values = [payload.path, payload.file, payload.file_path, payload.filename];
  if (Array.isArray(payload.paths)) values.push(...payload.paths);
  return values.filter((value): value is string => typeof value === "string");
}

function shellCommand(args: unknown): string {
  const payload = record(args);
  return typeof payload.command === "string" ? payload.command : typeof payload.cmd === "string" ? payload.cmd : "";
}

function isArtifactPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ".mapbench" || normalized.startsWith(".mapbench/") || normalized.endsWith("/.mapbench") || normalized.includes("/.mapbench/");
}

function isSourcePath(value: string): boolean {
  return !isArtifactPath(value) && SOURCE_EXTENSION.test(value);
}

function isReadTool(name: string): boolean {
  return ["read", "read_file", "view_file", "open_file"].includes(name);
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^['"`]+|['"`,;:)]+$/g, "");
}

function accessKind(value: string): AccessKind {
  if (isArtifactPath(value)) return "artifact";
  if (isSourcePath(value)) return "source";
  return "other";
}

function fileReadPaths(name: string, args: unknown): string[] {
  if (isReadTool(name)) return explicitPaths(args).map(normalizedPath).filter(Boolean);
  const command = shellCommand(args);
  if ((name === "bash" || name === "shell") && SHELL_READ.test(command)) {
    return accessedPaths(command).map(normalizedPath).filter(Boolean);
  }
  return [];
}

function invocationKey(event: Record<string, unknown>, line: number, phase: "start" | "end"): string {
  const id = event.toolCallId ?? event.tool_call_id ?? event.id;
  return typeof id === "string" && id ? `id:${id}` : `${phase}:${line}`;
}

export function deriveBehavioralTelemetry(events: PiTraceEvent[]): BehavioralTelemetry {
  const calls = new Map<string, ToolInvocation>();
  let modelTurns = 0;
  for (const { line, event } of events) {
    const type = String(event.type ?? "");
    if (type === "message_end" && record(event.message).role === "assistant") modelTurns += 1;
    if (type === "tool_execution_start") {
      const key = invocationKey(event, line, "start");
      if (!calls.has(key)) calls.set(key, {
        name: String(event.toolName ?? "unknown"), args: event.args, failed: false, completed: false,
        eventIndex: line - 1, elapsedMs: null,
      });
    }
    if (type === "tool_execution_end") {
      const key = invocationKey(event, line, "end");
      const existing = calls.get(key);
      if (existing) {
        existing.failed ||= event.isError === true;
        existing.completed = true;
      } else calls.set(key, {
        name: String(event.toolName ?? "unknown"), args: event.args, failed: event.isError === true, completed: true,
        eventIndex: line - 1, elapsedMs: null,
      });
    }
  }

  const metrics: BehavioralTelemetry = {
    modelTurns,
    toolCalls: calls.size,
    sourceFileReads: 0,
    artifactReads: 0,
    graphQueries: 0,
    searches: 0,
    edits: 0,
    shellCommands: 0,
    failedToolCalls: 0,
  };
  for (const call of calls.values()) {
    const name = normalizedToolName(call.name);
    const paths = explicitPaths(call.args);
    const command = shellCommand(call.args);
    const shell = name === "bash" || name === "shell";
    const readOperation = isReadTool(name) || (shell && SHELL_READ.test(command));
    if (readOperation) {
      const sourcePaths = [...paths, ...(command.match(SOURCE_PATH) ?? [])];
      if (sourcePaths.some(isSourcePath)) metrics.sourceFileReads += 1;
      if (paths.some(isArtifactPath) || (shell && ARTIFACT_PATH.test(command))) metrics.artifactReads += 1;
    }
    if (name === "mapbench_query") metrics.graphQueries += 1;
    if (["grep", "find", "search", "ripgrep"].includes(name) || (shell && SHELL_SEARCH.test(command))) metrics.searches += 1;
    if (["edit", "write", "apply_patch"].includes(name) || (shell && SHELL_EDIT.test(command))) metrics.edits += 1;
    if (shell) metrics.shellCommands += 1;
    if (call.failed) metrics.failedToolCalls += 1;
  }
  return metrics;
}

/**
 * Derive ordered access attempts from raw Pi tool events. Starts are retained
 * even when a process fails or times out before the corresponding end event.
 */
export function deriveAccessTelemetry(events: PiTraceEvent[], eventElapsedMs: Array<number | null> = []): AccessTelemetry {
  const calls = new Map<string, ToolInvocation>();
  for (const { line, event } of events) {
    const type = String(event.type ?? "");
    if (type === "tool_execution_start") {
      const key = invocationKey(event, line, "start");
      if (!calls.has(key)) calls.set(key, {
        name: String(event.toolName ?? "unknown"),
        args: event.args,
        failed: false,
        completed: false,
        eventIndex: line - 1,
        elapsedMs: eventElapsedMs[line - 1] ?? null,
      });
    }
    if (type === "tool_execution_end") {
      const key = invocationKey(event, line, "end");
      const existing = calls.get(key);
      if (existing) {
        existing.failed ||= event.isError === true;
        existing.completed = true;
      } else calls.set(key, {
        name: String(event.toolName ?? "unknown"),
        args: event.args,
        failed: event.isError === true,
        completed: true,
        eventIndex: line - 1,
        elapsedMs: eventElapsedMs[line - 1] ?? null,
      });
    }
  }

  const accesses: AccessRecord[] = [];
  for (const call of [...calls.values()].sort((left, right) => left.eventIndex - right.eventIndex)) {
    const tool = normalizedToolName(call.name);
    const status = !call.completed ? "incomplete" : call.failed ? "failed" : "succeeded";
    const success = status === "succeeded";
    for (const file of fileReadPaths(tool, call.args)) {
      accesses.push({ path: file, kind: accessKind(file), tool, eventIndex: call.eventIndex, elapsedMs: call.elapsedMs, status, success });
    }
    if (tool === "mapbench_query") {
      accesses.push({ path: "mapbench_query", kind: "other", tool, eventIndex: call.eventIndex, elapsedMs: call.elapsedMs, status, success });
    }
  }

  const failedAccesses = accesses.filter((access) => access.status === "failed");
  const incompleteAccesses = accesses.filter((access) => access.status === "incomplete");
  const artifactAccesses = accesses.filter((access) => access.kind === "artifact");
  const graphAccesses = accesses.filter((access) => access.tool === "mapbench_query");
  const successfulFiles = accesses.filter((access) => access.tool !== "mapbench_query" && access.success);
  const successfulArtifacts = successfulFiles.filter((access) => access.kind === "artifact");
  const successfulGraphs = graphAccesses.filter((access) => access.success);
  return {
    accesses,
    failedAccesses,
    incompleteAccesses,
    openedFiles: successfulFiles.map((access) => access.path),
    uniqueSourceFilesOpened: new Set(successfulFiles.filter((access) => access.kind === "source").map((access) => access.path)).size,
    uniqueArtifactFilesOpened: new Set(successfulArtifacts.map((access) => access.path)).size,
    sourceFileReadCount: successfulFiles.filter((access) => access.kind === "source").length,
    artifactReadCount: successfulArtifacts.length,
    artifactUsed: successfulArtifacts.length > 0 || successfulGraphs.length > 0,
    failedSourceFileReadCount: failedAccesses.filter((access) => access.kind === "source").length,
    failedArtifactReadCount: failedAccesses.filter((access) => access.kind === "artifact").length,
    firstArtifactAccessEvent: artifactAccesses[0]?.eventIndex ?? null,
    firstArtifactAccessMs: artifactAccesses[0]?.elapsedMs ?? null,
    graphQueryCount: graphAccesses.length,
    successfulGraphQueryCount: successfulGraphs.length,
    failedGraphQueryCount: failedAccesses.filter((access) => access.tool === "mapbench_query").length,
    firstGraphQueryEvent: graphAccesses[0]?.eventIndex ?? null,
    firstGraphQueryMs: graphAccesses[0]?.elapsedMs ?? null,
  };
}

export function emptyAccessTelemetry(): AccessTelemetry {
  return deriveAccessTelemetry([]);
}

export function buildTrialTelemetry(
  behavioral: BehavioralTelemetry,
  tokens: TokenUsage,
  verifier: GraderResult,
  runtimeMs: number,
  access: AccessTelemetry = emptyAccessTelemetry(),
): TrialTelemetry {
  return {
    passed: verifier.passed,
    verifierScore: {
      raw: verifier.score,
      max: verifier.maxScore,
      normalized: verifier.maxScore > 0 ? verifier.score / verifier.maxScore : null,
    },
    ...behavioral,
    ...access,
    tokens: {
      input: tokens.input,
      uncachedInput: tokens.uncachedInput,
      cachedInput: tokens.cachedInput,
      output: tokens.output,
      reasoning: tokens.reasoning,
      total: tokens.total,
    },
    runtimeMs,
    provenance: {
      schemaVersion: 1,
      behavioralSource: "pi-jsonl-tool-events",
      tokenSource: "pi-jsonl-message-usage",
      verifierSource: "hidden-grader",
      rawEventFile: "events.jsonl",
    },
  };
}

export function withVerifierTelemetry(telemetry: TrialTelemetry, verifier: GraderResult): TrialTelemetry {
  return {
    ...telemetry,
    passed: verifier.passed,
    verifierScore: {
      raw: verifier.score,
      max: verifier.maxScore,
      normalized: verifier.maxScore > 0 ? verifier.score / verifier.maxScore : null,
    },
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nullableAggregate(values: Array<number | null>, aggregate: (items: number[]) => number): number | null {
  return values.every((value): value is number => value !== null) ? aggregate(values) : null;
}

function aggregateTelemetry(values: TrialTelemetry[], aggregate: (items: number[]) => number): TelemetryAggregate {
  const numberValue = (key: keyof BehavioralTelemetry): number => aggregate(values.map((item) => item[key]));
  const token = (key: keyof TokenCounts): number | null => nullableAggregate(values.map((item) => item.tokens[key]), aggregate);
  return {
    passed: aggregate(values.map((item) => Number(item.passed))),
    verifierScore: {
      raw: aggregate(values.map((item) => item.verifierScore.raw)),
      max: aggregate(values.map((item) => item.verifierScore.max)),
      normalized: nullableAggregate(values.map((item) => item.verifierScore.normalized), aggregate),
    },
    modelTurns: numberValue("modelTurns"),
    toolCalls: numberValue("toolCalls"),
    sourceFileReads: numberValue("sourceFileReads"),
    artifactReads: numberValue("artifactReads"),
    graphQueries: numberValue("graphQueries"),
    searches: numberValue("searches"),
    edits: numberValue("edits"),
    shellCommands: numberValue("shellCommands"),
    failedToolCalls: numberValue("failedToolCalls"),
    tokens: {
      input: token("input"),
      uncachedInput: token("uncachedInput"),
      cachedInput: token("cachedInput"),
      output: token("output"),
      reasoning: token("reasoning"),
      total: token("total"),
    },
    runtimeMs: aggregate(values.map((item) => item.runtimeMs)),
  };
}

export function telemetryStatistics(values: TrialTelemetry[]): TelemetryStatistics {
  return { mean: aggregateTelemetry(values, mean), median: aggregateTelemetry(values, median) };
}
