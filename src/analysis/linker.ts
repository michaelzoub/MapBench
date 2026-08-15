import path from "node:path";
import type { CallGraph, CallGraphEntry } from "../types.js";
import type { ImportBinding, NormalizedProject, ParsedFile, StructuralReference, StructuralSymbol } from "./types.js";
import { compare } from "./utils.js";

const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);
const TYPE_KINDS = new Set(["class", "struct", "interface", "trait", "type", "enum"]);
const BUILTIN_CALLS: Record<ParsedFile["language"], Set<string>> = {
  typescript: new Set(["Boolean", "Number", "String", "Array", "Object", "Map", "Set", "Promise", "Date", "Error", "JSON.parse", "JSON.stringify"]),
  javascript: new Set(["Boolean", "Number", "String", "Array", "Object", "Map", "Set", "Promise", "Date", "Error", "JSON.parse", "JSON.stringify", "require"]),
  python: new Set(["bool", "bytes", "dict", "enumerate", "float", "int", "len", "list", "max", "min", "print", "range", "set", "str", "super", "tuple", "zip"]),
  go: new Set(["append", "cap", "close", "complex", "copy", "delete", "imag", "len", "make", "new", "panic", "print", "println", "real", "recover"]),
  rust: new Set(["Some", "None", "Ok", "Err", "Box::new", "Vec::new", "String::new", "Default::default"]),
};
const BUILTIN_MEMBERS = new Set([
  "at", "charAt", "clear", "concat", "entries", "filter", "find", "forEach", "get", "has", "includes", "join",
  "keys", "length", "lower", "map", "parse", "pop", "push", "replace", "set", "slice", "sort", "split", "strip",
  "substring", "toLowerCase", "toString", "trim", "upper", "values",
  "to_owned",
]);

interface MutableEntry extends CallGraphEntry {
  sourceOrder: string[];
}

function withoutExtension(file: string): string {
  return file.replace(/\.(?:[cm]?[jt]sx?|py|go|rs)$/, "").replace(/\/index$/, "").replace(/\/mod$/, "");
}

interface ModuleIndex {
  stems: Map<string, ParsedFile[]>;
  suffixes: Map<string, ParsedFile[]>;
  goDirectories: Map<string, ParsedFile[]>;
}

function addIndexed(map: Map<string, ParsedFile[]>, key: string, file: ParsedFile): void {
  const files = map.get(key) ?? [];
  files.push(file);
  map.set(key, files);
}

function moduleFiles(index: ModuleIndex, origin: ParsedFile, source: string): ParsedFile[] {
  if (origin.language === "typescript" || origin.language === "javascript") {
    let target: string;
    if (source.startsWith(".")) target = path.posix.normalize(path.posix.join(path.posix.dirname(origin.file), source));
    else if (source.startsWith("@/")) target = `src/${source.slice(2)}`;
    else return [];
    target = withoutExtension(target);
    return index.stems.get(target) ?? [];
  }
  if (origin.language === "python") {
    if (!source.startsWith(".")) {
      const target = source.replace(/\./g, "/");
      return index.suffixes.get(target) ?? [];
    }
    const dots = source.match(/^\.+/)?.[0].length ?? 0;
    const tail = source.slice(dots).replace(/\./g, "/");
    let directory = path.posix.dirname(origin.file);
    for (let index = 1; index < dots; index += 1) directory = path.posix.dirname(directory);
    const target = withoutExtension(path.posix.join(directory, tail));
    return index.stems.get(target) ?? [];
  }
  if (origin.language === "go") {
    const suffix = source.split("/").filter(Boolean).at(-1) ?? source;
    return index.goDirectories.get(suffix) ?? [];
  }
  const parts = source.split("::").filter((part) => !["crate", "self", "super"].includes(part));
  if (!source.startsWith("crate::") && !source.startsWith("self::") && !source.startsWith("super::")) return [];
  const moduleParts = parts.slice(0, -1);
  const target = `src/${moduleParts.join("/")}`;
  return index.stems.get(target) ?? [];
}

