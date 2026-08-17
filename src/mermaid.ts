import path from "node:path";
import type { CallGraph } from "./types.js";

export const MERMAID_HEADER = "%% @cartograph generated";

const MAX_MODULES = 24;
const MAX_PROJECT_EDGES = 32;
const MAX_EXTERNAL_DEPENDENCIES = 6;
const MAX_EXTERNAL_EDGES = 10;

interface ModuleRecord {
  file: string;
  callables: number;
  types: number;
  entry: boolean;
  neighbors: Set<string>;
  relationships: number;
}

interface ProjectRelationship {
  source: string;
  target: string;
  calls: number;
  instantiates: number;
}

interface ExternalRelationship {
  source: string;
  target: string;
  uses: number;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function symbolFile(id: string): string | undefined {
  const separator = id.lastIndexOf("#");
  return separator > 0 ? id.slice(0, separator) : undefined;
}

function externalPackage(id: string): string {
  const separator = id.indexOf("#");
  return separator < 0 ? id : id.slice(0, separator);
}

function relationshipKey(source: string, target: string): string {
  return `${source}\0${target}`;
}

function mermaidText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectImportant<T>(
  items: readonly T[],
  limit: number,
  score: (item: T) => number,
  name: (item: T) => string,
): T[] {
  if (items.length <= limit) return [...items].sort((left, right) => compare(name(left), name(right)));
  return [...items]
    .sort((left, right) => score(right) - score(left) || compare(name(left), name(right)))
    .slice(0, limit)
    .sort((left, right) => compare(name(left), name(right)));
}

function projectEdgeLabel(edge: ProjectRelationship): string {
  const labels: string[] = [];
  if (edge.calls) labels.push(`${edge.calls === 1 ? "calls" : `${edge.calls} calls`}`);
  if (edge.instantiates) labels.push(`${edge.instantiates === 1 ? "creates" : `${edge.instantiates} creates`}`);
  return labels.join(" · ");
}

/**
 * Create a bounded, deterministic module-level Mermaid view from the same call
 * graph used by the other generated architecture artifacts.
 */
export function createArchitectureMermaid(graph: CallGraph): string {
  const modules = new Map<string, ModuleRecord>();
  const projectRelationships = new Map<string, ProjectRelationship>();
  const externalRelationships = new Map<string, ExternalRelationship>();

  const ensureModule = (file: string): ModuleRecord => {
    const existing = modules.get(file);
    if (existing) return existing;
    const created: ModuleRecord = {
      file,
      callables: 0,
      types: 0,
      entry: false,
      neighbors: new Set<string>(),
      relationships: 0,
    };
    modules.set(file, created);
    return created;
  };

  const addProjectRelationship = (
    source: string,
    target: string,
    kind: "calls" | "instantiates",
  ): void => {
    if (source === target) return;
    const key = relationshipKey(source, target);
    const relationship = projectRelationships.get(key) ?? { source, target, calls: 0, instantiates: 0 };
    relationship[kind] += 1;
    projectRelationships.set(key, relationship);
    const sourceModule = ensureModule(source);
    const targetModule = ensureModule(target);
    sourceModule.neighbors.add(target);
    targetModule.neighbors.add(source);
    sourceModule.relationships += 1;
    targetModule.relationships += 1;
  };

  for (const id of Object.keys(graph).sort(compare)) {
    const entry = graph[id];
    const source = entry.file;
    const sourceModule = ensureModule(source);
    if (entry.kind === "function" || entry.kind === "method" || entry.kind === "constructor") {
      sourceModule.callables += 1;
    } else {
      sourceModule.types += 1;
    }
    if (
      entry.kind !== "function" &&
      entry.kind !== "method" &&
      entry.kind !== "constructor"
    ) continue;
    if (entry.calledBy.length === 0 && (entry.calls.length > 0 || (entry.instantiates?.length ?? 0) > 0)) {
      sourceModule.entry = true;
    }

    for (const callee of entry.calls) {
      const target = graph[callee]?.file;
      if (target) addProjectRelationship(source, target, "calls");
    }
    for (const instantiated of entry.instantiates ?? []) {
      const target = symbolFile(instantiated);
      if (target) addProjectRelationship(source, target, "instantiates");
    }
    for (const externalCall of entry.externalCalls ?? []) {
      const target = externalPackage(externalCall);
      if (!target) continue;
      const key = relationshipKey(source, target);
      const relationship = externalRelationships.get(key) ?? { source, target, uses: 0 };
      relationship.uses += 1;
      externalRelationships.set(key, relationship);
    }
  }

  const allModules = [...modules.values()];
  const selectedModules = selectImportant(
    allModules,
    MAX_MODULES,
    (module) => (module.entry && module.neighbors.size ? 150 : 0) +
      module.neighbors.size * 100 + module.relationships * 10 + module.callables + module.types,
    (module) => module.file,
  );
  const selectedFiles = new Set(selectedModules.map((module) => module.file));

  const eligibleProjectEdges = [...projectRelationships.values()].filter(
    (edge) => selectedFiles.has(edge.source) && selectedFiles.has(edge.target),
  );
  const selectedProjectEdges = selectImportant(
    eligibleProjectEdges,
    MAX_PROJECT_EDGES,
    (edge) => (edge.calls + edge.instantiates) * 10 + (modules.get(edge.source)?.entry ? 1 : 0),
    (edge) => relationshipKey(edge.source, edge.target),
  );

  const eligibleExternalEdges = [...externalRelationships.values()].filter((edge) => selectedFiles.has(edge.source));
  const packageUseCounts = new Map<string, number>();
  for (const edge of eligibleExternalEdges) {
    packageUseCounts.set(edge.target, (packageUseCounts.get(edge.target) ?? 0) + edge.uses);
  }
  const selectedDependencies = selectImportant(
    [...packageUseCounts],
    MAX_EXTERNAL_DEPENDENCIES,
    ([, uses]) => uses,
    ([name]) => name,
  ).map(([name]) => name);
  const selectedDependencySet = new Set(selectedDependencies);
  const selectedExternalEdges = selectImportant(
    eligibleExternalEdges.filter((edge) => selectedDependencySet.has(edge.target)),
    MAX_EXTERNAL_EDGES,
    (edge) => edge.uses,
    (edge) => relationshipKey(edge.source, edge.target),
  );
  const renderedDependencies = new Set(selectedExternalEdges.map((edge) => edge.target));
  const allDependencies = new Set([...externalRelationships.values()].map((edge) => edge.target));

  const moduleIds = new Map(selectedModules.map((module, index) => [module.file, `module_${index}`]));
  const dependencyIds = new Map(
    [...renderedDependencies].sort(compare).map((dependency, index) => [dependency, `dependency_${index}`]),
  );
  const directories = new Map<string, ModuleRecord[]>();
  for (const module of selectedModules) {
    const directory = path.posix.dirname(module.file);
    const members = directories.get(directory) ?? [];
    members.push(module);
    directories.set(directory, members);
  }

  const lines = [
    MERMAID_HEADER,
    "%% Deterministic module-level view derived from the generated static call graph.",
    "flowchart LR",
  ];

  if (!selectedModules.length) {
    lines.push('  empty["No callable modules detected"]', "");
    return lines.join("\n");
  }

  [...directories].sort(([left], [right]) => compare(left, right)).forEach(([directory, members], index) => {
    lines.push(`  subgraph group_${index}["${mermaidText(directory === "." ? "repository root" : directory)}"]`);
    lines.push("    direction TB");
    for (const module of members.sort((left, right) => compare(left.file, right.file))) {
      const details = [
        module.callables ? `${module.callables} callable${module.callables === 1 ? "" : "s"}` : "",
        module.types ? `${module.types} type declaration${module.types === 1 ? "" : "s"}` : "",
        module.entry ? "entry" : "",
      ].filter(Boolean).join(" · ") || "no declarations";
      lines.push(`    ${moduleIds.get(module.file)}["${mermaidText(path.posix.basename(module.file))}<br/>${details}"]`);
    }
    lines.push("  end");
  });

  if (renderedDependencies.size) {
    lines.push('  subgraph dependencies["External dependencies"]', "    direction TB");
    for (const dependency of [...renderedDependencies].sort(compare)) {
      lines.push(`    ${dependencyIds.get(dependency)}(["${mermaidText(dependency)}"])`);
    }
    lines.push("  end");
  }

  for (const edge of selectedProjectEdges) {
    const connector = edge.calls ? "-->" : "-.->";
    lines.push(`  ${moduleIds.get(edge.source)} ${connector}|${projectEdgeLabel(edge)}| ${moduleIds.get(edge.target)}`);
  }
  for (const edge of selectedExternalEdges) {
    const label = edge.uses === 1 ? "uses" : `${edge.uses} uses`;
    lines.push(`  ${moduleIds.get(edge.source)} -.->|${label}| ${dependencyIds.get(edge.target)}`);
  }

  const omittedModules = allModules.length - selectedModules.length;
  const omittedProjectEdges = projectRelationships.size - selectedProjectEdges.length;
  const omittedDependencies = allDependencies.size - renderedDependencies.size;
  const omissionParts = [
    omittedModules ? `${omittedModules} module${omittedModules === 1 ? "" : "s"}` : "",
    omittedProjectEdges ? `${omittedProjectEdges} internal relationship${omittedProjectEdges === 1 ? "" : "s"}` : "",
    omittedDependencies ? `${omittedDependencies} external dependenc${omittedDependencies === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean);
  if (omissionParts.length) {
    lines.push(`  omitted["… ${omissionParts.join(", ")} omitted for readability"]`);
    lines.push("  class omitted omitted");
  }

  const entries = selectedModules.filter((module) => module.entry).map((module) => moduleIds.get(module.file));
  lines.push(
    "  classDef entry fill:#dbeafe,stroke:#2563eb,stroke-width:2px",
    "  classDef omitted fill:#f8fafc,stroke:#94a3b8,stroke-dasharray:4 4,color:#475569",
  );
  if (entries.length) lines.push(`  class ${entries.join(",")} entry`);
  lines.push("");
  return lines.join("\n");
}
