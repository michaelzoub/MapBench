import type { StructuralIR, StructuralSymbol } from "./types.js";
import type { ParsedFile, SourceEdit } from "./types.js";
import { applyEdits } from "./utils.js";

function commentPrefix(file: ParsedFile): string {
  return file.language === "python" ? "#" : "//";
}

function relationshipComments(file: ParsedFile, symbol: StructuralSymbol, ir: StructuralIR): string {
  const edges = ir.edges
    .filter((edge) => edge.source === symbol.id)
    .sort((left, right) => (left.sourceOrder ?? Number.MAX_SAFE_INTEGER) - (right.sourceOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.line - right.line || left.column - right.column || left.id.localeCompare(right.id));
  if (!edges.length) return "";
  const grouped = new Map<string, string[]>();
  for (const edge of edges) {
    const label = edge.target ?? edge.targetLabel;
    if (!label) continue;
    const relation = edge.resolution === "external" ? "external" : edge.resolution === "unresolved" || edge.resolution === "ambiguous" ? "unresolved" : edge.type;
    const values = grouped.get(relation) ?? [];
    values.push(label);
    grouped.set(relation, values);
  }
  if (!grouped.size) return "";
  const prefix = commentPrefix(file);
  const sourcePrefix = Buffer.from(file.source, "utf8").subarray(0, symbol.startByte);
  const lineStart = sourcePrefix.lastIndexOf(10) + 1;
  const indent = sourcePrefix.subarray(lineStart).toString("utf8").match(/^\s*/)?.[0] ?? "";
  const lines = [`${indent}${prefix} Structural relationships:`];
  for (const relation of [...grouped.keys()].sort()) {
    lines.push(`${indent}${prefix} ${relation}:`);
    for (const value of [...new Set(grouped.get(relation) ?? [])]) lines.push(`${indent}${prefix}   ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function bodyReplacement(file: ParsedFile): string {
  if (file.language === "python") return "pass";
  if (file.language === "typescript" || file.language === "javascript") return "{ }";
  return file.language === "go" ? "{ panic(\"cartograph skeleton\") }" : "{ unimplemented!() }";
}

export function createSkeleton(file: ParsedFile, ir: StructuralIR): string {
  const edits: SourceEdit[] = [
    ...file.skeletonEdits,
    ...file.removeTopLevel.map((item) => ({ ...item, replacement: "" })),
  ];
  for (const symbol of file.symbols) {
    if (symbol.body) edits.push({ ...symbol.body, replacement: bodyReplacement(file) });
    const comments = relationshipComments(file, symbol, ir);
    if (comments) {
      const declarationStart = Buffer.from(file.source, "utf8").subarray(0, symbol.startByte).lastIndexOf(10) + 1;
      edits.push({ start: declarationStart, end: declarationStart, replacement: comments });
    }
  }
  const body = applyEdits(file.source, edits).trim();
  const header = file.language === "python"
    ? "# @cartograph generated"
    : file.language === "typescript" || file.language === "javascript"
      ? "// @ts-nocheck"
      : "// @cartograph generated";
  return `${header}\n\n${body}\n`;
}
