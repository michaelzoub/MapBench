import type Parser from "tree-sitter";
import {
  cleanText,
  expressionParts,
  field,
  identifierArguments,
  location,
  maskComments,
  range,
  reference,
  walk,
  type SyntaxNode,
} from "../analysis/utils.js";
import type { ImportBinding, ParsedFile, SourceEdit, StructuralReference, StructuralSymbol } from "../analysis/types.js";

function parseImports(node: SyntaxNode, file: string): ImportBinding[] {
  const result: ImportBinding[] = [];
  if (node.type === "import_statement") {
    const body = node.text.replace(/^\s*import\s+/, "");
    for (const part of body.split(",")) {
      const match = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
      if (match) result.push({ local: match[2] ?? match[1].split(".")[0], imported: "*", source: match[1], file });
    }
  } else if (node.type === "import_from_statement") {
    const match = node.text.match(/^\s*from\s+([\w.]+)\s+import\s+([\s\S]+)$/);
    if (!match) return result;
    for (const part of match[2].replace(/[()]/g, "").split(",")) {
      const binding = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (binding) result.push({ local: binding[2] ?? binding[1], imported: binding[1], source: match[1], file });
    }
  }
  return result;
}

function parameters(node: SyntaxNode | undefined): { names: string[]; types: Record<string, string> } {
  const names: string[] = [];
  const types: Record<string, string> = {};
  for (const parameter of node?.namedChildren ?? []) {
    const value = cleanText(parameter);
    const match = value.match(/^\*{0,2}([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_]\w*))?/);
    if (!match) continue;
    names.push(match[1]);
    if (match[2]) types[match[1]] = match[2];
  }
  return { names, types };
}

function maskedDefaults(value: string): string {
  return value.replace(/=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,)]+)/g, "= ...");
}

function collectReferences(body: SyntaxNode, file: string, id: string): StructuralReference[] {
  const references: StructuralReference[] = [];
  let order = 0;
  walk(body, (node) => {
    if (node !== body && (node.type === "function_definition" || node.type === "lambda")) return false;
    if (node.type !== "call") return;
    const callable = field(node, "function");
    if (!callable) return;
    const text = cleanText(callable);
    references.push(reference(file, id, node, "call", text, order++, {
      ...expressionParts(text),
      arguments: identifierArguments(field(node, "arguments")),
    }));
  });
  return references;
}

function classTypes(node: SyntaxNode): Record<string, string> {
  const result: Record<string, string> = {};
  walk(field(node, "body") ?? node, (child) => {
    if (child !== node && child.type === "class_definition") return false;
    if (child.type !== "function_definition" || cleanText(field(child, "name")) !== "__init__") return;
    const info = parameters(field(child, "parameters"));
    walk(field(child, "body") ?? child, (statement) => {
      if (statement.type !== "assignment") return;
      const left = cleanText(field(statement, "left"));
      const right = cleanText(field(statement, "right"));
      const property = left.match(/^self\.(\w+)$/)?.[1];
      if (property && info.types[right]) result[property] = info.types[right];
    });
  });
  return result;
}

export function extractPythonFile(
  absolutePath: string,
  file: string,
  source: string,
  tree: Parser.Tree,
): ParsedFile {
  const symbols: StructuralSymbol[] = [];
  const references: StructuralReference[] = [];
  const imports: ImportBinding[] = [];
  const skeletonEdits: SourceEdit[] = maskComments(tree.rootNode);
  walk(tree.rootNode, (node) => {
    if (!["default_parameter", "typed_default_parameter"].includes(node.type)) return;
    const value = field(node, "value");
    if (value) skeletonEdits.push({ ...range(value), replacement: "..." });
  });
  const removeTopLevel = tree.rootNode.namedChildren
    .filter((node) => node.type === "expression_statement" && !node.namedChildren.some((child) => child.type === "assignment"))
    .map(range);

  const visit = (node: SyntaxNode, owner?: string, inheritedTypes: Record<string, string> = {}, enumClass = false): void => {
    if (node.type === "import_statement" || node.type === "import_from_statement") imports.push(...parseImports(node, file));
    if (node.type === "class_definition") {
      const name = cleanText(field(node, "name"));
      if (!name) return;
      const qualifiedName = owner ? `${owner}.${name}` : name;
      const typeId = `${file}#${qualifiedName}`;
      const superclasses = cleanText(field(node, "superclasses"));
      symbols.push({
        id: typeId,
        name,
        qualifiedName,
        kind: /(?:^|[, (])Protocol(?:[, )]|$)/.test(superclasses) ? "interface" : "class",
        file,
        ...location(node),
        owner,
        exported: !name.startsWith("_"),
      });
      for (const target of field(node, "superclasses")?.namedChildren ?? []) {
        const text = cleanText(target);
        if (text) references.push(reference(file, typeId, target, "inherit", text, references.length, expressionParts(text)));
      }
      const types = classTypes(node);
      for (const child of field(node, "body")?.namedChildren ?? []) visit(child, qualifiedName, types, /(?:^|[, (])Enum(?:[, )]|$)/.test(superclasses));
      return;
    }
    if (node.type === "function_definition") {
      const name = cleanText(field(node, "name"));
      const body = field(node, "body");
      if (!name || !body) return;
      const qualifiedName = owner ? `${owner}.${name}` : name;
      const id = `${file}#${qualifiedName}`;
      const info = parameters(field(node, "parameters"));
      const returnType = field(node, "return_type");
      const kind = name === "__init__" ? "constructor" : owner ? "method" : "function";
      symbols.push({
        id, name, qualifiedName, kind, file, ...location(node),
        signature: `${name}${maskedDefaults(cleanText(field(node, "parameters")))}${returnType ? ` -> ${cleanText(returnType)}` : ""}`,
        owner, parameters: info.names, receiverTypes: { ...inheritedTypes, ...info.types }, body: range(body), exported: !name.startsWith("_"),
      });
      references.push(...collectReferences(body, file, id));
      return;
    }
    if (node.type === "assignment" && !enumClass) {
      const right = field(node, "right");
      if (right) skeletonEdits.push({ ...range(right), replacement: "..." });
    }
    for (const child of node.namedChildren) visit(child, owner, inheritedTypes, enumClass);
  };
  for (const child of tree.rootNode.namedChildren) visit(child);
  return {
    absolutePath, file, language: "python", source,
    symbols, imports, references, skeletonEdits, removeTopLevel,
  };
}
