# Static analysis and mapping

This document describes what `project-outline` extracts, how the generated views differ, and where static analysis stops.

## Analysis pipeline

Generation is deterministic and does not call an LLM.

1. Resolve the repository root and a safe child output directory.
2. Detect meaningful TypeScript, JavaScript, Python, Go, and Rust source.
3. Parse each file with the matching Tree-sitter grammar.
4. Normalize declarations, imports, signatures, source locations, and references into a language-independent IR.
5. Resolve repository-local symbols and statically knowable call/construction edges conservatively.
6. Serialize one shared graph, then derive the skeleton, indexes, query helper, and Mermaid view.

### Language detection and source selection

The CLI supports TypeScript, JavaScript, Python, Go, and Rust, including mixed-language repositories. Use `--language` with one of those names to limit generation to a single language.

Source discovery excludes dependencies, generated output, tests, migrations, common build/infrastructure directories, and configuration files. Benchmark-private `tasks/`, `tests/`, `verifier/`, `solution/`, and `reference_solution/` trees are excluded so held-out verification or reference code cannot enter generated agent context. HTML, CSS, and shell files are not treated as application source.

All syntax extraction originates from Tree-sitter. Language adapters describe grammar-specific declarations and references; they do not build artifacts themselves. The shared linker uses imports, module paths, local declarations, qualified identifiers, receiver/type annotations, assignments, and construction syntax when those signals identify one target. It leaves ambiguous targets unresolved rather than consulting a language compiler or guessing.

## The shared symbol graph

Each repository symbol has a stable ID:

```text
<repository-relative path>#<qualified symbol>
```

For example:

```text
src/jobs.ts#Queue.run
```

Every symbol includes a 1-based file/line/column jump target and a declaration signature. Relationship fields are omitted when empty.

Every callable also records its exact Tree-sitter declaration range as `line`, `column`, `endLine`, `endColumn`, `startByte`, and `endByte`. Line and column values are 1-based; byte offsets are UTF-8 and use a half-open `[startByte, endByte)` range.

| Field | Meaning |
|---|---|
| `calls` | Sorted, statically resolved repository callees |
| `callsInSourceOrder` | The first lexical occurrence of each callee when that differs from sorted order |
| `calledBy` | Reverse repository-call edges |
| `instantiates` | Repository types constructed by the symbol |
| `unresolvedProjectCalls` | Dynamic or ambiguous calls that may target repository code |
| `externalCalls` | Selected imported-package boundaries, qualified by import source |

`callsInSourceOrder` is lexical evidence, not proof of runtime order. Callback arguments can become repository edges when the supplied function is statically knowable; invoking the callback parameter remains unresolved because another runtime caller could supply a different target.

## Generated views

### Architecture index (`architecture.md`)

The compact Markdown index groups callables by module, identifies likely static roots, and includes bounded representative chains. It is the smallest artifact for questions such as “what are the main components?” or “where does this flow begin?”

It is deliberately incomplete. Open the query interface or source before treating a representative chain as exhaustive or dynamically guaranteed.

### Declaration skeleton (mirrored source paths)

The skeleton preserves repository structure, imports, declarations, classes/structs/interfaces/traits, inheritance, decorators or modifiers, type annotations, parameters, and signatures. Implementations, comments, docstrings, ordinary control flow, and default or assigned values that may contain configuration or secrets are removed. Function bodies retain compact relationship metadata rather than ordinary implementation behavior.

Use it to identify candidate types and APIs, not to infer branch conditions or side effects that require implementation details.

### Queryable call graph (`callgraph.json` and `query.mjs`)

The graph is the symbol-level source of truth for statically resolved relationships. `query.mjs` exposes bounded slices so an agent does not need to ingest or search the full JSON document.

| Operation | Output contract |
|---|---|
| `find <terms>` | Lexically matching IDs and signatures, capped by `--limit` |
| `inspect <symbol>` | One exact symbol with local callers/callees, jump targets, construction, and boundary metadata |
| `explore <symbol>` | A bounded multi-hop node/edge slice in `callers`, `callees`, or `both` direction |
| `trace <from> <to>` | A shortest static path and the direction followed at each step |

Ambiguous short names return candidates instead of silently selecting a symbol. Every bounded result reports truncation when matches or relationships were omitted.

Recommended flow:

1. Use `find` only when the exact symbol ID is unknown.
2. Use `inspect` and follow returned IDs one relationship at a time.
3. Use `explore` when repeated local inspection is insufficient.
4. Use `trace` when both endpoints are known.
5. Open narrow real-source ranges for dynamic behavior, conditions, or side effects.

### Mermaid module map (`architecture.mmd`)

The Mermaid view aggregates the symbol graph into a bounded module-level diagram. It marks likely entry modules, combines repeated call and construction relationships, and retains selected external dependency boundaries. It is designed for human orientation and is not included in benchmark treatments.

## What static analysis cannot prove

Treat the output as navigational evidence, not a runtime recording. In particular, static analysis may not establish:

- framework or dependency-injection dispatch resolved only at runtime;
- reflective calls, monkey patching, generated imports, or dynamic module loading;
- the branch that actually executed;
- data-dependent ordering, retries, failures, or side effects;
- targets hidden behind ambiguous interfaces or callbacks.

These boundaries remain visible as unresolved or external relationships where possible. The intended workflow is to use the map to localize the relevant implementation, then verify the missing behavior in real source.

## Output safety

`--out` must resolve to a child of `--root`. Generation refuses symlinked output paths that could escape the repository and only replaces or cleans directories whose files carry recognized generated markers. `project-outline init` manages only its delimited section in the root `AGENTS.md`.