function unique(items: readonly StructuralSymbol[]): StructuralSymbol | undefined {
  const ids = new Map(items.map((item) => [item.id, item]));
  return ids.size === 1 ? [...ids.values()][0] : undefined;
}

export function createLinkedCallGraph(project: NormalizedProject): CallGraph {
  const fileByName = new Map(project.files.map((file) => [file.file, file]));
  const moduleIndex: ModuleIndex = { stems: new Map(), suffixes: new Map(), goDirectories: new Map() };
  for (const file of project.files) {
    const stem = withoutExtension(file.file);
    addIndexed(moduleIndex.stems, stem, file);
    const parts = stem.split("/");
    for (let index = 0; index < parts.length; index += 1) addIndexed(moduleIndex.suffixes, parts.slice(index).join("/"), file);
    if (file.language === "go") addIndexed(moduleIndex.goDirectories, path.posix.basename(path.posix.dirname(file.file)), file);
  }
  const callableSymbols = project.symbols.filter((symbol) => CALLABLE_KINDS.has(symbol.kind));
  const typeSymbols = project.symbols.filter((symbol) => TYPE_KINDS.has(symbol.kind));
  const callableById = new Map(callableSymbols.map((symbol) => [symbol.id, symbol]));
  const symbolsByFile = new Map<string, StructuralSymbol[]>();
  for (const symbol of project.symbols) {
    const list = symbolsByFile.get(symbol.file) ?? [];
    list.push(symbol);
    symbolsByFile.set(symbol.file, list);
  }
  const importsByFile = new Map<string, Map<string, ImportBinding>>();
  for (const file of project.files) importsByFile.set(file.file, new Map(file.imports.map((item) => [item.local, item])));

  const entries = new Map<string, MutableEntry>();
  for (const symbol of callableSymbols) {
    entries.set(symbol.id, {
      file: symbol.file,
      line: symbol.startLine,
      column: symbol.startColumn,
      endLine: symbol.endLine,
      endColumn: symbol.endColumn,
      startByte: symbol.startByte,
      endByte: symbol.endByte,
      kind: symbol.kind as CallGraphEntry["kind"],
      signature: symbol.signature ?? `${symbol.name}()`,
      calls: [],
      calledBy: [],
      sourceOrder: [],
    });
  }

  const resolveImported = (origin: ParsedFile, binding: ImportBinding, desired: string, kinds: Set<string>): StructuralSymbol | undefined => {
    const targets = moduleFiles(moduleIndex, origin, binding.source);
    if (!targets.length) return undefined;
    const names = binding.imported === "*" ? [desired] : [binding.imported, desired];
    return unique(targets.flatMap((target) => (symbolsByFile.get(target.file) ?? []).filter(
      (symbol) => kinds.has(symbol.kind) && names.includes(symbol.name),
    )));
  };

  const resolveType = (origin: ParsedFile, name: string): StructuralSymbol | undefined => {
    const clean = name.replace(/^\*/, "").split(/[<[(]/)[0].split("::").at(-1) ?? name;
    const binding = importsByFile.get(origin.file)?.get(clean);
    if (binding) {
      const imported = resolveImported(origin, binding, clean, TYPE_KINDS);
      if (imported) return imported;
    }
    const local = unique((symbolsByFile.get(origin.file) ?? []).filter((symbol) => TYPE_KINDS.has(symbol.kind) && symbol.name === clean));
    if (local) return local;
    if (origin.language === "go") {
      return unique(typeSymbols.filter((symbol) => symbol.name === clean && path.posix.dirname(symbol.file) === path.posix.dirname(origin.file)));
    }
    return unique(typeSymbols.filter((symbol) =>
      symbol.name === clean && fileByName.get(symbol.file)?.language === origin.language));
  };

  const resolveCallable = (
    reference: StructuralReference,
    source: StructuralSymbol,
  ): { symbol?: StructuralSymbol; external?: string; unresolved?: boolean; constructed?: StructuralSymbol } => {
    const origin = fileByName.get(reference.file)!;
    const imports = importsByFile.get(origin.file)!;
    const text = reference.text;
    const root = reference.root ?? text.split(/[.:]/)[0];
    const member = reference.member;
    const binding = imports.get(root);

    if (reference.kind === "construct") {
      const typeName = text === "Self" && source.owner ? source.owner : text;
      const type = binding
        ? resolveImported(origin, binding, root, TYPE_KINDS)
        : resolveType(origin, typeName);
      if (type) return { constructed: type };
      if (binding) return { external: externalName(origin, binding, text, root) };
      return { unresolved: true };
    }

    if (!member && !text.includes("::")) {
      if (BUILTIN_CALLS[origin.language].has(text)) return {};
      if (binding) {
        const target = resolveImported(origin, binding, text, CALLABLE_KINDS);
        if (target) return { symbol: target };
        const type = resolveImported(origin, binding, text, TYPE_KINDS);
        if (type) return { constructed: type };
        return { external: externalName(origin, binding, text, root) };
      }
      const local = unique((symbolsByFile.get(origin.file) ?? []).filter(
        (symbol) => CALLABLE_KINDS.has(symbol.kind) && symbol.name === text && (!symbol.owner || symbol.owner === source.owner),
      ));
      if (local) return { symbol: local };
      const localType = resolveType(origin, text);
      if (localType && (symbolsByFile.get(origin.file) ?? []).some((item) => item.id === localType.id)) return { constructed: localType };
      if (origin.language === "go") {
        const packageTarget = unique(callableSymbols.filter((symbol) =>
          symbol.name === text && path.posix.dirname(symbol.file) === path.posix.dirname(origin.file) && !symbol.owner));
        if (packageTarget) return { symbol: packageTarget };
      }
      if (source.parameters?.includes(text)) return { unresolved: true };
      return {};
    }

    const scoped = text.match(/^([A-Za-z_]\w*)::([A-Za-z_]\w*)$/);
    if (scoped) {
      const type = resolveType(origin, scoped[1]);
      const target = type && unique(callableSymbols.filter((symbol) =>
        symbol.owner === type.name && symbol.name === scoped[2] && fileByName.get(symbol.file)?.language === origin.language));
      if (target) return { symbol: target, ...(scoped[2] === "new" ? { constructed: type } : {}) };
      if (binding) return { external: externalName(origin, binding, text, root) };
    }

    if (binding) {
      const target = resolveImported(origin, binding, member ?? text, CALLABLE_KINDS);
      if (target) return { symbol: target };
      return { external: externalName(origin, binding, text, root) };
    }

    let receiverType: string | undefined;
    if (root === "this" || root === "self") {
      const property = text.match(/^(?:this|self)\.([A-Za-z_$][\w$]*)\./)?.[1];
      receiverType = property ? source.receiverTypes?.[property] : source.owner;
    } else {
      receiverType = source.receiverTypes?.[root];
    }
    if (receiverType && member) {
      const targetType = resolveType(origin, receiverType);
      const ownerName = targetType?.name ?? receiverType;
      const target = unique(callableSymbols.filter((symbol) =>
        symbol.owner === ownerName && symbol.name === member && fileByName.get(symbol.file)?.language === origin.language));
      if (target) return { symbol: target };
    }
    if (member && BUILTIN_MEMBERS.has(member)) return {};
    return { unresolved: true };
  };

  const callbackSites: Array<{ callee: StructuralSymbol; caller: StructuralSymbol; arguments: string[] }> = [];
  for (const reference of project.references) {
    const source = reference.sourceSymbol ? callableById.get(reference.sourceSymbol) : undefined;
    const entry = source && entries.get(source.id);
    if (!source || !entry) continue;
    const resolved = resolveCallable(reference, source);
    if (resolved.symbol) {
      if (!entry.sourceOrder.includes(resolved.symbol.id)) entry.sourceOrder.push(resolved.symbol.id);
      if (reference.arguments?.length) callbackSites.push({ callee: resolved.symbol, caller: source, arguments: reference.arguments });
    }
    if (resolved.constructed) add(entry, "instantiates", resolved.constructed.id);
    if (resolved.external) add(entry, "externalCalls", resolved.external);
    if (resolved.unresolved) add(entry, "unresolvedProjectCalls", reference.text);
  }

  // A callback parameter remains explicitly unresolved, while unambiguous functions
  // supplied at repository call sites also become conservative navigable edges.
  for (const site of callbackSites) {
    const calleeEntry = entries.get(site.callee.id);
    if (!calleeEntry) continue;
    site.arguments.forEach((argument, index) => {
      const parameter = site.callee.parameters?.[index];
      if (!argument || !parameter || !calleeEntry.unresolvedProjectCalls?.includes(parameter)) return;
      const synthetic: StructuralReference = {
        sourceSymbol: site.caller.id, file: site.caller.file, text: argument, kind: "call",
        line: site.caller.startLine, column: site.caller.startColumn, order: 0, root: argument,
      };
      const target = resolveCallable(synthetic, site.caller).symbol;
      if (target && !calleeEntry.sourceOrder.includes(target.id)) calleeEntry.sourceOrder.push(target.id);
    });
  }

  const graph: CallGraph = {};
  for (const [id, entry] of [...entries].sort(([left], [right]) => compare(left, right))) {
    entry.calls = [...new Set(entry.sourceOrder)].sort(compare);
    if (entry.sourceOrder.length && entry.sourceOrder.join("\0") !== entry.calls.join("\0")) {
      entry.callsInSourceOrder = [...entry.sourceOrder];
    }
    entry.instantiates?.sort(compare);
    entry.unresolvedProjectCalls?.sort(compare);
    entry.externalCalls?.sort(compare);
    if (entry.externalCalls) {
      entry.externalCalls = entry.externalCalls.filter((candidate) => !entry.externalCalls!.some((other) =>
        other !== candidate && other.startsWith(`${candidate}().`)));
    }
    graph[id] = {
      file: entry.file,
      line: entry.line,
      column: entry.column,
      endLine: entry.endLine,
      endColumn: entry.endColumn,
      startByte: entry.startByte,
      endByte: entry.endByte,
      kind: entry.kind,
      signature: entry.signature,
      calls: entry.calls,
      ...(entry.callsInSourceOrder ? { callsInSourceOrder: entry.callsInSourceOrder } : {}),
      calledBy: entry.calledBy,
      ...(entry.instantiates?.length ? { instantiates: entry.instantiates } : {}),
      ...(entry.unresolvedProjectCalls?.length ? { unresolvedProjectCalls: entry.unresolvedProjectCalls } : {}),
      ...(entry.externalCalls?.length ? { externalCalls: entry.externalCalls } : {}),
    };
  }
  for (const [caller, entry] of Object.entries(graph)) {
    for (const callee of entry.calls) if (graph[callee] && !graph[callee].calledBy.includes(caller)) graph[callee].calledBy.push(caller);
  }
  for (const entry of Object.values(graph)) entry.calledBy.sort(compare);
  return graph;
}

function add(entry: MutableEntry, key: "instantiates" | "unresolvedProjectCalls" | "externalCalls", value: string): void {
  const values = entry[key] ?? [];
  if (!values.includes(value)) values.push(value);
  entry[key] = values;
}

function externalName(origin: ParsedFile, binding: ImportBinding, text: string, root: string): string {
  const source = binding.source;
  if (origin.language === "typescript" || origin.language === "javascript") return `${source}#${text}`;
  const packageName = origin.language === "go" ? source : source.replace(/^\.+/, "").split(/[.:/]/)[0];
  const member = text.startsWith(`${root}.`) ? text.slice(root.length + 1) : text;
  return `${packageName}#${member}`;
}
