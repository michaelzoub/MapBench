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
import type {
  ImportBinding,
  ParsedFile,
  SourceEdit,
  StructuralReference,
  StructuralSymbol,
} from "../analysis/types.js";
import type { SupportedLanguage } from "../types.js";

const CALLABLE_TYPES = new Set(["function_declaration", "method_definition", "arrow_function", "function_expression"]);

function importBindings(node: SyntaxNode, file: string): ImportBinding[] {
  const source = field(node, "source")?.text.replace(/^['\"]|['\"]$/g, "") ?? "";
  if (!source) return [];
  const statement = node.text;
  const bindings: ImportBinding[] = [];
  const clause = statement.replace(/^\s*import\s+(?:type\s+)?/, "").replace(/\s+from\s+[\s\S]*$/, "").trim();
  const named = clause.match(/\{([\s\S]*?)\}/)?.[1];
  if (named) {
    for (const item of named.split(",")) {
      const match = item.trim().replace(/^type\s+/, "").match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (match) bindings.push({ local: match[2] ?? match[1], imported: match[1], source, file });
    }
  }
  const namespace = clause.match(/\*\s+as\s+([\w$]+)/)?.[1];
  if (namespace) bindings.push({ local: namespace, imported: "*", source, file });
  const defaultName = clause.match(/^([\w$]+)(?:\s*,|$)/)?.[1];
  if (defaultName) bindings.push({ local: defaultName, imported: "default", source, file });
  return bindings;
}

function parameterInfo(parameters: SyntaxNode | undefined): { names: string[]; types: Record<string, string> } {
  const names: string[] = [];
  const types: Record<string, string> = {};
  if (!parameters) return { names, types };
  for (const parameter of parameters.namedChildren) {
    const pattern = field(parameter, "pattern") ?? (parameter.type === "identifier" ? parameter : undefined);
    const name = pattern?.text.match(/[A-Za-z_$][\w$]*/)?.[0];
    if (!name) continue;
    names.push(name);
    const typeNode = field(parameter, "type");
    const typeName = typeNode?.text.replace(/^:\s*/, "").match(/[A-Za-z_$][\w$]*/)?.[0];
    if (typeName) types[name] = typeName;
  }
  return { names, types };
}

function signatureFor(node: SyntaxNode, name: string): string {
  const parameters = field(node, "parameters");
  const returnType = field(node, "return_type");
  if (parameters) return `${name}${maskedDefaults(cleanText(parameters))}${returnType ? cleanText(returnType) : ""}`;
  return `${name}()`;
}

function maskedDefaults(value: string): string {
  return value.replace(/=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,)]+)/g, "= undefined");
}

function isExported(node: SyntaxNode): boolean {
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (current.type === "export_statement") return true;
    if (current.type === "program") break;
  }
  return false;
}

function classReceiverTypes(node: SyntaxNode): Record<string, string> {
  const types: Record<string, string> = {};
  walk(field(node, "body") ?? node, (child) => {
    if (child !== node && (child.type === "class_declaration" || child.type === "class")) return false;
    if (child.type === "method_definition" && cleanText(field(child, "name")) === "constructor") {
      Object.assign(types, parameterInfo(field(child, "parameters")).types);
    }
    if (["public_field_definition", "property_signature"].includes(child.type)) {
      const name = cleanText(field(child, "name"));
      const typeName = field(child, "type")?.text.replace(/^:\s*/, "").match(/[A-Za-z_$][\w$]*/)?.[0];
      if (name && typeName) types[name] = typeName;
    }
  });
  return types;
}

function collectReferences(
  body: SyntaxNode,
  file: string,
  sourceSymbol: string,
): StructuralReference[] {
  const references: StructuralReference[] = [];
  let order = 0;
  walk(body, (node) => {
    if (node !== body && CALLABLE_TYPES.has(node.type)) return false;
    if (node.type === "new_expression") {
      const constructor = field(node, "constructor");
      if (constructor) {
        const text = cleanText(constructor);
        references.push(reference(file, sourceSymbol, node, "construct", text, order++, {
          ...expressionParts(text),
          arguments: identifierArguments(field(node, "arguments")),
        }));
      }
      return;
    }
    if (node.type !== "call_expression") return;
    const expression = field(node, "function");
    if (!expression || expression.type === "super") return;
    const text = cleanText(expression);
    references.push(reference(file, sourceSymbol, node, "call", text, order++, {
      ...expressionParts(text),
      arguments: identifierArguments(field(node, "arguments")),
    }));
  });
  return references;
}

