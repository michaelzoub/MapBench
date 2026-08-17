import path from "node:path";
import type {
  StructuralEdgeType,
  StructuralIR,
  StructuralSymbol,
} from "./analysis/types.js";

export const MERMAID_HEADER = "%% @cartograph generated";

const MAX_MODULES = 24;
const MAX_PROJECT_RELATIONSHIPS = 32;
const MAX_EXTERNAL_DEPENDENCIES = 6;
const MAX_EXTERNAL_RELATIONSHIPS = 10;
const MAX_IMPORTANT_MODULES = 6;

const STRUCTURAL_EDGE_LABELS: Readonly<Partial<Record<StructuralEdgeType, string>>> = {
  import: "imports",
  instantiate: "instantiates",
  implement: "implements",
  inherit: "inherits",
  reference: "references",
};
const STRUCTURAL_EDGE_ORDER: StructuralEdgeType[] = [
  "import",
  "instantiate",
  "implement",
  "inherit",
  "reference",
];

interface ModuleRecord {
  file: string;
  declarations: number;
  entrypoints: Set<string>;
  reachedBy: Set<string>;
  fanIn: Set<string>;
  fanOut: Set<string>;
  downstreamReach: number;
  important: boolean;
}

interface ProjectRelationship {
  source: string;
  target: string;
  structural: Set<StructuralEdgeType>;
  flowEntrypoints: Set<string>;
}

