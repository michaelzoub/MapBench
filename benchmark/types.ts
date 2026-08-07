export const CONDITIONS = [
  "regular-code",
  "outline-only",
  "skeleton-only",
  "callgraph-only",
  "outline-skeleton",
  "outline-callgraph",
  "skeleton-callgraph",
  "all-outline-aids",
] as const;
export type Condition = typeof CONDITIONS[number];

// The default study compares regular code with each generated artifact in
// isolation. Multi-artifact combinations remain available through `factorial`.
export const DEFAULT_CONDITIONS: readonly Condition[] = [
  "regular-code",
  "outline-only",
  "callgraph-only",
  "skeleton-only",
];

const LEGACY_CONDITIONS = ["raw", "full", "no-skeleton", "no-callgraph"] as const;
type LegacyCondition = typeof LEGACY_CONDITIONS[number];

const LEGACY_CONDITION_MAP: Record<LegacyCondition, Condition> = {
  raw: "regular-code",
  full: "all-outline-aids",
  "no-skeleton": "outline-callgraph",
  "no-callgraph": "skeleton-only",
};

export function normalizeCondition(value: string): Condition {
  if ((CONDITIONS as readonly string[]).includes(value)) return value as Condition;
  if ((LEGACY_CONDITIONS as readonly string[]).includes(value)) return LEGACY_CONDITION_MAP[value as LegacyCondition];
  throw new Error(`Unknown benchmark condition: ${value}`);
}

export interface ConditionFactors {
  outline: boolean;
  skeleton: boolean;
  callgraph: boolean;
}

export const CONDITION_FACTORS: Record<Condition, ConditionFactors> = {
  "regular-code": { outline: false, skeleton: false, callgraph: false },
  "outline-only": { outline: true, skeleton: false, callgraph: false },
  "skeleton-only": { outline: false, skeleton: true, callgraph: false },
  "callgraph-only": { outline: false, skeleton: false, callgraph: true },
  "outline-skeleton": { outline: true, skeleton: true, callgraph: false },
  "outline-callgraph": { outline: true, skeleton: false, callgraph: true },
  "skeleton-callgraph": { outline: false, skeleton: true, callgraph: true },
  "all-outline-aids": { outline: true, skeleton: true, callgraph: true },
};

export const CONDITION_LABELS: Record<Condition, string> = {
  "regular-code": "Regular code",
  "outline-only": "Architecture map only",
  "skeleton-only": "Skeleton only",
  "callgraph-only": "Call graph only",
  "outline-skeleton": "Architecture + skeleton",
  "outline-callgraph": "Architecture + call graph",
  "skeleton-callgraph": "Skeleton + call graph",
  "all-outline-aids": "All three artifacts",
};

export interface CommandSpec {
  command: string[];
  timeoutMs?: number;
}

export interface TaskManifest {
  version: 1;
  id: string;
  title: string;
  promptFile: string;
  grader: CommandSpec;
  checks?: {
    regression?: CommandSpec;
    typecheck?: CommandSpec;
    build?: CommandSpec;
  };
}

export interface LoadedTask extends TaskManifest {
  directory: string;
  prompt: string;
  graderDirectory: string;
}

export interface TokenCounts {
  /** Codex input_tokens, inclusive of cached input. */
  input: number | null;
  /** Exact input - cachedInput, unavailable unless both source fields exist. */
  uncachedInput: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
}

export interface TokenProvenance {
  source: "codex-jsonl";
  eventType: "turn.completed";
  eventLines: number[];
  rawEventFile: string | null;
  fields: {
    input: string | null;
    uncachedInput: string | null;
    cachedInput: string | null;
    output: string | null;
    reasoning: string | null;
    total: string | null;
  };
}

export interface TokenUsage extends TokenCounts {
  provenance: TokenProvenance;
}

export interface CommandRecord {
  command: string;
  status: string;
  exitCode: number | null;
  failed: boolean;
  outputBytes: number;
  navigation: NavigationKind;
  accessedPaths: string[];
  readRanges: ReadRange[];
}

