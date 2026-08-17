export type SupportedLanguage = "typescript" | "javascript" | "python" | "go" | "rust";

export interface OutlineOptions {
  root?: string;
  out?: string;
  language?: SupportedLanguage;
}

export interface QueryOptions {
  root?: string;
  out?: string;
  depth?: number;
  limit?: number;
}

export type CallGraphDirection = "callers" | "callees" | "both";

export interface CallGraphSymbolReference {
  id: string;
  /** 1-based repository-relative jump target in `file:line:column` form. */
  location: string;
  kind: CallGraphSymbolKind;
  signature: string;
}

export interface CallGraphSymbolDetail extends CallGraphSymbolReference {
  /** Callees in first lexical source-occurrence order. */
  callees: CallGraphSymbolReference[];
  callers: CallGraphSymbolReference[];
  instantiates?: string[];
  unresolvedProjectCalls?: string[];
  externalCalls?: string[];
}

export interface CallGraphFindResult {
  operation: "find";
  query: string;
  matches: CallGraphSymbolReference[];
  truncated: boolean;
}

export interface CallGraphInspectResult {
  operation: "inspect";
  query: string;
  resolution: "exact" | "ambiguous" | "missing";
  symbol?: CallGraphSymbolDetail;
  candidates?: CallGraphSymbolReference[];
  omitted?: {
    callers: number;
    callees: number;
  };
  truncated: boolean;
}

export interface CallGraphExploreNode extends CallGraphSymbolReference {
  distance: number;
  instantiates?: string[];
  unresolvedProjectCalls?: string[];
  externalCalls?: string[];
}

export interface CallGraphExploreResult {
  operation: "explore";
  query: string;
  resolution: "exact" | "ambiguous" | "missing";
  direction: CallGraphDirection;
  depth: number;
  root?: string;
  nodes?: CallGraphExploreNode[];
  /** Directed repository call edges represented as `[caller, callee]`. */
  edges?: [string, string][];
  candidates?: CallGraphSymbolReference[];
  truncated: boolean;
}

export interface CallGraphTraceStep {
  from: string;
  to: string;
  /** Relationship followed from `from` to `to`. */
  relation: "calls" | "calledBy";
}

export interface CallGraphTraceResult {
  operation: "trace";
  from: string;
  to: string;
  direction: CallGraphDirection;
  maxDepth: number;
  resolution: "exact" | "ambiguous" | "missing";
  found: boolean;
  path?: CallGraphSymbolReference[];
  steps?: CallGraphTraceStep[];
  fromCandidates?: CallGraphSymbolReference[];
  toCandidates?: CallGraphSymbolReference[];
  truncated: boolean;
}

export type CallGraphNavigationResult =
  | CallGraphFindResult
  | CallGraphInspectResult
  | CallGraphExploreResult
  | CallGraphTraceResult;

export type CallGraphNavigationRequest =
  | { operation: "find"; query: string; limit?: number }
  | { operation: "inspect"; query: string; limit?: number }
  | { operation: "explore"; query: string; direction?: CallGraphDirection; depth?: number; limit?: number }
  | { operation: "trace"; from: string; to: string; direction?: CallGraphDirection; maxDepth?: number };

export interface GenerationResult {
  root: string;
  out: string;
  filesWritten: number;
  staleFilesRemoved: number;
  languages: SupportedLanguage[];
}

export type CallGraphSymbolKind =
  | "function"
  | "method"
  | "constructor"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "type"
  | "enum";

export interface CallGraphEntry {
  file: string;
  line: number;
  column: number;
  /** 1-based line containing the declaration's exclusive end point. */
  endLine: number;
  /** Exclusive 1-based UTF-8 byte column of the declaration end. */
  endColumn: number;
  /** Inclusive UTF-8 byte offset in the source file. */
  startByte: number;
  /** Exclusive UTF-8 byte offset in the source file. */
  endByte: number;
  kind: CallGraphSymbolKind;
  signature: string;
  /** Statically resolved repository callees, identified as `<file>#<qualified symbol>`. */
  calls: string[];
  /** Unique callees in lexical source order. Omitted when identical to `calls`. */
  callsInSourceOrder?: string[];
  calledBy: string[];
  /** Repository types instantiated by this callable, identified as `<file>#<qualified type>`. */
  instantiates?: string[];
  /** Dynamic or ambiguous call sites that may resolve to repository code at runtime. */
  unresolvedProjectCalls?: string[];
  /** Imported package APIs called by this symbol; trivial language built-ins are omitted. */
  externalCalls?: string[];
}

export type CallGraph = Record<string, CallGraphEntry>;

export interface CallGraphQueryMatch extends CallGraphEntry {
  id: string;
  distance: number;
}

export interface CallGraphQueryResult {
  query: string;
  exact: boolean;
  truncated: boolean;
  matches: CallGraphQueryMatch[];
}

export interface InitResult {
  root: string;
  agentsFile: string;
  changed: boolean;
  created: boolean;
}

export interface WatchHandle {
  close(): void;
}
