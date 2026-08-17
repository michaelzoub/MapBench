# Benchmark methodology

The Codex benchmark tests whether a specific generated mapping aid changes correctness or navigation efficiency on repository-level tasks. It keeps task accuracy separate from telemetry such as tokens, duration, cost, commands, and source reads.

## Core terms

| Term | Meaning |
|---|---|
| Task | One stable prompt, manifest, and private grader under `tasks/<id>/` |
| Condition | The exact subset of generated mapping aids placed in the workspace |
| Cell | One task × condition combination |
| Repetition | One fresh Codex process and workspace for a cell; exactly three are required |
| Pair | Runs sharing a task and repetition number across conditions, used for wins/losses/ties |

## Run a benchmark

Node.js 20+, Bun, and an authenticated `codex` CLI are required.

```bash
# Inspect task/condition discovery and command plans without model execution.
bun run benchmark --repo ../target --task map-project --pricing off --dry-run

# Run the default five conditions, three fresh repetitions each.
bun run benchmark --repo ../target --task map-project

# Run all bundled tasks against a compatible target.
bun run benchmark --repo ../target --all

# Select another task root.
bun run benchmark --repo ../target --tasks ../shared-tasks --all

# Rebuild a report from an existing result directory.
bun run benchmark:report --results benchmark-results/<timestamp>

# Re-run corrected graders against persisted answers without invoking Codex.
bun run benchmark:regrade --results benchmark-results/<timestamp>
```

`--dry-run` validates pricing mode, repository commit, task manifests, prompts, condition selection, randomized execution order, and Codex/grader command plans. It does not create benchmark workspaces or run the empty-answer grader preflight.

## Execution and isolation

For a real run, the harness:

1. Resolves and records the target repository's exact `HEAD` commit.
2. Loads every selected task and validates its manifest, prompt, and grader directory.
3. Creates a fresh detached clone for every repetition and condition.
4. Removes any selected task root that is located inside the target clone.
5. Generates only the artifacts required by the condition.
6. Commits a local condition baseline and records its Git tree hash.
7. Starts a new `codex exec --ephemeral` process with a fresh `CODEX_HOME` containing only `auth.json` when file authentication is needed.
8. Persists JSONL events, stderr, the final answer, and workspace changes.
9. Runs the private grader outside the Codex workspace, followed by any declared regression/typecheck/build checks.
10. Deletes the workspace and isolated Codex home unless `--keep-workspaces` was requested.

`CODEX_THREAD_ID` is removed, resume is never used, user config and rules are ignored, approval is disabled, and reasoning effort is fixed to low. A prompt SHA-256 and baseline tree hash detect drift between treatments. Condition order is deterministically shuffled within each pair.

## Conditions

The three treatment factors are architecture index, declaration skeleton, and queryable call graph.

| CLI condition | Report label | Default | Index | Skeleton | Call graph |
|---|---|:---:|:---:|:---:|:---:|
| `regular-code` | Regular code | ✓ | — | — | — |
| `outline-only` | Architecture map only | ✓ | ✓ | — | — |
| `skeleton-only` | Skeleton only | ✓ | — | ✓ | — |
| `callgraph-only` | Call graph only | ✓ | — | — | ✓ |
| `outline-skeleton` | Architecture + skeleton | — | ✓ | ✓ | — |
| `outline-callgraph` | Architecture + call graph | — | ✓ | — | ✓ |
| `skeleton-callgraph` | Skeleton + call graph | — | — | ✓ | ✓ |
| `all-outline-aids` | Full MapBench (all three artifacts) | ✓ | ✓ | ✓ | ✓ |

`targeted` selects the five default rows: baseline, each artifact in isolation, and Full MapBench. `factorial` selects all eight. Generated conditions receive a neutral managed root `AGENTS.md` section that names available paths but supplies no navigation strategy. The generated `.project-outline/AGENTS.md` protocol and human Mermaid diagram are removed so they do not become extra treatment factors.

## How task grading works

Each task contains:

```text
tasks/<id>/
  task.json       manifest, grader command, and optional checks
  prompt.md       answer contract shown to Codex
  grader/         private rubric, expected facts, controls, or task-local executable
```

The grader runs after Codex exits. Command placeholders are expanded as follows:

| Placeholder | Value |
|---|---|
| `{workspace}` | Fresh target-repository clone |
| `{grader}` | Private task grader directory outside the agent workspace |
| `{sharedGraders}` | Reusable grader directory for the current source or packaged runtime |
| `{answer}` | Persisted final response |
| `{events}` | Persisted Codex JSONL event trace |