interface ExternalRelationship {
  source: string;
  target: string;
  types: Set<"call" | "import">;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCallable(node: StructuralSymbol): boolean {
  return node.kind === "function" || node.kind === "method" || node.kind === "constructor";
}

function relationshipKey(source: string, target: string): string {
  return `${source}\0${target}`;
}

function externalBoundary(label: string): string {
  const separator = label.indexOf("#");
  return separator < 0 ? label : label.slice(0, separator);
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

/** Collapse deep source trees at stable package/component boundaries. */
function componentBoundary(file: string): string {
  const directory = path.posix.dirname(file);
  if (directory === ".") return ".";
  const parts = directory.split("/");
  if (["apps", "packages", "services"].includes(parts[0]) && parts.length > 1) {
    return parts.slice(0, 2).join("/");
  }
  if (["app", "lib", "src"].includes(parts[0]) && parts.length > 1) {
    return parts.slice(0, 2).join("/");
  }
  return parts.length > 2 ? parts.slice(0, 2).join("/") : directory;
}

function projectRelationshipLabel(relationship: ProjectRelationship): string {
  const labels = STRUCTURAL_EDGE_ORDER
    .filter((type) => relationship.structural.has(type))
    .map((type) => STRUCTURAL_EDGE_LABELS[type]!)
    .filter(Boolean);
  if (relationship.flowEntrypoints.size) labels.push("execution flow");
  return labels.join(" · ");
}

function downstreamCount(origin: string, outgoing: ReadonlyMap<string, Set<string>>): number {
  const visited = new Set<string>();
  const queue = [...(outgoing.get(origin) ?? [])].sort(compare);
  while (queue.length) {
    const current = queue.shift()!;
    if (current === origin || visited.has(current)) continue;
    visited.add(current);
    for (const target of [...(outgoing.get(current) ?? [])].sort(compare)) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return visited.size;
}

/**
 * Create a bounded, deterministic system map directly from the canonical IR.
 * Symbol-level calls remain exclusively available in the machine-readable call
 * graph; this projection uses them only to trace major flow from static roots.
 */
export function createArchitectureMermaid(ir: StructuralIR): string {
  const byId = new Map(ir.nodes.map((node) => [node.id, node]));
  const moduleNodes = ir.nodes.filter((node) => node.kind === "module");
  const moduleFiles = new Set(moduleNodes.map((node) => node.file));
  const modules = new Map<string, ModuleRecord>();
  for (const module of moduleNodes) {
    modules.set(module.file, {
      file: module.file,
      declarations: 0,
      entrypoints: new Set<string>(),
      reachedBy: new Set<string>(),
      fanIn: new Set<string>(),
      fanOut: new Set<string>(),
      downstreamReach: 0,
      important: false,
    });
  }
  // Be tolerant of older canonical fixtures that predate explicit module nodes.
  for (const node of ir.nodes.filter((candidate) => candidate.kind !== "module")) {
    if (!moduleFiles.has(node.file)) {
      moduleFiles.add(node.file);
      modules.set(node.file, {
        file: node.file,
        declarations: 0,
        entrypoints: new Set<string>(),
        reachedBy: new Set<string>(),
        fanIn: new Set<string>(),
        fanOut: new Set<string>(),
        downstreamReach: 0,
        important: false,
      });
    }
    modules.get(node.file)!.declarations += 1;
  }

  const resolvedInternal = ir.edges.filter((edge) => {
    if (edge.resolution !== "resolved" || !edge.target) return false;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return Boolean(source && target && source.file !== target.file);
  });
  const moduleOutgoing = new Map<string, Set<string>>();
  for (const edge of resolvedInternal) {
    const sourceFile = byId.get(edge.source)!.file;
    const targetFile = byId.get(edge.target!)!.file;
    modules.get(sourceFile)?.fanOut.add(targetFile);
    modules.get(targetFile)?.fanIn.add(sourceFile);
    const targets = moduleOutgoing.get(sourceFile) ?? new Set<string>();
    targets.add(targetFile);
    moduleOutgoing.set(sourceFile, targets);
  }
  for (const module of modules.values()) module.downstreamReach = downstreamCount(module.file, moduleOutgoing);

  const callableIds = new Set(ir.nodes.filter(isCallable).map((node) => node.id));
  const incomingCalls = new Set(
    ir.edges
      .filter((edge) => edge.type === "call" && edge.resolution === "resolved" && edge.target)
      .map((edge) => edge.target!),
  );
  const executableOutgoing = new Map<string, string[]>();
  for (const edge of ir.edges.filter((candidate) =>
    (candidate.type === "call" || candidate.type === "instantiate") &&
    candidate.resolution === "resolved" &&
    candidate.target,
  )) {
    const targets = executableOutgoing.get(edge.source) ?? [];
    targets.push(edge.target!);
    executableOutgoing.set(edge.source, targets);
  }
  for (const targets of executableOutgoing.values()) targets.sort(compare);
  const entrypoints = [...callableIds]
    .filter((id) => !incomingCalls.has(id) && (executableOutgoing.get(id)?.length ?? 0) > 0)
    .sort(compare);

  const reachedBySymbol = new Map<string, Set<string>>();
  for (const entrypoint of entrypoints) {
    const visited = new Set<string>();
    const queue = [entrypoint];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const origins = reachedBySymbol.get(current) ?? new Set<string>();
      origins.add(entrypoint);
      reachedBySymbol.set(current, origins);
      const node = byId.get(current);
      if (node) modules.get(node.file)?.reachedBy.add(entrypoint);
      for (const target of executableOutgoing.get(current) ?? []) {
        if (!visited.has(target)) queue.push(target);
      }
    }
    const root = byId.get(entrypoint);
    if (root) modules.get(root.file)?.entrypoints.add(root.qualifiedName || root.name);
  }

  const projectRelationships = new Map<string, ProjectRelationship>();
  const ensureProjectRelationship = (source: string, target: string): ProjectRelationship => {
    const key = relationshipKey(source, target);
    const existing = projectRelationships.get(key);
    if (existing) return existing;
    const created = {
      source,
      target,
      structural: new Set<StructuralEdgeType>(),
      flowEntrypoints: new Set<string>(),
    };
    projectRelationships.set(key, created);
    return created;
  };
  for (const edge of resolvedInternal) {
    const source = byId.get(edge.source)!.file;
    const target = byId.get(edge.target!)!.file;
    const relationship = ensureProjectRelationship(source, target);
    if (edge.type !== "call") relationship.structural.add(edge.type);
    if (edge.type === "call") {
      for (const entrypoint of reachedBySymbol.get(edge.source) ?? []) relationship.flowEntrypoints.add(entrypoint);
    }
  }
  // Drop unreachable call-only relationships: their full detail belongs in callgraph.json.
  for (const [key, relationship] of projectRelationships) {
    if (!relationship.structural.size && !relationship.flowEntrypoints.size) projectRelationships.delete(key);
  }

  const externalRelationships = new Map<string, ExternalRelationship>();
  for (const edge of ir.edges.filter((candidate) => candidate.resolution === "external" && candidate.targetLabel)) {
    if (edge.type !== "import" && edge.type !== "call") continue;
    const source = byId.get(edge.source);
    if (!source) continue;
    const target = externalBoundary(edge.targetLabel!);
    if (!target) continue;
    const key = relationshipKey(source.file, target);
    const relationship = externalRelationships.get(key) ?? { source: source.file, target, types: new Set<"call" | "import">() };
    relationship.types.add(edge.type);
    externalRelationships.set(key, relationship);
  }

  const allModules = [...modules.values()];
  const selectedModules = selectImportant(
    allModules,
    MAX_MODULES,
    (module) =>
      (module.entrypoints.size ? 1_000_000_000 : 0) +
      module.reachedBy.size * 10_000_000 +
      module.downstreamReach * 100_000 +
      module.fanIn.size * 1_000 +
      module.fanOut.size * 100 +
      module.declarations,
    (module) => module.file,
  );
  const selectedFiles = new Set(selectedModules.map((module) => module.file));

  const importantCandidates = selectedModules.filter((module) =>
    !module.entrypoints.size &&
    (module.reachedBy.size > 1 || module.fanIn.size > 1 || module.fanOut.size > 1 || module.downstreamReach > 1),
  );
  for (const module of [...importantCandidates]
    .sort((left, right) =>
      right.reachedBy.size - left.reachedBy.size ||
      right.downstreamReach - left.downstreamReach ||
      right.fanIn.size - left.fanIn.size ||
      right.fanOut.size - left.fanOut.size ||
      compare(left.file, right.file),
    )
    .slice(0, MAX_IMPORTANT_MODULES)) module.important = true;

  const eligibleProjectRelationships = [...projectRelationships.values()].filter(
    (relationship) => selectedFiles.has(relationship.source) && selectedFiles.has(relationship.target),
  );
  const selectedProjectRelationships = selectImportant(
    eligibleProjectRelationships,
    MAX_PROJECT_RELATIONSHIPS,
    (relationship) =>
      (relationship.flowEntrypoints.size ? 5_000_000 + relationship.flowEntrypoints.size * 100_000 : 0) +
      relationship.structural.size * 1_000_000 +
      (modules.get(relationship.target)?.downstreamReach ?? 0) * 1_000 +
      (modules.get(relationship.target)?.fanIn.size ?? 0),
    (relationship) => relationshipKey(relationship.source, relationship.target),
  );

  const eligibleExternalRelationships = [...externalRelationships.values()].filter((edge) => selectedFiles.has(edge.source));
  const dependencyScores = new Map<string, { modules: Set<string>; structural: boolean }>();
  for (const edge of eligibleExternalRelationships) {
    const score = dependencyScores.get(edge.target) ?? { modules: new Set<string>(), structural: false };
    score.modules.add(edge.source);
    score.structural ||= edge.types.has("import");
    dependencyScores.set(edge.target, score);
  }
  const selectedDependencies = selectImportant(
    [...dependencyScores],
    MAX_EXTERNAL_DEPENDENCIES,
    ([, score]) => score.modules.size * 10 + (score.structural ? 1 : 0),
    ([name]) => name,
  ).map(([name]) => name);
  const selectedDependencySet = new Set(selectedDependencies);
  const selectedExternalRelationships = selectImportant(
    eligibleExternalRelationships.filter((edge) => selectedDependencySet.has(edge.target)),
    MAX_EXTERNAL_RELATIONSHIPS,
    (edge) => (edge.types.has("import") ? 100 : 0) + (modules.get(edge.source)?.reachedBy.size ?? 0) * 10 + edge.types.size,
    (edge) => relationshipKey(edge.source, edge.target),
  );
  const renderedDependencies = new Set(selectedExternalRelationships.map((edge) => edge.target));
  const allDependencies = new Set([...externalRelationships.values()].map((edge) => edge.target));

  const moduleIds = new Map(selectedModules.map((module, index) => [module.file, `module_${index}`]));
  const dependencyIds = new Map(
    [...renderedDependencies].sort(compare).map((dependency, index) => [dependency, `dependency_${index}`]),
  );
  const components = new Map<string, ModuleRecord[]>();
  for (const module of selectedModules) {
    const component = componentBoundary(module.file);
    const members = components.get(component) ?? [];
    members.push(module);
    components.set(component, members);
  }

  const lines = [
    MERMAID_HEADER,
    "%% Deterministic system map projected directly from the canonical structural IR.",
    "%% Detailed symbol call relationships remain in callgraph.json; call edges only inform entrypoint-rooted execution flow.",
    "flowchart LR",
  ];

  if (!selectedModules.length) {
    lines.push('  empty["No modules detected"]', "");
    return lines.join("\n");
  }

  [...components].sort(([left], [right]) => compare(left, right)).forEach(([component, members], index) => {
    lines.push(`  subgraph group_${index}["${mermaidText(component === "." ? "repository root" : component)}"]`);
    lines.push("    direction TB");
    for (const module of members.sort((left, right) => compare(left.file, right.file))) {
      const details: string[] = [];
      if (module.entrypoints.size) {
        const names = [...module.entrypoints].sort(compare);
        details.push(names.length === 1 ? `static entry: ${names[0]}` : `${names.length} static entries`);
      } else if (module.reachedBy.size) {
        details.push(`reached by ${module.reachedBy.size} entr${module.reachedBy.size === 1 ? "y" : "ies"}`);
      }
      if (module.entrypoints.size || module.important) {
        details.push(`fan ${module.fanIn.size} in / ${module.fanOut.size} out`);
        details.push(`${module.downstreamReach} downstream`);
      }
      const suffix = details.length ? `<br/>${mermaidText(details.join(" · "))}` : "";
      lines.push(`    ${moduleIds.get(module.file)}["${mermaidText(path.posix.basename(module.file))}${suffix}"]`);
    }
    lines.push("  end");
  });

  if (renderedDependencies.size) {
    lines.push('  subgraph dependencies["External systems / dependencies"]', "    direction TB");
    for (const dependency of [...renderedDependencies].sort(compare)) {
      lines.push(`    ${dependencyIds.get(dependency)}(["${mermaidText(dependency)}"])`);
    }
    lines.push("  end");
  }

  for (const relationship of selectedProjectRelationships) {
    const connector = relationship.flowEntrypoints.size
      ? "==>"
      : relationship.structural.size === 1 && relationship.structural.has("import") ? "-.->" : "-->";
    lines.push(`  ${moduleIds.get(relationship.source)} ${connector}|${projectRelationshipLabel(relationship)}| ${moduleIds.get(relationship.target)}`);
  }
  for (const relationship of selectedExternalRelationships) {
    const labels = [
      relationship.types.has("import") ? "imports" : "",
      relationship.types.has("call") ? "uses API" : "",
    ].filter(Boolean).join(" · ");
    lines.push(`  ${moduleIds.get(relationship.source)} -.->|${labels}| ${dependencyIds.get(relationship.target)}`);
  }

  const omittedModules = allModules.length - selectedModules.length;
  const omittedRelationships = projectRelationships.size - selectedProjectRelationships.length;
  const omittedDependencies = allDependencies.size - renderedDependencies.size;
  const omissionParts = [
    omittedModules ? `${omittedModules} module${omittedModules === 1 ? "" : "s"}` : "",
    omittedRelationships ? `${omittedRelationships} system relationship${omittedRelationships === 1 ? "" : "s"}` : "",
    omittedDependencies ? `${omittedDependencies} external dependenc${omittedDependencies === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean);
  if (omissionParts.length) {
    lines.push(`  omitted["… ${omissionParts.join(", ")} omitted for readability"]`);
    lines.push("  class omitted omitted");
  }

  const entries = selectedModules.filter((module) => module.entrypoints.size).map((module) => moduleIds.get(module.file)!);
  const important = selectedModules.filter((module) => module.important).map((module) => moduleIds.get(module.file)!);
  lines.push(
    "  classDef entry fill:#dbeafe,stroke:#2563eb,stroke-width:3px",
    "  classDef important fill:#fef3c7,stroke:#d97706,stroke-width:2px",
    "  classDef external fill:#f3e8ff,stroke:#7e22ce,stroke-dasharray:4 3",
    "  classDef omitted fill:#f8fafc,stroke:#94a3b8,stroke-dasharray:4 4,color:#475569",
  );
  if (entries.length) lines.push(`  class ${entries.join(",")} entry`);
  if (important.length) lines.push(`  class ${important.join(",")} important`);
  if (dependencyIds.size) lines.push(`  class ${[...dependencyIds.values()].join(",")} external`);
  lines.push("");
  return lines.join("\n");
}
