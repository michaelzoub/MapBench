import type Parser from "tree-sitter";
import {
  cleanText, expressionParts, field, identifierArguments, location, maskComments, range, reference, walk, type SyntaxNode,
} from "../analysis/utils.js";
import type { ImportBinding, ParsedFile, StructuralReference, StructuralSymbol } from "../analysis/types.js";

function importsFor(node: SyntaxNode, file: string): ImportBinding[] {
  const source = cleanText(field(node, "argument"));
  if (!source) return [];
  const leaf = source.match(/(?:^|::)([A-Za-z_]\w*)$/)?.[1];
  return leaf ? [{ local: leaf, imported: leaf, source, file }] : [];
}

function parameterInfo(node: SyntaxNode | undefined): { names: string[]; types: Record<string, string> } {
  const names: string[] = [];
  const types: Record<string, string> = {};
  for (const parameter of node?.namedChildren ?? []) {
    if (parameter.type === "self_parameter") {
      names.push("self");
      continue;
    }
    const pattern = field(parameter, "pattern");
    const typeNode = field(parameter, "type");
    const name = cleanText(pattern).match(/[A-Za-z_]\w*/)?.[0];
    const typeName = cleanText(typeNode).match(/[A-Za-z_]\w*/)?.[0];
    if (name) {
      names.push(name);
      if (typeName) types[name] = typeName;
    }
  }
  return { names, types };
}

function collectReferences(body: SyntaxNode, file: string, id: string): StructuralReference[] {
  const references: StructuralReference[] = [];
  let order = 0;
  walk(body, (node) => {
    if (node !== body && (node.type === "function_item" || node.type === "closure_expression")) return false;
    if (node.type === "call_expression") {
      const callable = field(node, "function");
      if (!callable) return;
      const text = cleanText(callable);
      references.push(reference(file, id, node, "call", text, order++, {
        ...expressionParts(text), arguments: identifierArguments(field(node, "arguments")),
      }));
    } else if (node.type === "struct_expression") {
      const name = field(node, "name");
      if (!name) return;
      const text = cleanText(name);
      references.push(reference(file, id, node, "construct", text, order++, expressionParts(text)));
    }
  });
  return references;
}

export function extractRustFile(absolutePath: string, file: string, source: string, tree: Parser.Tree): ParsedFile {
  const symbols: StructuralSymbol[] = [];
  const references: StructuralReference[] = [];
  const imports: ImportBinding[] = [];
  const skeletonEdits = maskComments(tree.rootNode);
  walk(tree.rootNode, (node) => {
    if (node.type === "const_item" || node.type === "static_item") {
      skeletonEdits.push({ ...range(node), replacement: "" });
      return false;
    }
  });
  const removeTopLevel = tree.rootNode.namedChildren.filter((node) => node.type === "expression_statement").map(range);

  const visit = (node: SyntaxNode, owner?: string, ownerKind?: "trait" | "impl"): void => {
    if (node.type === "use_declaration") imports.push(...importsFor(node, file));
    const kinds: Record<string, StructuralSymbol["kind"]> = {
      struct_item: "struct", enum_item: "enum", trait_item: "trait", type_item: "type",
    };
    if (kinds[node.type]) {
      const name = cleanText(field(node, "name"));
      if (name) symbols.push({ id: `${file}#${name}`, name, qualifiedName: name, kind: kinds[node.type], file, ...location(node), exported: /^pub\b/.test(node.text.trim()) });
      if (node.type === "trait_item") {
        for (const child of field(node, "body")?.namedChildren ?? []) visit(child, name, "trait");
        return;
      }
    }
    if (node.type === "impl_item") {
      const typeName = cleanText(field(node, "type")).match(/[A-Za-z_]\w*/)?.[0];
      const trait = field(node, "trait");
      if (typeName && trait) {
        const text = cleanText(trait);
        references.push(reference(file, `${file}#${typeName}`, trait, "inherit", text, references.length, expressionParts(text)));
      }
      for (const child of field(node, "body")?.namedChildren ?? []) visit(child, typeName, "impl");
      return;
    }
    if (node.type === "function_item") {
      const name = cleanText(field(node, "name"));
      const body = field(node, "body");
      if (!name || !body) return;
      const info = parameterInfo(field(node, "parameters"));
      const qualifiedName = owner ? `${owner}.${name}` : name;
      const id = `${file}#${qualifiedName}`;
      const returnType = field(node, "return_type");
      const hasSelf = info.names.includes("self");
      symbols.push({
        id, name, qualifiedName,
        kind: owner && name === "new" && !hasSelf ? "constructor" : owner ? "method" : "function",
        file, ...location(node), signature: `${name}${cleanText(field(node, "parameters"))}${returnType ? ` -> ${cleanText(returnType)}` : ""}`,
        owner, parameters: info.names, receiverTypes: { self: owner ?? "", ...info.types }, body: range(body), exported: /^pub\b/.test(node.text.trim()),
      });
      references.push(...collectReferences(body, file, id));
      return;
    }
    if (node.type === "function_signature_item" && ownerKind === "trait") return;
    for (const child of node.namedChildren) visit(child, owner, ownerKind);
  };
  for (const child of tree.rootNode.namedChildren) visit(child);
  return { absolutePath, file, language: "rust", source, symbols, imports, references, skeletonEdits, removeTopLevel };
}
