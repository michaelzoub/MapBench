import type ts from "typescript";

export type SupportedLanguage = "typescript" | "python";

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

export interface TypeScriptProjectContext {
  root: string;
  out: string;
  configPath?: string;
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
  program: ts.Program;
}

export interface GenerationResult {
  root: string;
  out: string;
  filesWritten: number;
  staleFilesRemoved: number;
  languages: SupportedLanguage[];
}

export type CallGraphSymbolKind = "function" | "method" | "constructor";

export interface CallGraphEntry {
  file: string;
  line: number;
  column: number;
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