export function extractEcmaFile(
  absolutePath: string,
  file: string,
  language: Extract<SupportedLanguage, "typescript" | "javascript">,
  source: string,
  tree: Parser.Tree,
): ParsedFile {
  const symbols: StructuralSymbol[] = [];
  const references: StructuralReference[] = [];
  const imports: ImportBinding[] = [];
  const skeletonEdits: SourceEdit[] = maskComments(tree.rootNode);
  walk(tree.rootNode, (node) => {
    if (!["optional_parameter", "required_parameter", "assignment_pattern"].includes(node.type)) return;
    const value = field(node, "value") ?? field(node, "right");
    if (value) skeletonEdits.push({ ...range(value), replacement: "undefined" });
  });
  const removeTopLevel = tree.rootNode.namedChildren
    .filter((node) => ["expression_statement", "throw_statement"].includes(node.type))
    .map(range);

  const visit = (node: SyntaxNode, owner?: string, inheritedTypes: Record<string, string> = {}): void => {
    if (node.type === "import_statement") imports.push(...importBindings(node, file));
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const declaration of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
        const name = cleanText(field(declaration, "name"));
        const value = field(declaration, "value");
        if (!name || !value) continue;
        if (value.type === "call_expression" && cleanText(field(value, "function")) === "require") {
          const source = field(value, "arguments")?.namedChildren[0]?.text.replace(/^['\"]|['\"]$/g, "");
          if (source) imports.push({ local: name, imported: "*", source, file });
        }
        if (value.type === "arrow_function" || value.type === "function_expression") {
          const body = field(value, "body");
          if (!body) continue;
          const parameters = parameterInfo(field(value, "parameters"));
          const qualifiedName = owner ? `${owner}.${name}` : name;
          const id = `${file}#${qualifiedName}`;
          const returnType = field(value, "return_type");
          const symbol: StructuralSymbol = {
            id, name, qualifiedName, kind: owner ? "method" : "function", file,
            ...location(value),
            signature: `${name}${maskedDefaults(cleanText(field(value, "parameters")))}${returnType ? cleanText(returnType) : ""}`,
            owner,
            parameters: parameters.names,
            receiverTypes: { ...inheritedTypes, ...parameters.types },
            body: range(body),
            exported: isExported(node),
          };
          symbols.push(symbol);
          references.push(...collectReferences(body, file, id));
        } else {
          skeletonEdits.push({ ...range(value), replacement: "undefined" });
        }
      }
    }

    if (node.type === "class_declaration" || node.type === "class") {
      const name = cleanText(field(node, "name"));
      if (name) {
        const qualifiedName = owner ? `${owner}.${name}` : name;
        const typeId = `${file}#${qualifiedName}`;
        symbols.push({ id: typeId, name, qualifiedName, kind: "class", file, ...location(node), owner, exported: isExported(node) });
        const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
        for (const clause of heritage?.namedChildren ?? []) {
          for (const target of clause.namedChildren) {
            const text = cleanText(target);
            if (text) references.push(reference(file, typeId, target, "inherit", text, references.length, expressionParts(text)));
          }
        }
        const types = classReceiverTypes(node);
        for (const child of field(node, "body")?.namedChildren ?? []) visit(child, qualifiedName, types);
        return;
      }
    }

    const declarationKinds: Record<string, StructuralSymbol["kind"]> = {
      interface_declaration: "interface",
      type_alias_declaration: "type",
      enum_declaration: "enum",
    };
    const declarationKind = declarationKinds[node.type];
    if (declarationKind) {
      const name = cleanText(field(node, "name"));
      if (name) {
        const qualifiedName = owner ? `${owner}.${name}` : name;
        symbols.push({ id: `${file}#${qualifiedName}`, name, qualifiedName, kind: declarationKind, file, ...location(node), owner, exported: isExported(node) });
      }
    }

    if (node.type === "function_declaration" || node.type === "method_definition") {
      const name = cleanText(field(node, "name"));
      const body = field(node, "body");
      if (node.type === "method_definition" && /^(?:get|set)\s/.test(node.text.trim())) {
        if (body) skeletonEdits.push({ ...range(body), replacement: "{ }" });
        return;
      }
      if (name && body) {
        const qualifiedName = owner ? `${owner}.${name}` : name;
        const id = `${file}#${qualifiedName}`;
        const parameters = parameterInfo(field(node, "parameters"));
        const kind = name === "constructor" ? "constructor" : owner ? "method" : "function";
        symbols.push({
          id, name, qualifiedName, kind, file, ...location(node), signature: signatureFor(node, name), owner,
          parameters: parameters.names,
          receiverTypes: { ...inheritedTypes, ...parameters.types },
          body: range(body),
          exported: isExported(node),
        });
        references.push(...collectReferences(body, file, id));
      }
      return;
    }

    if (node.type === "public_field_definition") {
      const value = field(node, "value");
      const name = cleanText(field(node, "name"));
      if (value && name && owner && (value.type === "arrow_function" || value.type === "function_expression")) {
        const body = field(value, "body");
        if (body) {
          const info = parameterInfo(field(value, "parameters"));
          const id = `${file}#${owner}.${name}`;
          const returnType = field(value, "return_type");
          symbols.push({
            id, name, qualifiedName: `${owner}.${name}`, kind: "method", file, ...location(value),
            signature: `${name}${maskedDefaults(cleanText(field(value, "parameters")))}${returnType ? cleanText(returnType) : ""}`,
            owner, parameters: info.names, receiverTypes: { ...inheritedTypes, ...info.types }, body: range(body), exported: isExported(node),
          });
          references.push(...collectReferences(body, file, id));
          return;
        }
      }
      if (value) skeletonEdits.push({ ...range(value), replacement: "undefined" });
    }
    if (node.type === "class_static_block") {
      const body = field(node, "body") ?? node;
      skeletonEdits.push({ start: body.startIndex + 1, end: body.endIndex - 1, replacement: "" });
      return;
    }

    for (const child of node.namedChildren) visit(child, owner, inheritedTypes);
  };

  for (const child of tree.rootNode.namedChildren) visit(child);
  return { absolutePath, file, language, source, symbols, imports, references, skeletonEdits, removeTopLevel };
}
