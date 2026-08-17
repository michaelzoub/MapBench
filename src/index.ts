export { cleanOutline } from "./clean.js";
export { generateOutline } from "./generate.js";
export { initOutline } from "./init.js";
export {
  createEmbeddedQueryScript,
  exploreCallGraph,
  findCallGraphSymbols,
  inspectCallGraphSymbol,
  navigateCallGraph,
  navigateOutline,
  queryCallGraph,
  queryOutline,
  traceCallGraph,
} from "./query.js";
export { watchOutline } from "./watch.js";
export { createArchitectureSummary } from "./architecture.js";
export { createArchitectureMermaid } from "./mermaid.js";
export { createCallGraphFromIR, createStructuralIR, TOOL_NAME } from "./analysis/ir.js";
export type {
  CallGraph,
  CallGraphDirection,
  CallGraphEntry,
  CallGraphExploreNode,
  CallGraphExploreResult,
  CallGraphFindResult,
  CallGraphInspectResult,
  CallGraphNavigationRequest,
  CallGraphNavigationResult,
  CallGraphQueryMatch,
  CallGraphQueryResult,
  CallGraphSymbolDetail,
  CallGraphSymbolKind,
  CallGraphSymbolReference,
  CallGraphTraceResult,
  CallGraphTraceStep,
  GenerationResult,
  InitResult,
  OutlineOptions,
  QueryOptions,
  SupportedLanguage,
  WatchHandle,
} from "./types.js";
export type {
  StructuralEdge,
  StructuralEdgeType,
  StructuralIR,
  StructuralManifest,
  StructuralResolution,
  StructuralSymbol,
  StructuralSymbolKind,
  StructuralUnresolved,
} from "./analysis/types.js";
