import path from "node:path";
import type Parser from "tree-sitter";
import {
  cleanText, expressionParts, field, identifierArguments, location, maskComments, range, reference, walk, type SyntaxNode,
} from "../analysis/utils.js";
import type { ImportBinding, ParsedFile, StructuralReference, StructuralSymbol } from "../analysis/types.js";

function importsFor(node: SyntaxNode, file: string): ImportBinding[] {
  const result: ImportBinding[] = [];
  walk(node, (child) => {
    if (child.type !== "import_spec") return;
    const sourceNode = field(child, "path");
    const source = sourceNode?.text.replace(/^`|`$/g, "").replace(/^"|"$/g, "");
    if (!source) return;
    const name = field(child, "name")?.text ?? path.posix.basename(source);
    if (name !== "_" && name !== ".") result.push({ local: name, imported: "*", source, file });
  });
  return result;
}

function parameterInfo(node: SyntaxNode | undefined): { names: string[]; types: Record<string, string> } {
  const names: string[] = [];
  const types: Record<string, string> = {};
  for (const declaration of node?.namedChildren ?? []) {
    const typeNode = field(declaration, "type");
    const typeName = typeNode?.text.replace(/^\*/, "").match(/[A-Za-z_]\w*/)?.[0];
    for (const child of declaration.namedChildren) {
      if (child.type !== "identifier") continue;
      names.push(child.text);
      if (typeName) types[child.text] = typeName;
    }
  }
  return { names, types };
}

function collectReferences(body: SyntaxNode, file: string, id: string): StructuralReference[] {
  const references: StructuralReference[] = [];
  let order = 0;
  walk(body, (node) => {
    if (node !== body && (node.type === "function_declaration" || node.type === "method_declaration" || node.type === "func_literal")) return false;
    if (node.type === "call_expression") {
      const callable = field(node, "function");
      if (!callable) return;
      const text = cleanText(callable);
      references.push(reference(file, id, node, "call", text, order++, {
        ...expressionParts(text), arguments: identifierArguments(field(node, "arguments")),
      }));
    } else if (node.type === "composite_literal") {
      const typeNode = field(node, "type");
      if (!typeNode) return;
      const text = cleanText(typeNode).replace(/^\*/, "");
      references.push(reference(file, id, node, "construct", text, order++, expressionParts(text)));
    }
  });
  return references;
}

export function extractGoFile(absolutePath: string, file: string, source: string, tree: Parser.Tree): ParsedFile {
  const symbols: StructuralSymbol[] = [];
  const references: StructuralReference[] = [];
  const imports: ImportBinding[] = [];
  const skeletonEdits = maskComments(tree.rootNode);
  walk(tree.rootNode, (node) => {
    if (node.type === "var_declaration" || node.type === "const_declaration") {
      skeletonEdits.push({ ...range(node), replacement: "" });
      return false;
    }
  });
  const removeTopLevel = tree.rootNode.namedChildren.filter((node) => node.type === "expression_statement").map(range);

  walk(tree.rootNode, (node) => {
    if (node.type === "import_declaration") imports.push(...importsFor(node, file));
    if (node.type === "type_spec") {
      const name = cleanText(field(node, "name"));
      const typeNode = field(node, "type");
      if (!name || !typeNode) return;
      const kind = typeNode.type === "struct_type" ? "struct" : typeNode.type === "interface_type" ? "interface" : "type";
      symbols.push({ id: `${file}#${name}`, name, qualifiedName: name, kind, file, ...location(node), exported: /^[A-Z]/.test(name) });
    }
    if (node.type !== "function_declaration" && node.type !== "method_declaration") return;
    const name = cleanText(field(node, "name"));
    const body = field(node, "body");
    if (!name || !body) return false;
    let owner: string | undefined;
    const receiverTypes: Record<string, string> = {};
    if (node.type === "method_declaration") {
      const receiver = field(node, "receiver");
      const match = cleanText(receiver).match(/\(\s*([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*)\s*\)/);
      if (match) {
        receiverTypes[match[1]] = match[2];
        owner = match[2];
      }
    }
    const info = parameterInfo(field(node, "parameters"));
    const qualifiedName = owner ? `${owner}.${name}` : name;
    const id = `${file}#${qualifiedName}`;
    const result = field(node, "result");
    symbols.push({
      id, name, qualifiedName, kind: owner ? "method" : "function", file, ...location(node),
      signature: `${name}${cleanText(field(node, "parameters"))}${result ? ` ${cleanText(result)}` : ""}`,
      owner, parameters: info.names, receiverTypes: { ...receiverTypes, ...info.types }, body: range(body), exported: /^[A-Z]/.test(name),
    });
    references.push(...collectReferences(body, file, id));
    return false;
  });
  return { absolutePath, file, language: "go", source, symbols, imports, references, skeletonEdits, removeTopLevel };
}
