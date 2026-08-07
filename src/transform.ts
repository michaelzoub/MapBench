import path from "node:path";
import ts from "typescript";
import { GENERATED_HEADER, isInside } from "./files.js";
import type { CallGraph, CallGraphEntry, CallGraphSymbolKind, TypeScriptProjectContext } from "./types.js";

const TYPE_NODE_FLAGS =
  ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
  ts.NodeBuilderFlags.AllowThisInObjectLiteral;

function isJavaScriptFile(fileName: string): boolean {
  return [".js", ".jsx", ".cjs", ".mjs"].includes(path.extname(fileName).toLowerCase());
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function typeFor(checker: ts.TypeChecker, node: ts.Node): ts.TypeNode | undefined {
  if (isJavaScriptFile(node.getSourceFile().fileName)) return undefined;
  try {
    return checker.typeToTypeNode(checker.getTypeAtLocation(node), node, TYPE_NODE_FLAGS) ?? undefined;
  } catch {
    return undefined;
  }
}

function returnTypeFor(checker: ts.TypeChecker, node: ts.SignatureDeclaration): ts.TypeNode | undefined {
  if (isJavaScriptFile(node.getSourceFile().fileName)) return undefined;
  try {
    const signature = checker.getSignatureFromDeclaration(node);
    return signature
      ? checker.typeToTypeNode(checker.getReturnTypeOfSignature(signature), node, TYPE_NODE_FLAGS) ?? undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function stripBindingName(factory: ts.NodeFactory, name: ts.BindingName): ts.BindingName {
  if (ts.isIdentifier(name)) return name;
  const stripElement = (element: ts.BindingElement): ts.BindingElement => {
    return factory.updateBindingElement(
      element,
      element.dotDotDotToken,
      element.propertyName,
      stripBindingName(factory, element.name),
      undefined,
    );
  };
  if (ts.isObjectBindingPattern(name)) {
    return factory.updateObjectBindingPattern(name, name.elements.map(stripElement));
  }
  const elements = name.elements.map((element) => {
    if (ts.isOmittedExpression(element)) return element;
    return stripElement(element);
  });
  return factory.updateArrayBindingPattern(name, elements);
}

function stripParameter(
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
  javaScript = false,
): ts.ParameterDeclaration {
  const optionalToken = javaScript ? undefined : parameter.questionToken ??
    (parameter.initializer && !parameter.dotDotDotToken ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined);
  return factory.updateParameterDeclaration(
    parameter,
    parameter.modifiers,
    parameter.dotDotDotToken,
    stripBindingName(factory, parameter.name),
    optionalToken,
    parameter.type ?? typeFor(checker, parameter),
    javaScript && parameter.initializer ? factory.createIdentifier("undefined") : undefined,
  );
}

function callGraphEntry(
  graph: CallGraph,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  kinds: readonly CallGraphSymbolKind[],
): CallGraphEntry | undefined {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return Object.values(graph).find((entry) =>
    entry.line === location.line + 1 && entry.column === location.character + 1 && kinds.includes(entry.kind));
}

function summaryBlock(factory: ts.NodeFactory, entry: CallGraphEntry | undefined): ts.Block {
  const parts: string[] = [];
  const add = (label: string, values: readonly string[]): void => {
    if (values.length) parts.push(`${label}: ${values.join(", ")}`);
  };
  add("Calls", entry?.callsInSourceOrder ?? entry?.calls ?? []);
  add("Instantiates", entry?.instantiates ?? []);
  add("Unresolved project", entry?.unresolvedProjectCalls ?? []);
  add("External", entry?.externalCalls ?? []);
  const statements = parts.length
    ? [factory.createExpressionStatement(factory.createStringLiteral(parts.join("; ")))]
    : [];
  return factory.createBlock(statements, statements.length > 0);
}

function outlineFunctionExpression(
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  node: ts.ArrowFunction | ts.FunctionExpression,
  javaScript: boolean,
  entry: CallGraphEntry | undefined,
): ts.ArrowFunction | ts.FunctionExpression {
  const parameters = node.parameters.map((parameter) => stripParameter(factory, checker, parameter, javaScript));
  const body = summaryBlock(factory, entry);
  if (ts.isArrowFunction(node)) {
    return factory.updateArrowFunction(node, node.modifiers, node.typeParameters, parameters,
      node.type ?? returnTypeFor(checker, node), node.equalsGreaterThanToken, body);
  }
  return factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters,
    parameters, node.type ?? returnTypeFor(checker, node), body);
}

function createLocalModulePredicate(context: TypeScriptProjectContext, containingFile: string): (specifier: string) => boolean {
  const cache = ts.createModuleResolutionCache(context.root, (value) => value, context.compilerOptions);
  return (specifier: string): boolean => {
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
      return isInside(context.root, path.resolve(path.dirname(containingFile), specifier));
    }
    const resolved = ts.resolveModuleName(specifier, containingFile, context.compilerOptions, ts.sys, cache).resolvedModule;
    return Boolean(resolved && isInside(context.root, path.resolve(resolved.resolvedFileName)) && !resolved.resolvedFileName.includes(`${path.sep}node_modules${path.sep}`));
  };
}

function transformModuleBlock(
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  block: ts.ModuleBlock,
  javaScript: boolean,
  graph: CallGraph,
): ts.ModuleBlock {
  const statements = block.statements.flatMap((statement) => transformStatement(factory, checker, statement, () => true, javaScript, graph));
  return factory.updateModuleBlock(block, statements);
}

function transformClassMember(
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  member: ts.ClassElement,
  javaScript: boolean,
  graph: CallGraph,
): ts.ClassElement | undefined {
  if (ts.isPropertyDeclaration(member)) {
    const initializer = member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
      ? outlineFunctionExpression(factory, checker, member.initializer, javaScript,
        callGraphEntry(graph, member.getSourceFile(), member.initializer, ["method"]))
      : undefined;
    return factory.updatePropertyDeclaration(
      member,
      member.modifiers,
      member.name,
      member.questionToken ?? member.exclamationToken,
      member.type ?? typeFor(checker, member),
      initializer,
    );
  }
  if (ts.isConstructorDeclaration(member)) {
    return factory.updateConstructorDeclaration(
      member,
      member.modifiers,
      member.parameters.map((parameter) => stripParameter(factory, checker, parameter, javaScript)),
      member.body ? summaryBlock(factory, callGraphEntry(graph, member.getSourceFile(), member, ["constructor"])) : undefined,
    );
  }
  if (ts.isMethodDeclaration(member)) {
    return factory.updateMethodDeclaration(
      member,
      member.modifiers,
      member.asteriskToken,
      member.name,
      member.questionToken,
      member.typeParameters,
      member.parameters.map((parameter) => stripParameter(factory, checker, parameter, javaScript)),
      member.type ?? returnTypeFor(checker, member),
      member.body ? summaryBlock(factory, callGraphEntry(graph, member.getSourceFile(), member, ["method"])) : undefined,
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return factory.updateGetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters.map((parameter) => stripParameter(factory, checker, parameter, javaScript)),
      member.type ?? returnTypeFor(checker, member),
      member.body ? factory.createBlock([], false) : undefined,
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return factory.updateSetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters.map((parameter) => stripParameter(factory, checker, parameter, javaScript)),
      member.body ? factory.createBlock([], false) : undefined,
    );
  }
  if (ts.isClassStaticBlockDeclaration(member)) return undefined;
  return member;
}

function transformStatement(
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  statement: ts.Statement,
  isLocalModule: (specifier: string) => boolean,
  javaScript: boolean,
  graph: CallGraph,
): ts.Statement[] {
  if (ts.isImportDeclaration(statement)) {
    return ts.isStringLiteral(statement.moduleSpecifier) && isLocalModule(statement.moduleSpecifier.text) ? [statement] : [];
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    const reference = statement.moduleReference;
    return ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteral(reference.expression) && isLocalModule(reference.expression.text)
      ? [statement]
      : [];
  }
  if (ts.isExportDeclaration(statement)) {
    if (!statement.moduleSpecifier) return [statement];
    return ts.isStringLiteral(statement.moduleSpecifier) && isLocalModule(statement.moduleSpecifier.text) ? [statement] : [];
  }
  if (ts.isClassDeclaration(statement)) {
    const members = statement.members
      .map((member) => transformClassMember(factory, checker, member, javaScript, graph))
      .filter((member): member is ts.ClassElement => Boolean(member));
    return [factory.updateClassDeclaration(statement, statement.modifiers, statement.name, statement.typeParameters, statement.heritageClauses, members)];
  }
  if (ts.isFunctionDeclaration(statement)) {
    return [factory.updateFunctionDeclaration(
      statement,
      statement.modifiers,
      statement.asteriskToken,
      statement.name,
      statement.typeParameters,
      statement.parameters.map((parameter) => stripParameter(factory, checker, parameter, javaScript)),
      statement.type ?? returnTypeFor(checker, statement),
      statement.body ? summaryBlock(factory, callGraphEntry(graph, statement.getSourceFile(), statement, ["function"])) : undefined,
    )];
  }
  if (ts.isVariableStatement(statement)) {
    if (!isExported(statement) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return [];
    const declarations = statement.declarationList.declarations.map((declaration) => {
      const callable = declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer));
      return factory.updateVariableDeclaration(
        declaration,
        stripBindingName(factory, declaration.name),
        declaration.exclamationToken,
        callable ? declaration.type : declaration.type ?? typeFor(checker, declaration),
        callable ? outlineFunctionExpression(factory, checker, declaration.initializer as ts.ArrowFunction | ts.FunctionExpression,
          javaScript, callGraphEntry(graph, statement.getSourceFile(), declaration.initializer!, ["function", "method"]))
          : javaScript ? factory.createIdentifier("undefined") : undefined,
      );
    });
    const hasCallable = declarations.some((declaration) => declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)));
    const modifiers = javaScript || hasCallable
      ? statement.modifiers
      : statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
      ? statement.modifiers
      : factory.createNodeArray([...(statement.modifiers ?? []), factory.createModifier(ts.SyntaxKind.DeclareKeyword)]);
    return [factory.updateVariableStatement(statement, modifiers, factory.updateVariableDeclarationList(statement.declarationList, declarations))];
  }
  if (ts.isModuleDeclaration(statement)) {
    let body = statement.body;
    if (body && ts.isModuleBlock(body)) body = transformModuleBlock(factory, checker, body, javaScript, graph);
    return [factory.updateModuleDeclaration(statement, statement.modifiers, statement.name, body)];
  }
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  ) return [statement];
  if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) return [statement];
  return [];
}

export function outlineSourceFile(sourceFile: ts.SourceFile, context: TypeScriptProjectContext, graph: CallGraph = {}): string {
  const checker = context.program.getTypeChecker();
  const isLocalModule = createLocalModulePredicate(context, sourceFile.fileName);
  const javaScript = isJavaScriptFile(sourceFile.fileName);
  const relative = path.relative(context.root, sourceFile.fileName).split(path.sep).join("/");
  const fileGraph = Object.fromEntries(Object.entries(graph).filter(([, entry]) => entry.file === relative));
  const result = ts.transform(sourceFile, [
    (transformationContext) => (rootNode) => {
      const statements = rootNode.statements.flatMap((statement) =>
        transformStatement(transformationContext.factory, checker, statement, isLocalModule, javaScript, fileGraph));
      return transformationContext.factory.updateSourceFile(rootNode, statements);
    },
  ]);

  const transformed = result.transformed[0];
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const printed = transformed.statements
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile).trim())
    .filter(Boolean)
    .join("\n\n");
  result.dispose();
  return `${GENERATED_HEADER}\n${printed ? `\n${printed}\n` : ""}`;
}
