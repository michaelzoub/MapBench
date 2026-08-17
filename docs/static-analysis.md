# Static analysis and mapping

This document describes what `cartograph` extracts, how the generated views differ, and where static analysis stops.

## Analysis pipeline

Generation is deterministic and does not call an LLM.

1. Resolve the repository root and a safe child output directory.
2. Detect meaningful TypeScript, JavaScript, Python, Go, and Rust source.
3. Parse each file with the matching Tree-sitter grammar.
4. Normalize declarations, imports, signatures, source locations, and references into one canonical structural IR.
5. Resolve repository-local symbols and statically knowable relationships conservatively, retaining source anchors, source order, resolution status, and provenance on first-class edges.
6. Derive the architecture view, language-native declaration skeletons, call-graph projection, query CLI, and Mermaid view from that same IR.

The canonical IR is the internal source of truth. It contains `nodes`, typed `edges`, `unresolved` relationships, and a `manifest`; it is not emitted into benchmark workspaces unless a future experiment explicitly tests raw-IR access.

### Language detection and source selection

The CLI supports TypeScript, JavaScript, Python, Go, and Rust, including mixed-language repositories. Use `--language` with one of those names to limit generation to a single language.

Source discovery excludes dependencies, generated output, tests, migrations, common build/infrastructure directories, and configuration files. Benchmark-private `tasks/`, `tests/`, `verifier/`, `solution/`, and `reference_solution/` trees are excluded so held-out verification or reference code cannot enter generated agent context. HTML, CSS, and shell files are not treated as application source.

## Canonical structural IR

Each declaration node has a stable ID:

```text
<repository-relative path>#<qualified symbol>
```

The IR also contains module nodes, exact source ranges, signatures, visibility/export metadata, and a manifest with tool/schema version, git commit when available, languages, scanned/skipped files, parse failures, and counts.

Edges are first-class records with a typed relationship (`call`, `instantiate`, `import`, `inherit`, `implement`, or `reference`), source location, lexical order where available, resolution status (`resolved`, `external`, `unresolved`, or `ambiguous`), and provenance. Unresolved records preserve the source location and reason when known.

All reverse relationships, module dependencies, architecture summaries, skeleton comments, Mermaid aggregates, and graph-query results are projections of these nodes and edges. No projection maintains an independent relationship model.

## Generated views

### Architecture view (`architecture.md`)

The deterministic Markdown view is hierarchical rather than a root/call-chain list. It covers repository/packages/services, major components/directories, exported surfaces and static entrypoint indicators, module dependencies, bounded important flows, external boundaries, unresolved/dynamic boundaries, and analysis coverage/limitations. Each section distinguishes resolved static facts from heuristic or unresolved evidence.

### Declaration skeleton (mirrored source paths)

The skeleton preserves language-native imports, declarations, classes/structs/interfaces/traits, inheritance, decorators or modifiers, type annotations, parameters, and signatures. Implementations, comments, docstrings, ordinary control flow, and default or assigned values that may contain configuration or secrets are removed. Relationship data is generated as comments directly from canonical IR edges:

```ts
// Structural relationships:
// calls:
//   src/files.ts#assertSafeOutput
//   src/instructions.ts#createManagedAgentsSection
export async function initOutline(
  options: OutlineOptions = undefined
): Promise<InitResult> {
  /* implementation omitted */
}
```

Relationships are never encoded as fake executable string expressions.

### Deterministic graph CLI

The independently installable package exposes the same graph-navigation primitives as official top-level commands:

```bash
cartograph find "PaymentService"
cartograph inspect "PaymentService.execute"
cartograph explore "PaymentService.execute" --direction callees --depth 2
cartograph trace "PaymentController.create" "DatabaseAdapter.insertPayment"
```

`cartograph` is also installed as a package binary alias. The commands perform no natural-language or LLM reasoning, return bounded structured JSON, and analyze the repository directly when no generated graph file is present. Harnesses invoke them through their normal shell tools.

| Operation | Output contract |
|---|---|
| `find <terms>` | Lexically matching IDs and signatures, capped by `--limit` |
| `inspect <symbol>` | One exact symbol with local callers/callees, jump targets, construction, and boundary metadata |
| `explore <symbol>` | A bounded multi-hop node/edge slice in `callers`, `callees`, or `both` direction |
| `trace <from> <to>` | A shortest static path and the direction followed at each step |

Ambiguous short names return candidates instead of silently selecting a symbol. Every bounded result reports truncation when matches or relationships were omitted.

`callsInSourceOrder` is lexical evidence, not proof of runtime order. Callback arguments can become repository edges when the supplied function is statically knowable; invoking the callback parameter remains unresolved because another runtime caller could supply a different target.


### Mermaid module map (`architecture.mmd`)

The Mermaid view is a bounded human visualization derived from the same call-graph projection. It is not included in benchmark treatments.

## What static analysis cannot prove

Treat the output as navigational evidence, not a runtime recording. In particular, static analysis may not establish:

- framework or dependency-injection dispatch resolved only at runtime;
- reflective calls, monkey patching, generated imports, or dynamic module loading;
- the branch that actually executed;
- data-dependent ordering, retries, failures, or side effects;
- targets hidden behind ambiguous interfaces or callbacks.

These boundaries remain visible as unresolved or external relationships where possible. The intended workflow is to use the map to localize the relevant implementation, then verify the missing behavior in real source.

## Output safety

`--out` must resolve to a child of `--root`. Generation refuses symlinked output paths that could escape the repository and only replaces or cleans directories whose files carry recognized generated markers. `cartograph init` manages only its delimited section in the root `AGENTS.md`.
