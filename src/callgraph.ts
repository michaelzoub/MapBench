import path from "node:path";
import ts from "typescript";
import type { CallGraph, CallGraphEntry, CallGraphSymbolKind, TypeScriptProjectContext } from "./types.js";

type CallableNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

interface CallableRecord {
  node: CallableNode;
  body: ts.ConciseBody;
  baseName: string;
  id: string;
  kind: CallGraphSymbolKind;
  file: string;
  line: number;
  column: number;
  signature: string;
  symbol?: ts.Symbol;
}

interface NativeClassRecord {
  symbol: ts.Symbol;
  baseName: string;
  file: string;
}

const SIGNATURE_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteTypeArgumentsOfSignature;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function posixRelative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join("/");
}

function propertyName(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function modulePrefix(node: ts.Node): string[] {
  const names: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isModuleDeclaration(current)) names.unshift(current.name.getText(current.getSourceFile()).replace(/["']/g, ""));
  }
  return names;
}

function assignedName(node: ts.FunctionExpression | ts.ArrowFunction): string | undefined {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return propertyName(parent.name);
  if (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) return propertyName(parent.name);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return parent.left.getText(parent.getSourceFile());
  }
  return node.name?.text;
}

function className(node: ts.ClassLikeDeclaration): string | undefined {
  if (node.name) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return undefined;
}

function objectLiteralName(node: ts.ObjectLiteralExpression): string | undefined {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return propertyName(parent.name);
  if (ts.isPropertyAssignment(parent)) {
    const name = propertyName(parent.name);
    const owner = ts.isObjectLiteralExpression(parent.parent) ? objectLiteralName(parent.parent) : undefined;
    return owner && name ? `${owner}.${name}` : name;
  }
  return undefined;
}

function callableName(node: CallableNode): string | undefined {
  const prefix = modulePrefix(node);
  if (ts.isConstructorDeclaration(node)) {
    const owner = className(node.parent);
    return owner ? [...prefix, owner, "constructor"].join(".") : undefined;
  }
  if (ts.isMethodDeclaration(node)) {
    const name = propertyName(node.name);
    if (!name) return undefined;
    if (ts.isClassLike(node.parent)) {
      const owner = className(node.parent);
      return owner ? [...prefix, owner, name].join(".") : undefined;
    }
    const owner = ts.isObjectLiteralExpression(node.parent) ? objectLiteralName(node.parent) : undefined;
    return [...prefix, ...(owner ? [owner] : []), name].join(".");
  }
  if (ts.isFunctionDeclaration(node)) return node.name ? [...prefix, node.name.text].join(".") : undefined;
  const name = assignedName(node);
  if (!name) return undefined;
  if (ts.isPropertyDeclaration(node.parent) && ts.isClassLike(node.parent.parent)) {
    const owner = className(node.parent.parent);
    return owner ? [...prefix, owner, name].join(".") : undefined;
  }
  if (ts.isPropertyAssignment(node.parent) && ts.isObjectLiteralExpression(node.parent.parent)) {
    const owner = objectLiteralName(node.parent.parent);
    return [...prefix, ...(owner ? [owner] : []), name].join(".");
  }
  return [...prefix, name].join(".");
}

function callableKind(node: CallableNode): CallGraphSymbolKind {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) {
    return "method";
  }
  return "function";
}

function symbolForCallable(checker: ts.TypeChecker, node: CallableNode): ts.Symbol | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name ? checker.getSymbolAtLocation(node.name) : undefined;
  }
  if (ts.isConstructorDeclaration(node)) return node.parent.name ? checker.getSymbolAtLocation(node.parent.name) : undefined;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    return checker.getSymbolAtLocation(parent.name);
  }
  return node.name ? checker.getSymbolAtLocation(node.name) : undefined;
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    try {
      current = checker.getAliasedSymbol(current);
    } catch {
      break;
    }
  }
  return current;
}