export type NavigationKind = "outline" | "source" | "mixed" | "other";

export interface ReadRange {
  file: string;
  start: number;
  end: number;
  outline: boolean;
}

export interface NavigationMetrics {
  outlineAccessCommandCount: number;
  successfulOutlineAccessCommandCount: number;
  sourceAccessCommandCount: number;
  mixedAccessCommandCount: number;
  failedNavigationCommandCount: number;
  outlineOutputBytes: number;
  sourceOutputBytes: number;
  mixedOutputBytes: number;
  commandOutputBytes: number;
  cumulativeOutputBytes: number;
  duplicateSourceReadCount: number;
  duplicateSourceReadLines: number;
  uniqueOutlineFiles: number;
  uniqueSourceFiles: number;
  outlineUsed: boolean;
}

export interface CheckResult {
  status: "passed" | "failed" | "timeout" | "unavailable";
  command: string[] | null;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface GraderResult extends CheckResult {
  score: number;
  maxScore: number;
  passed: boolean;
  details: unknown;
}

export interface RunResult {
  schemaVersion: 2;
  pairId: string;
  taskId: string;
  condition: Condition;
  run: number;
  targetCommit: string;
  baselineCommit: string;
  baselineTreeHash: string;
  promptSha256: string;
  model: string;
  status: "completed" | "failed" | "timeout";
  exitCode: number | null;
  durationMs: number;
  tokens: TokenUsage;
  estimatedCostUsd: number | null;
  commands: CommandRecord[];
  commandCount: number;
  failedCommandCount: number;
  navigation: NavigationMetrics;
  finalResponse: string;
  filesChanged: string[];
  fileCount: number;
  hiddenGrader: GraderResult;
  checks: {
    regression: CheckResult;
    typecheck: CheckResult;
    build: CheckResult;
  };
  artifactDirectory: string;
  workspaceKept: boolean;
  isolation: {
    freshProcess: true;
    resumedSession: false;
    ephemeralSession: true;
    freshWorkspace: true;
    codexHome: "fresh-auth-only";
    initialCodexHomeFiles: string[];
    codexHomeRemoved: true;
  };
  workspace?: string;
  error?: string;
}

export interface Pricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  reasoningPerMillion?: number;
}

export interface PricingResolution {
  source: "openrouter" | "disabled";
  benchmarkModel: string;
  sourceUrl?: string;
  providerModel?: string;
  canonicalModel?: string;
  fetchedAt?: string;
  pricing: Pricing | null;
  warnings: string[];
}

export interface BenchmarkOptions {
  repo: string;
  taskIds: string[];
  runs: number;
  conditions: Condition[];
  model: string;
  timeoutMs: number;
  dryRun: boolean;
  keepWorkspaces: boolean;
  outputRoot: string;
  tasksRoot: string;
  pricingMode: "openrouter" | "off";
  pricingModel?: string;
  seed?: string;
  debugUsage: boolean;
}

export interface SummaryCondition {
  condition: Condition;
  samples: number;
  successes: number;
  successRate: number;
  hiddenScoreMean: number;
  durationMeanMs: number;
  tokensMean: TokenCounts;
  costMeanUsd: number | null;
  commandsMean: number;
  filesMean: number;
  navigationMean: NavigationMetrics;
  accuracyPer100kTokensMean: number | null;
  pairedVsRaw: { wins: number; losses: number; ties: number };
}

export interface BenchmarkSummary {
  schemaVersion: 2;
  generatedAt: string;
  tasks: string[];
  totalRuns: number;
  warnings?: string[];
  conditions: SummaryCondition[];
  ablations: Array<{
    condition: Condition;
    removed: string;
    successRateDelta: number;
    hiddenScoreDelta: number;
    durationDeltaMs: number;
    tokensDelta: number | null;
  }>;
  runs: RunResult[];
}
