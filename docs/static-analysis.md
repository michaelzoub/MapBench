# Static analysis and mapping

This document describes what `project-outline` extracts, how the generated views differ, and where static analysis stops.

## Analysis pipeline

Generation is deterministic and does not call an LLM.

1. Resolve the repository root and a safe child output directory.
2. Detect meaningful TypeScript/JavaScript and Python source.
3. Parse declarations, imports, signatures, and relationships.
4. Resolve repository-local symbols and statically knowable call/construction edges.
5. Serialize one shared graph, then derive the skeleton, indexes, query helper, and Mermaid view.

### Language detection and source selection

The CLI supports TypeScript/JavaScript and Python. It selects a clearly dominant language or generates both views for a mixed application. Use `--language typescript` or `--language python` when repository metadata is ambiguous.

Source discovery excludes dependencies, generated output, tests, migrations, common build/infrastructure directories, and configuration files. A top-level `tasks/` directory is excluded so private eval data cannot enter generated agent context. HTML, CSS, and shell files are not treated as application source.

The TypeScript analyzer uses a root `tsconfig.json` or `jsconfig.json` when present, including path aliases and compiler options. The Python analyzer requires Python 3.9 or newer, uses the standard-library AST, and can be pointed at another interpreter with `PROJECT_OUTLINE_PYTHON`.

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

The skeleton preserves repository structure, local imports, declarations, classes, inheritance, decorators, type annotations, defaults, and signatures. Implementations, comments, docstrings, ordinary control flow, and values that may contain configuration or secrets are removed. Function bodies retain compact relationship metadata rather than executable behavior.

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