function formatSignature(checker: ts.TypeChecker, recordName: string, node: CallableNode): string {
  const signature = checker.getSignatureFromDeclaration(node);
  const leafName = recordName.slice(recordName.lastIndexOf(".") + 1);
  if (!signature) return `${leafName}()`;
  const text = checker.signatureToString(signature, node, SIGNATURE_FLAGS, ts.SignatureKind.Call);
  if (!ts.isConstructorDeclaration(node)) return `${leafName}${text}`;

  const parameterStart = text.indexOf("(");
  let depth = 0;
  for (let index = parameterStart; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return `constructor${text.slice(parameterStart, index + 1)}`;
    }
  }
  return `constructor${text}`;
}

function isCallableWithBody(node: ts.Node): node is CallableNode {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)) &&
    Boolean(node.body)
  );
}

function expressionText(expression: ts.Expression): string {
  return expression.getText(expression.getSourceFile()).replace(/\s+/g, " ").trim();
}

function symbolAtExpression(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) return checker.getSymbolAtLocation(expression.name);
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return checker.getSymbolAtLocation(expression.argumentExpression);
  }
  return checker.getSymbolAtLocation(expression);
}

function leftmostIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return leftmostIdentifier(expression.expression);
  }
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) return leftmostIdentifier(expression.expression);
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) {
    return leftmostIdentifier(expression.expression);
  }
  return undefined;
}

function importedModule(checker: ts.TypeChecker, expression: ts.Expression): string | undefined {
  const root = leftmostIdentifier(expression);
  if (!root) return undefined;
  const symbol = checker.getSymbolAtLocation(root);
  for (const declaration of symbol?.declarations ?? []) {
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isImportDeclaration(current) && !ts.isImportEqualsDeclaration(current)) current = current.parent;
    if (current && ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
      const module = current.moduleSpecifier.text;
      return module.startsWith(".") ? undefined : module;
    }
    if (current && ts.isImportEqualsDeclaration(current) && ts.isExternalModuleReference(current.moduleReference) &&
      current.moduleReference.expression && ts.isStringLiteral(current.moduleReference.expression)) {
      const module = current.moduleReference.expression.text;
      return module.startsWith(".") ? undefined : module;
    }
  }
  return undefined;
}

function compactExternalCalls(calls: Set<string>): string[] {
  const sorted = [...calls].sort(compare);
  return sorted.filter((candidate) => !sorted.some((other) =>
    other !== candidate && other.startsWith(`${candidate}().`)));
}

