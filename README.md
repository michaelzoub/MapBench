# Cartograph

`cartograph` turns TypeScript, JavaScript, Python, Go, and Rust repositories into a small set of deterministic structural projections. It uses Tree-sitter-based static analysis—not an LLM—to map declarations, modules, typed relationships, construction, unresolved dynamic boundaries, and selected external dependencies.

The canonical structural IR is the internal source of truth. Architecture, declaration skeletons, Mermaid, and graph navigation are deterministic projections of that IR.

## Quick start

From this source checkout:

```bash
bun install
bun run outline
```

That builds the local CLI and generates `.cartograph/` for the current repository. After `bun run build && bun link`, the same workflow is available as:

```bash
cartograph generate
cartograph init       # optionally add managed guidance to the root AGENTS.md
cartograph watch
cartograph clean
```

Use `--root`, `--out`, or `--language typescript|javascript|python|go|rust` to override detection and output paths. Generation writes only inside the output directory; `init` is the one command that may update the repository's root `AGENTS.md`.

## What it generates

All mapping views come from the canonical structural IR, but answer different questions:

| View | Path | Best for | Important limit |
|---|---|---|---|
| Architecture view | `.cartograph/architecture.md` | Hierarchical repository, components, public surfaces, dependencies, flows, and boundaries | Static evidence, not a runtime trace |
| Declaration skeleton | Mirrored source paths under `.cartograph/` | Imports, classes, types, functions, signatures, and IR-derived relationship comments | Implementation bodies and ordinary control flow are removed |
| Graph projection | `.cartograph/callgraph.json` + `query.mjs` | Callers, callees, construction, and symbol-to-symbol paths | Dynamic dispatch is recorded as unresolved or may remain absent |
| Mermaid module map | `.cartograph/architecture.mmd` | A bounded human overview of module and dependency relationships | Aggregates the graph and intentionally omits detail |
| Agent guidance | `.cartograph/AGENTS.md` | A compact protocol for using the other artifacts | Guidance only; it contains no extra analysis |

The generator detects meaningful application source, parses every supported language with its maintained Tree-sitter grammar, builds one canonical IR with typed edges and a manifest, and derives every view from it.

See [Static analysis and mapping](docs/static-analysis.md) for supported syntax, graph fields, language detection, exclusions, and known limits.

## Query the graph progressively

Do not load the full `callgraph.json` into an agent context. Use the installed cartograph CLI:

```bash
cartograph find "payment validate" --limit 12
cartograph inspect "PaymentService.process"
cartograph explore "PaymentService.process" --direction both --depth 2
cartograph trace "registerRoutes" "PaymentRepository.save"
```

`cartograph` is the installed CLI. Use `find` for discovery, `inspect` for one symbol, `explore` for a bounded subsystem, and `trace` for a shortest path between known endpoints. Short names return bounded candidates when ambiguous. The generated `query.mjs` remains a compatibility helper for full generated outputs.

## MapBench

MapBench uses Pi as a deliberately narrow evaluation harness to measure whether each generated mapping aid helps an agent solve repository-level tasks. It is an ablation harness, not part of Cartograph itself.

For every task and condition, it:

1. Loads a bundled `tasks/<id>/task.json` definition or adapts a selected task from the pinned DeepSWE v1.1 checkout.
2. Materializes the target repository at one exact commit, removes its original Git object database, and initializes a clean baseline repository.
3. Keeps the complete real source tree available in every condition, including architecture-only.
4. Generates the canonical IR internally and exposes only the selected treatment: architecture/skeleton files under `.mapbench/`, or a bounded `mapbench_query` tool for the call graph.
5. Runs a fresh non-session Pi process with ambient context files/resources disabled. Answer tasks receive only workspace-confined read tools. DeepSWE coding tasks receive read/write access to the disposable workspace, while shell commands run only in its no-network task-image container.
6. Persists the final answer and event trace, then runs the private grader outside the agent workspace.
7. Reports factual score separately from tokens, time, cost, file access, and navigation diagnostics.

Before paid/model execution, the harness grades an empty answer and aborts if it passes or the grader is misconfigured. The `benchmark ask` authoring flow additionally validates a repository-grounded positive control and an empty negative control. Attempted commands, failed accesses, and self-declared metrics do not count as successful behavior.

### What graders measure

| Grader style | Measures |
|---|---|
| Rubric facts | Required repository paths, symbols, state transitions, or architecture facts in the persisted answer |
| Ranked localization | Correct symbol ranking plus an event-derived real-source retrieval budget |
| Execution path | Runtime nodes, edges, ordering, validation, and persistence effects |
| Task-local grader | A task-specific answer or behavioral contract; it must emit `score`, `maxScore`, and `passed` |

The default comparison uses three fresh runs for each of five conditions:

| Condition | Mapping aid available |
|---|---|
| `regular-code` | None |
| `outline-only` | Architecture index |
| `skeleton-only` | Declaration skeleton |
| `callgraph-only` | Queryable call graph |
| `all-outline-aids` | Full MapBench: all three mapping aids |

Use `--conditions factorial` for the three intermediate multi-artifact combinations as well. The Mermaid view is for humans and is not a benchmark treatment.

```bash
# Validate task discovery and the complete plan without invoking Pi.
bun run benchmark --repo ../my-project --task trace-cli-entrypoint --pricing off --dry-run

# Run the default five-condition comparison (3 runs × 5 conditions).
bun run benchmark --repo ../my-project --task trace-cli-entrypoint

# Create a repository-grounded localization task and private grader.
bun run benchmark ask

# Verify the harness and graders locally.
bun run benchmark:test

# Dry-run the pinned DeepSWE smoke set through the Pi + Docker coding harness.
bun run benchmark --deepswe ../deep-swe --task-set smoke --pricing off --dry-run
```

Results are written to `benchmark-results/<timestamp>/` with immutable configuration, per-run answers/events/grades, summaries, an HTML report, and SVG charts. See [Benchmark methodology](docs/benchmark.md) for isolation, task authoring, the full condition matrix, pricing, regrading, and result provenance. The task catalog and manifest layout are documented in [tasks/README.md](tasks/README.md).

## Repository layout

```text
src/                    analyzer, generators, query interface, and main CLI
test/                   analyzer and CLI tests
tasks/                  stable task IDs, prompts, rubrics, and task-local graders
benchmark/              benchmark runner, isolation, reporting, and telemetry
benchmark/graders/      reusable grader executables
benchmark/examples/     bundled target repository used by benchmark tests/examples
benchmark/test/         harness, grader, and report tests
docs/                   detailed static-analysis and benchmark documentation
```

`benchmark/task-loader.ts` discovers and validates task manifests. Task definitions remain at the repository root so the harness implementation and the things it evaluates are visibly separate.

## Development

```bash
bun run test
bun run benchmark:test
```

The analyzer suite verifies deterministic output, language support, exclusions, safe writes, graph navigation, and stale-file cleanup. The benchmark suite verifies clone and grader isolation, exact condition contents, positive and negative behavior, event-derived metrics, token accounting, timeouts, and deterministic reporting.
