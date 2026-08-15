# project-outline

`project-outline` turns TypeScript, JavaScript, Python, Go, and Rust repositories into a small set of deterministic architecture aids. It uses Tree-sitter-based static analysis—not an LLM—to map declarations, repository-local calls, construction, unresolved dynamic boundaries, and selected external dependencies.

The goal is progressive navigation: start with a compact system view, follow only the relevant symbols, and open real source when static analysis cannot establish runtime behavior.

## Quick start

From this source checkout:

```bash
npm install
npm run outline
```

That builds the local CLI and generates `.project-outline/` for the current repository. After `npm run build && npm link`, the same workflow is available as:

```bash
project-outline generate
project-outline init       # optionally add managed guidance to the root AGENTS.md
project-outline watch
project-outline clean
```

Use `--root`, `--out`, or `--language typescript|javascript|python|go|rust` to override detection and output paths. Generation writes only inside the output directory; `init` is the one command that may update the repository's root `AGENTS.md`.

## What it generates

All mapping views come from the same parsed symbol graph, but answer different questions:

| View | Path | Best for | Important limit |
|---|---|---|---|
| Architecture index | `.project-outline/architecture.md` | Modules, likely roots, and representative static execution chains | A compressed index, not a runtime trace |
| Declaration skeleton | Mirrored source paths under `.project-outline/` | Imports, classes, functions, signatures, and local relationship hints | Implementation bodies and ordinary control flow are removed |
| Queryable call graph | `.project-outline/callgraph.json` + `query.mjs` | Callers, callees, construction, and symbol-to-symbol paths | Dynamic dispatch is recorded as unresolved instead of guessed |
| Mermaid module map | `.project-outline/architecture.mmd` | A bounded human overview of module and dependency relationships | Aggregates the graph and intentionally omits detail |
| Agent guidance | `.project-outline/AGENTS.md` | A compact protocol for using the other artifacts | Guidance only; it contains no extra analysis |

The generator detects meaningful application source, parses every supported language with its maintained Tree-sitter grammar, normalizes syntax into one language-independent IR, resolves statically knowable repository relationships, preserves ambiguous/external boundaries separately, and derives every view from that shared graph.

See [Static analysis and mapping](docs/static-analysis.md) for supported syntax, graph fields, language detection, exclusions, and known limits.

## Query the graph progressively

Do not load the full `callgraph.json` into an agent context. Use the bounded query interface:

```bash
project-outline query find "payment validate" --limit 12
project-outline query inspect "PaymentService.process"
project-outline query explore "PaymentService.process" --direction both --depth 2
project-outline query trace "registerRoutes" "PaymentRepository.save"
```

Use `find` for discovery, `inspect` for one symbol, `explore` for a bounded subsystem, and `trace` for a shortest path between known endpoints. Short names must resolve uniquely; otherwise the CLI returns bounded candidates. If the installed CLI is unavailable, run the same operation with `node .project-outline/query.mjs ...`.

## Codex benchmark

The benchmark measures whether each generated mapping aid helps Codex solve repository-level tasks. It is an ablation harness, not part of the analyzer itself.

For every task and condition, it:

1. Loads `tasks/<id>/task.json`, the prompt, and its private grader.
2. Clones the target repository at one exact commit into a fresh workspace.
3. Adds only the mapping artifacts selected by that condition.
4. Runs a new isolated `codex exec --ephemeral` process with the same prompt and model settings.
5. Persists the final answer and event trace, then runs the private grader outside the agent workspace.
6. Reports factual score separately from tokens, time, cost, file access, and navigation diagnostics.

Before paid/model execution, the harness grades an empty answer and aborts if it passes or the grader is misconfigured. The `benchmark ask` authoring flow additionally validates a repository-grounded positive control and an empty negative control. Attempted commands, failed accesses, and self-declared metrics do not count as successful behavior.

### What graders measure

| Grader style | Measures |
|---|---|
| Rubric facts | Required repository paths, symbols, state transitions, or architecture facts in the persisted answer |
| Ranked localization | Correct symbol ranking plus an event-derived real-source retrieval budget |
| Execution path | Runtime nodes, edges, ordering, validation, and persistence effects |
| Task-local grader | A task-specific answer or behavioral contract; it must emit `score`, `maxScore`, and `passed` |

The default comparison uses three fresh runs for each of four conditions:

| Condition | Mapping aid available |
|---|---|
| `regular-code` | None |
| `outline-only` | Architecture index |
| `skeleton-only` | Declaration skeleton |
| `callgraph-only` | Queryable call graph |

Use `--conditions factorial` for all combinations, including `all-outline-aids`. The Mermaid view is for humans and is not a benchmark treatment.

```bash
# Validate task discovery and the complete plan without invoking Codex.
bun run benchmark --repo ../my-project --task trace-cli-entrypoint --pricing off --dry-run

# Run the default four-condition comparison (3 runs × 4 conditions).
bun run benchmark --repo ../my-project --task trace-cli-entrypoint

# Create a repository-grounded localization task and private grader.
bun run benchmark ask

# Verify the harness and graders locally.
bun run benchmark:test
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
npm test
bun run benchmark:test
```

The analyzer suite verifies deterministic output, language support, exclusions, safe writes, graph navigation, and stale-file cleanup. The benchmark suite verifies clone and grader isolation, exact condition contents, positive and negative behavior, event-derived metrics, token accounting, timeouts, and deterministic reporting.