export function createCallGraph(context: TypeScriptProjectContext): CallGraph {
  const checker = context.program.getTypeChecker();
  const nativeFiles = new Set(context.fileNames.map((fileName) => path.resolve(fileName)));
  const records: CallableRecord[] = [];
  const classes: NativeClassRecord[] = [];

  for (const fileName of context.fileNames) {
    const sourceFile = context.program.getSourceFile(fileName);
    if (!sourceFile) continue;
    const file = posixRelative(context.root, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const name = className(node);
        const symbol = canonicalSymbol(checker, node.name ? checker.getSymbolAtLocation(node.name) : undefined);
        if (name && symbol) classes.push({
          symbol,
          baseName: [...modulePrefix(node), name].join("."),
          file,
        });
      }
      if (isCallableWithBody(node)) {
        const baseName = callableName(node);
        if (baseName) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          records.push({
            node,
            body: node.body!,
            baseName,
            id: baseName,
            kind: callableKind(node),
            file,
            line: location.line + 1,
            column: location.character + 1,
            signature: "",
            symbol: canonicalSymbol(checker, symbolForCallable(checker, node)),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const classSymbols = new Map<ts.Symbol, string>();
  for (const record of classes) {
    classSymbols.set(record.symbol, `${record.file}#${record.baseName}`);
  }
  for (const record of records) {
    record.id = `${record.file}#${record.baseName}`;
    record.signature = formatSignature(checker, record.baseName, record.node);
  }
  records.sort((left, right) => compare(left.id, right.id));

  const recordByNode = new Map<ts.Node, CallableRecord>();
  const recordsBySymbol = new Map<ts.Symbol, Set<CallableRecord>>();
  const addSymbolRecord = (symbol: ts.Symbol | undefined, record: CallableRecord): void => {
    const canonical = canonicalSymbol(checker, symbol);
    if (!canonical) return;
    const existing = recordsBySymbol.get(canonical) ?? new Set<CallableRecord>();
    existing.add(record);
    recordsBySymbol.set(canonical, existing);
  };
  for (const record of records) {
    recordByNode.set(record.node, record);
    addSymbolRecord(record.symbol, record);
    for (const declaration of record.symbol?.declarations ?? []) recordByNode.set(declaration, record);
  }

  const isNativeDeclaration = (declaration: ts.Declaration | undefined): boolean =>
    Boolean(declaration && nativeFiles.has(path.resolve(declaration.getSourceFile().fileName)));

  const resolveCallable = (expression: ts.Expression, includeResolvedSignature = true): { records: Set<CallableRecord>; native: boolean; external: boolean } => {
    const matches = new Set<CallableRecord>();
    let native = false;
    let external = false;
    const inspectDeclaration = (declaration: ts.Declaration | undefined): void => {
      if (!declaration) return;
      const record = recordByNode.get(declaration);
      if (record) matches.add(record);
      if (isNativeDeclaration(declaration)) native = true;
      else external = true;
    };

    const symbol = canonicalSymbol(checker, symbolAtExpression(checker, expression));
    for (const record of recordsBySymbol.get(symbol!) ?? []) matches.add(record);
    for (const declaration of symbol?.declarations ?? []) inspectDeclaration(declaration);

    try {
      if (includeResolvedSignature) {
        const signature = checker.getResolvedSignature(expression.parent as ts.CallExpression);
        inspectDeclaration(signature?.declaration);
      }
      for (const candidate of checker.getTypeAtLocation(expression).getCallSignatures()) inspectDeclaration(candidate.declaration);
    } catch {
      native = true;
    }
    return { records: matches, native, external };
  };

  const resolveClass = (expression: ts.Expression): { names: Set<string>; native: boolean; external: boolean } => {
    const names = new Set<string>();
    let native = false;
    let external = false;
    const inspectSymbol = (input: ts.Symbol | undefined): void => {
      const symbol = canonicalSymbol(checker, input);
      if (!symbol) return;
      const name = classSymbols.get(symbol);
      if (name) names.add(name);
      for (const declaration of symbol.declarations ?? []) {
        if (isNativeDeclaration(declaration)) native = true;
        else external = true;
      }
    };
    inspectSymbol(symbolAtExpression(checker, expression));
    try {
      for (const signature of checker.getTypeAtLocation(expression).getConstructSignatures()) {
        const declaration = signature.declaration as ts.Node | undefined;
        const owner = declaration && ts.isConstructorDeclaration(declaration)
          ? declaration.parent
          : declaration && ts.isClassLike(declaration)
            ? declaration
            : undefined;
        inspectSymbol(owner?.name ? checker.getSymbolAtLocation(owner.name) : undefined);
        if (signature.declaration) {
          if (isNativeDeclaration(signature.declaration)) native = true;
          else external = true;
        }
      }
    } catch {
      native = true;
    }
    return { names, native, external };
  };

  const entries = new Map<string, CallGraphEntry>();
  for (const record of records) {
    entries.set(record.id, {
      file: record.file,
      line: record.line,
      column: record.column,
      kind: record.kind,
      signature: record.signature,
      calls: [],
      calledBy: [],
    });
  }

  const invokedParameterIndexes = new Map<CallableRecord, number[]>();
  for (const record of records) {
    const parameterSymbols = record.node.parameters.map((parameter) =>
      canonicalSymbol(checker, checker.getSymbolAtLocation(parameter.name)));
    const invoked = new Set<number>();
    const visit = (node: ts.Node): void => {
      if (node !== record.node && isCallableWithBody(node) && recordByNode.has(node)) return;
      if (ts.isCallExpression(node)) {
        const symbol = canonicalSymbol(checker, symbolAtExpression(checker, node.expression));
        const index = parameterSymbols.findIndex((parameter) => parameter !== undefined && parameter === symbol);
        if (index >= 0) invoked.add(index);
      }
      ts.forEachChild(node, visit);
    };
    visit(record.body);
    invokedParameterIndexes.set(record, [...invoked].sort((left, right) => left - right));
  }

  const callbackTargets = new Map<CallableRecord, Set<string>>();

  for (const record of records) {
    const calls = new Set<string>();
    const callsInSourceOrder: string[] = [];
    const constructs = new Set<string>();
    const unresolved = new Set<string>();
    const external = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (node !== record.node && isCallableWithBody(node) && recordByNode.has(node)) return;
      if (ts.isCallExpression(node)) {
        const resolved = resolveCallable(node.expression);
        if (resolved.records.size === 1) {
          const callee = [...resolved.records][0];
          calls.add(callee.id);
          if (!callsInSourceOrder.includes(callee.id)) callsInSourceOrder.push(callee.id);
          for (const parameterIndex of invokedParameterIndexes.get(callee) ?? []) {
            const argument = node.arguments[parameterIndex];
            if (!argument || ts.isSpreadElement(argument)) continue;
            const callback = resolveCallable(argument, false);
            if (callback.records.size === 0) continue;
            const targets = callbackTargets.get(callee) ?? new Set<string>();
            for (const target of callback.records) targets.add(target.id);
            callbackTargets.set(callee, targets);
          }
        }
        else if (resolved.records.size > 1 || resolved.native) unresolved.add(expressionText(node.expression));
        else {
          const module = importedModule(checker, node.expression);
          if (module) external.add(`${module}#${expressionText(node.expression)}`);
          else if (!resolved.external) unresolved.add(expressionText(node.expression));
        }
      } else if (ts.isNewExpression(node)) {
        const resolved = resolveClass(node.expression);
        if (resolved.names.size === 1) constructs.add([...resolved.names][0]);
        else if (resolved.names.size > 1 || resolved.native) unresolved.add(`new ${expressionText(node.expression)}`);
        else {
          const module = importedModule(checker, node.expression);
          if (module) external.add(`${module}#new ${expressionText(node.expression)}`);
          else if (!resolved.external) unresolved.add(`new ${expressionText(node.expression)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(record.body);
    const entry = entries.get(record.id)!;
    entry.calls = [...calls].sort(compare);
    if (callsInSourceOrder.some((callee, index) => callee !== entry.calls[index])) {
      entry.callsInSourceOrder = callsInSourceOrder;
    }
    if (constructs.size) entry.instantiates = [...constructs].sort(compare);
    if (unresolved.size) entry.unresolvedProjectCalls = [...unresolved].sort(compare);
    const externalCalls = compactExternalCalls(external);
    if (externalCalls.length) entry.externalCalls = externalCalls;
  }

  for (const [record, targets] of callbackTargets) {
    const entry = entries.get(record.id)!;
    const sequence = entry.callsInSourceOrder ?? [...entry.calls];
    entry.calls = [...new Set([...entry.calls, ...targets])].sort(compare);
    for (const target of targets) {
      if (!sequence.includes(target)) sequence.push(target);
    }
    entry.callsInSourceOrder = sequence.some((callee, index) => callee !== entry.calls[index]) ? sequence : undefined;
  }

  for (const [caller, entry] of entries) {
    for (const callee of entry.calls) entries.get(callee)?.calledBy.push(caller);
  }
  for (const entry of entries.values()) entry.calledBy.sort(compare);

  const graph: CallGraph = {};
  for (const [id, entry] of [...entries].sort(([left], [right]) => compare(left, right))) graph[id] = entry;
  return graph;
}

export function serializeCallGraph(context: TypeScriptProjectContext): string {
  return `${JSON.stringify(createCallGraph(context), null, 2)}\n`;
}
