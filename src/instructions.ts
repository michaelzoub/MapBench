import path from "node:path";

export const MANAGED_SECTION_START = "<!-- project-outline:start -->";
export const MANAGED_SECTION_END = "<!-- project-outline:end -->";
export const OUTLINE_INSTRUCTIONS_HEADER = "<!-- @project-outline generated -->";

function markdownPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function outputReference(root: string, out: string): string {
  const relative = markdownPath(path.relative(root, out));
  return relative || ".project-outline";
}

function createOutlineInstructionsBody(outputDirectory: string): string {
  const directory = markdownPath(outputDirectory).replace(/\/$/, "");
  return `# Project Outline

Use the single smallest artifact that fits the question; consult another only if the first is insufficient:

- \`${directory}/architecture.md\` — modules and end-to-end flows.
- \`project-outline query find "<terms>"\` — locate symbols lexically when the exact ID is unknown.
- \`project-outline query inspect "<symbol>"\` — inspect one symbol's callers, callees, location, and boundary metadata.
- \`project-outline query explore "<symbol>" --depth 2\` — expand a bounded subsystem only when repeated local inspection is insufficient.
- \`project-outline query trace "<from>" "<to>"\` — find a shortest static call path. Add \`--direction both\` when the relationship direction is unknown.
- \`${directory}/<source-path>\` — declarations and signatures without bodies.

If the CLI is unavailable, replace \`project-outline query\` with \`node ${directory}/query.mjs\`. Prefer \`find\` → \`inspect\`, then follow returned symbol IDs with more \`inspect\` calls. Never dump \`callgraph.json\`, parse it directly, or search it broadly; the query interface intentionally exposes only the requested slice.

Open only the narrow real-source ranges needed after the graph has identified the implementation path, especially for dynamic dispatch or unresolved calls. Exclude generated files from source searches with \`-g '!${directory}/**'\`. Regenerate after structural changes with \`project-outline generate\`.
`;
}

function createPreviousOutlineInstructionsBody(outputDirectory: string): string {
  const directory = markdownPath(outputDirectory).replace(/\/$/, "");
  return `# Project Outline

Use the single smallest artifact that fits the question; consult another only if the first is insufficient:

- \`${directory}/architecture.md\` — modules and end-to-end flows.
- \`project-outline query "<symbol>"\` (or \`node ${directory}/query.mjs "<symbol>"\`) — callers, callees, and symbol locations. Never dump \`callgraph.json\`.
- \`${directory}/<source-path>\` — declarations and signatures without bodies.

Then open only the narrow real-source ranges needed for implementation or dynamic behavior. Exclude generated files from source searches with \`-g '!${directory}/**'\`. Regenerate after structural changes with \`project-outline generate\`.
`;
}

export function createOutlineInstructions(outputDirectory = ".project-outline"): string {
  return `${OUTLINE_INSTRUCTIONS_HEADER}\n${createOutlineInstructionsBody(outputDirectory)}`;
}

function createLegacyOutlineInstructions(outputDirectory: string): string {
  const directory = markdownPath(outputDirectory).replace(/\/$/, "");
  return `# Project Outline

Before exploring or modifying this repository:

1. Read \`${directory}/architecture.md\` first for system-level or execution-flow questions, then search the mirror for declarations, signatures, inline callees, and candidate symbols.
2. Query exact symbol neighborhoods with \`project-outline query "<symbol>"\`. If the CLI is unavailable, run \`node ${directory}/query.mjs "<symbol>"\`. Do not print or broadly search the full \`callgraph.json\`.
3. Read symbol IDs as \`file#qualifiedName\` and jump with each result's 1-based \`file:line:column\`. \`calls\` / \`calledBy\` are resolved repository edges; \`instantiates\` points to repository types; \`unresolvedProjectCalls\` and \`externalCalls\` are separate boundary hints; \`callsInSourceOrder\` is lexical, not runtime, order.
4. Run outline queries and real-source reads as separate commands so their outputs remain attributable and compact.
5. Open real source only for implementation details the outline cannot establish. Use narrow line ranges and do not re-read declarations already established by the outline.
6. When searching real source, exclude the generated mirror with \`-g '!${directory}/**'\` so results are not duplicated.
7. Treat generated navigation data as a hint, not absolute runtime truth. Verify only dynamic dispatch, registries, callbacks, dependency injection, unresolved calls, and task-critical implementation behavior.
8. Regenerate the outline after structural code changes with \`project-outline generate\`.
`;
}

function createOlderOutlineInstructions(outputDirectory: string): string {
  const directory = markdownPath(outputDirectory).replace(/\/$/, "");
  return `# Project Outline

Before exploring or modifying this repository:

1. Read \`${directory}/architecture.md\` first for system-level or execution-flow questions, then search the mirror for declarations, signatures, inline callees, and candidate symbols.
2. Query exact symbol neighborhoods with \`project-outline query "<symbol>"\`. If the CLI is unavailable, run \`node ${directory}/query.mjs "<symbol>"\`. Do not print or broadly search the full \`callgraph.json\`.
3. Run outline queries and real-source reads as separate commands so their outputs remain attributable and compact.
4. Open real source only for implementation details the outline cannot establish. Use narrow line ranges and do not re-read declarations already established by the outline.
5. When searching real source, exclude the generated mirror with \`-g '!${directory}/**'\` so results are not duplicated.
6. Treat generated navigation data as a hint, not absolute runtime truth. Verify only dynamic dispatch, registries, callbacks, dependency injection, unresolved calls, and task-critical implementation behavior.
7. Regenerate the outline after structural code changes with \`project-outline generate\`.
`;
}

export function isManagedOutlineInstructions(contents: string, outputDirectory = ".project-outline"): boolean {
  return contents === createOutlineInstructions(outputDirectory) ||
    contents === createOutlineInstructionsBody(outputDirectory) ||
    contents === `${OUTLINE_INSTRUCTIONS_HEADER}\n${createPreviousOutlineInstructionsBody(outputDirectory)}` ||
    contents === createPreviousOutlineInstructionsBody(outputDirectory) ||
    contents === createLegacyOutlineInstructions(outputDirectory) ||
    contents === createOlderOutlineInstructions(outputDirectory);
}

export function createManagedAgentsSection(outputDirectory = ".project-outline"): string {
  const directory = markdownPath(outputDirectory).replace(/\/$/, "");
  return `${MANAGED_SECTION_START}
## Project Outline

Use one smallest-fit aid first; use another only if needed:

- \`${directory}/architecture.md\` for modules and flows
- \`project-outline query find "<terms>"\` to locate symbols, then \`project-outline query inspect "<symbol>"\` to follow callers/callees
- \`project-outline query explore "<symbol>" --depth 2\` for a bounded subsystem, or \`project-outline query trace "<from>" "<to>"\` for a static path
- \`${directory}/<source-path>\` for declarations and signatures

Use \`node ${directory}/query.mjs ...\` if the CLI is unavailable. Never dump or broadly read \`callgraph.json\`. Follow returned symbol IDs progressively, then open narrow real-source ranges only for missing implementation or dynamic behavior; exclude \`${directory}/**\` from source searches. Regenerate after structural changes with \`project-outline generate\`.
${MANAGED_SECTION_END}`;
}
