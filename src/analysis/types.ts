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
  | "enum";

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
  owner?: string;
  parameters?: string[];
  receiverTypes?: Record<string, string>;
  body?: SourceRange;
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

export interface NormalizedProject {
  root: string;
  files: ParsedFile[];
  symbols: StructuralSymbol[];
  references: StructuralReference[];
}
