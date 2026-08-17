import type { SupportedLanguage } from "../types.js";

export type StructuralSymbolKind =
  | "function"
  | "method"
  | "constructor"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "type"
  | "enum"
  | "module";

export type StructuralVisibility = "public" | "private" | "protected" | "internal" | "unknown";

export interface StructuralSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: StructuralSymbolKind;
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
  signature?: string;
  exported?: boolean;
  visibility?: StructuralVisibility;
  owner?: string;
  parameters?: string[];
  receiverTypes?: Record<string, string>;
  body?: SourceRange;
}

export type StructuralEdgeType =
  | "call"
  | "instantiate"
  | "import"
  | "inherit"
  | "implement"
  | "reference";

export type StructuralResolution = "resolved" | "external" | "unresolved" | "ambiguous";

export interface StructuralEdge {
  id: string;
  type: StructuralEdgeType;
  source: string;
  target?: string;
  targetLabel?: string;
  file: string;
  line: number;
  column: number;
  sourceOrder?: number;
  resolution: StructuralResolution;
  provenance?: string;
}

export interface StructuralUnresolved {
  source?: string;
  type: StructuralEdgeType;
  text: string;
  file: string;
  line: number;
  column: number;
  sourceOrder?: number;
  reason?: string;
}

export interface StructuralManifest {
  tool: string;
  schemaVersion: number;
  toolVersion: string;
  gitCommit?: string;
  languages: SupportedLanguage[];
  filesScanned: string[];
  filesSkipped: string[];
  parseFailures: Array<{ file: string; reason: string }>;
  symbolCount: number;
  edgeCount: number;
  unresolvedCount: number;
}

export interface StructuralIR {
  nodes: StructuralSymbol[];
  edges: StructuralEdge[];
  unresolved: StructuralUnresolved[];
  manifest: StructuralManifest;
}

export interface ImportBinding {
  local: string;
  imported: string;
  source: string;
  file: string;
}

export type ReferenceKind = "call" | "construct" | "import" | "inherit" | "reference";

export interface StructuralReference {
  sourceSymbol?: string;
  text: string;
  kind: ReferenceKind;
  file: string;
  line: number;
  column: number;
  root?: string;
  member?: string;
  arguments?: string[];
  order: number;
}

export interface SourceRange {
  start: number;
  end: number;
}

export interface SourceEdit extends SourceRange {
  replacement: string;
}

export interface ParsedFile {
  absolutePath: string;
  file: string;
  language: SupportedLanguage;
  source: string;
  symbols: StructuralSymbol[];
  imports: ImportBinding[];
  references: StructuralReference[];
  skeletonEdits: SourceEdit[];
  removeTopLevel: SourceRange[];
}

export interface ParseFailure {
  file: string;
  reason: string;
}

export interface NormalizedProject {
  root: string;
  files: ParsedFile[];
  symbols: StructuralSymbol[];
  references: StructuralReference[];
  parseFailures: ParseFailure[];
}

