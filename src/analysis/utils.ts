import path from "node:path";
import type Parser from "tree-sitter";
import type { SourceEdit, SourceRange, StructuralReference, StructuralSymbol } from "./types.js";

export type SyntaxNode = Parser.SyntaxNode;

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function posixRelative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join("/");
}

export function cleanText(node: SyntaxNode | null | undefined): string {
  return node?.text.replace(/\s+/g, " ").trim() ?? "";
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && ["'", '"', "`"].includes(trimmed[0])
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function field(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
}

export function walk(node: SyntaxNode, visit: (node: SyntaxNode) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of node.namedChildren) walk(child, visit);
}

export function location(node: SyntaxNode): Pick<
  StructuralSymbol,
  "startLine" | "startColumn" | "endLine" | "endColumn" | "startByte" | "endByte"
> {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

export function range(node: SyntaxNode): SourceRange {
  return { start: node.startIndex, end: node.endIndex };
}

export function applyEdits(source: string, edits: readonly SourceEdit[]): string {
  let output = Buffer.from(source, "utf8");
  const selected: SourceEdit[] = [];
  for (const edit of [...edits].sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (selected.some((outer) => edit.start >= outer.start && edit.end <= outer.end)) continue;
    selected.push(edit);
  }
  const ordered = selected.sort((left, right) => right.start - left.start || right.end - left.end);
  for (const edit of ordered) {
    output = Buffer.concat([
      output.subarray(0, edit.start),
      Buffer.from(edit.replacement, "utf8"),
      output.subarray(edit.end),
    ]);
  }
  return output.toString("utf8");
}

export function reference(
  file: string,
  sourceSymbol: string,
  node: SyntaxNode,
  kind: StructuralReference["kind"],
  text: string,
  order: number,
  extra: Partial<StructuralReference> = {},
): StructuralReference {
  return {
    sourceSymbol,
    text: text.replace(/\s+/g, " ").trim(),
    kind,
    file,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    order,
    ...extra,
  };
}

export function expressionParts(value: string): { root?: string; member?: string } {
  const clean = value.replace(/\?\./g, ".").replace(/!\./g, ".").trim();
  const root = clean.match(/^(?:await\s+)?([A-Za-z_$][\w$]*)/)?.[1];
  const member = clean.match(/(?:\.|::)([A-Za-z_$][\w$]*)\s*$/)?.[1];
  return { root, member };
}

export function identifierArguments(node: SyntaxNode | undefined): string[] {
  if (!node) return [];
  return node.namedChildren.map((child) => {
    const value = cleanText(child).replace(/^\w+\s*=\s*/, "");
    return /^[A-Za-z_$][\w$]*$/.test(value) ? value : "";
  });
}

export function maskComments(root: SyntaxNode): SourceEdit[] {
  const edits: SourceEdit[] = [];
  walk(root, (node) => {
    if (node.type === "comment") edits.push({ ...range(node), replacement: "" });
  });
  return edits;
}