A grader must print a final JSON object with numeric `score` and positive `maxScore`, plus boolean `passed`. A run passes only when the grader process succeeds, the score reaches `maxScore`, and the grader does not declare failure. Missing regression/typecheck/build commands are recorded as `unavailable`, never as successful.

### Grader families

- `benchmark/graders/grade_json.py` checks weighted repository facts declared by a task rubric.
- `benchmark/graders/grade_localization.py` scores ranked symbols and derives source-retrieval metrics from real command events; answer-declared metrics are ignored.
- `benchmark/graders/grade_execution_path.py` checks real runtime nodes, edges, ordering, endpoint metadata, validation, and side effects.
- A task-local grader can enforce another answer or behavioral contract while using the same result schema.

These are deterministic graders, not LLM judges. Their score is only as meaningful as the rubric or behavioral test. Repository grounding proves expected paths/symbols exist and controls behave correctly; it does not prove that the chosen answer key captures every scientifically relevant fact.

### Controls and fail-closed behavior

Before any model invocation, the harness runs each selected grader against an empty answer in a clean clone. It aborts if the grader passes, reports a configuration error, or fails to emit the required JSON result.

`benchmark ask` creates a deterministic localization task by asking one read-only Codex authoring call for repository-grounded expected paths/symbols. It verifies every proposed artifact against the exact target commit, then runs a known-good positive answer and an empty negative answer through the real grader. Review the generated `grader/expected.json` before treating the task as publication-quality.

For implementation tasks, replace the generated localization grader with a private behavioral test that exercises the changed workspace. Do not use command attempts, decorative output, or self-reported metrics as evidence of success.

## Task creation

```bash
# Guided repository-grounded localization task.
bun run benchmark ask

# Manual fail-closed scaffold.
bun run benchmark init --repo ../target --task my-task
```

Both workflows default to the current checkout's top-level `tasks/` directory. Use `--tasks <directory>` for another root. Task IDs use lowercase letters, digits, and hyphens and should remain stable because result directories and regrading provenance reference them.

See [the task catalog](../tasks/README.md) for the bundled task IDs and intended target repositories.

## Results and provenance

Results are stored under `benchmark-results/<timestamp>/`:

```text
config.json          immutable commit, task, condition, model, isolation, and pricing inputs
summary.json         machine-readable aggregate and all run records
summary.md           concise text summary
report.html          self-contained report
graphics/figure-1-main-performance.svg
graphics/figure-2-task-condition-heatmap.svg
graphics/figure-3-efficiency-frontiers.svg
graphics/figure-4-navigation-cost.svg
graphics/figure-5-per-task-treatment-effect.svg
<condition>/<task>/run-*/
  events.jsonl
  stderr.log
  final-message.md
  changes.patch
  grader.json
  result.json
```

Failed and timed-out runs remain in the sample. Every aggregate uses the arithmetic mean of the three raw repetitions. Pair IDs support condition wins/losses/ties without discarding unmatched failures.

### Publication figures

The report emits a fixed five-figure set directly from `summary.runs`:

1. condition pass rates with 95% Wilson binomial intervals;
2. task × condition cells labeled with passes/repetitions;
3. pass rate against mean total tokens and mean runtime, with non-dominated frontiers;
4. per-run wall time to the first source edit, retaining no-edit runs as right-censored observations; and
5. per-task paired pass-rate effects for Full MapBench minus baseline.

Pass-rate figures use `hiddenGrader.passed`, never partial normalized grader scores. The paired effect uses only matching task/repetition `pairId` values. Token counts come from authoritative Codex usage events, and no source-size or source-byte proxy appears in the figure set.

Navigation telemetry comes from actual command and file-change events. The report uses elapsed wall-clock time to the first persisted source-code edit; runs without an edit are right-censored at the invocation duration. Live event arrival times are persisted for new runs, while legacy edited traces without timing remain unavailable rather than being estimated. This telemetry is diagnostic context, not the factual task score.

Token fields come only from Codex `turn.completed` usage events. Cached input is part of total input and is never double-counted. Unreported output/reasoning fields remain unavailable instead of being estimated from characters.

Pricing is fetched before paid runs from OpenRouter's single-model API and frozen in `config.json`. Lookup fails closed. Use `--pricing off` when cost estimates are intentionally unnecessary. `--pricing-model <author/slug>` maps a private deployment alias to its public price record.

Regrading clones the recorded target commit, reuses persisted answers and events, runs the current grader, and rebuilds summaries/reports without a model invocation. If the originally recorded task root no longer exists, bundled tasks are resolved from the current package layout.
