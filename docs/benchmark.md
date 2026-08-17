# MapBench methodology

MapBench tests whether a specific generated mapping aid changes correctness or navigation efficiency on repository-level tasks. It keeps task accuracy separate from telemetry such as tokens, duration, cost, commands, and source reads.

## Core terms

| Term | Meaning |
|---|---|
| Task | One stable prompt, manifest, and private grader under `tasks/<id>/` |
| Condition | The exact subset of generated mapping aids placed in the workspace |
| Cell | One task × condition combination |
| Repetition | One fresh Pi process and sanitized workspace for a cell; exactly three are required |
| Pair | Runs sharing a task and repetition number across conditions, used for wins/losses/ties |

## Run a benchmark

Node.js 20+, Bun, and an authenticated `pi` CLI are required. The default provider is `openai-codex`; override it with `--provider` when needed.

```bash
# Inspect task/condition discovery and command plans without model execution.
bun run benchmark --repo ../target --task map-project --pricing off --dry-run

# Run the default five conditions, three fresh repetitions each.
bun run benchmark --repo ../target --task map-project

# Run all bundled tasks against a compatible target.
bun run benchmark --repo ../target --all

# Select another task root.
bun run benchmark --repo ../target --tasks ../shared-tasks --all

# Pin the official DeepSWE v1.1 definitions, then list or select tasks.
git clone https://github.com/datacurve-ai/deep-swe.git ../deep-swe
git -C ../deep-swe checkout 435ee89ec2f2e2289f33b0da4f992f0b7b7266b9
bun run benchmark --deepswe ../deep-swe --list-tasks
bun run benchmark --deepswe ../deep-swe --task abs-module-cache-flags
bun run benchmark --deepswe ../deep-swe --task abs-module-cache-flags --task actionlint-action-pinning-lint
bun run benchmark --deepswe ../deep-swe --task-set smoke

# Rebuild a report from an existing result directory.
bun run benchmark:report --results benchmark-results/<timestamp>

# Re-run corrected graders against persisted answers without invoking Pi.
bun run benchmark:regrade --results benchmark-results/<timestamp>
```

`--dry-run` validates pricing mode, repository commit, task manifests, prompts, condition selection, randomized execution order, and Pi/grader command plans. It does not create benchmark workspaces or run the empty-answer grader preflight.

## Execution and isolation

For a real run, the harness:

1. Resolves and records the target repository's exact `HEAD` commit.
2. Loads every selected task and validates its manifest, prompt, and grader directory.
3. Materializes a fresh detached clone for every repetition and condition, verifies the commit, removes `.git`, initializes a new repository, and strips only Cartograph's marker-delimited root `AGENTS.md` section while preserving unrelated project guidance. Removed task/grader files therefore cannot be recovered from the original object database.
4. Removes any selected task root that is located inside the target clone.
5. Generates the canonical structural IR internally, then exposes only the selected treatment. Architecture and skeleton projections live under `.mapbench/`; call-graph data stays outside the workspace and is reachable only through `mapbench_query`.
6. Supplies condition instructions directly with Pi's appended system prompt. The checked-out source tree remains readable in every condition, but the instructions name only the selected MapBench aids.
7. Commits a local condition baseline and records its Git tree hash.
8. Starts a new `pi --mode json --no-session` process with a fresh `PI_CODING_AGENT_DIR` containing only `auth.json` when file authentication is needed and, for Modal runs authenticated by profile, a private copy of `.modal.toml`.
9. Persists JSONL events, stderr, the final answer, and workspace changes.
10. Runs the private grader outside the Pi workspace, followed by any declared regression/typecheck/build checks.
11. Deletes the workspace, private treatment directory, and isolated Pi home unless `--keep-workspaces` was requested.

Pi is invoked with sessions, context files, discovered extensions, skills, prompt templates, themes, approval, and built-in tools disabled. A single explicit extension provides `read`, `grep`, `find`, and `ls`, rejects paths/symlinks outside the workspace, and blocks private harness directories. It registers `mapbench_query` only for conditions that include the call graph. Shell access is unavailable, so an ambient `cartograph` executable cannot reconstruct a withheld treatment. Thinking is fixed to low. A prompt SHA-256 and baseline tree hash detect drift between treatments, and condition order is deterministically shuffled within each pair.

Pi itself is not an operating-system sandbox. MapBench's model-visible isolation comes from the explicit tool allowlist and path guards; the sanitized temporary workspace and stripped environment provide the data boundary. If untrusted extensions or shell tools are added later, run the harness inside an OS container as an additional boundary.

The temporary layout for one run is:

```text
<temporary-run-root>/
  <task>-<run>-<condition>/       Pi working directory
    .git/                         new baseline only; no source-repository objects
    src/ ...                      complete target source in every condition
    AGENTS.md                     project content, with Cartograph's managed section removed
    .mapbench/                    absent unless architecture and/or skeleton is selected
      architecture.md             architecture conditions only
      skeleton/<source paths>     skeleton conditions only
  private-treatments/<cell>/      outside Pi's readable workspace
    callgraph.json                call-graph conditions only
    query.mjs                     invoked only by the harness-owned query tool
  <cell>-pi-home/
    auth.json / .modal.toml        optional provider and Modal profile credentials
```

The grader and result directory are also outside the working directory. Pi sees no shell or arbitrary process tool and receives this tool matrix:

| Condition | `read` / `grep` / `find` / `ls` over main source | `.mapbench/architecture.md` | `.mapbench/skeleton/` | `mapbench_query` |
|---|:---:|:---:|:---:|:---:|
| `regular-code` | ✓ | — | — | — |
| `outline-only` | ✓ | ✓ | — | — |
| `skeleton-only` | ✓ | — | ✓ | — |
| `callgraph-only` | ✓ | — | — | ✓ |
| Combined rows | ✓ | selected factor | selected factor | selected factor |

This means architecture-only can and should inspect `src/` normally; it simply cannot read the skeleton, call-graph files, helper, grader, Pi home, or original Git history.

For DeepSWE repository-edit tasks, Pi remains the harness process on the host, but its coding capabilities are split deliberately:

- Every DeepSWE condition is read/write: `read`, `grep`, `find`, `ls`, `edit`, and `write` are registered by the same path-guarded extension and operate only on the disposable sanitized working tree. This includes architecture-only, which can edit the real source and read its architecture map but cannot see the other MapBench treatments.
- `bash` is not a host shell. With the default Docker backend, the extension forwards each command to one task-image container with `/app` bound to the disposable working tree. With Modal, it synchronizes that same tree to the Sandbox before the command and back afterward; `read`/`edit`/`write` continue to operate on the synchronized guarded mirror.
- The agent and verifier environments apply each task's CPU and memory limits and disable networking. DeepSWE v1.1 tasks declare zero GPUs. The requested storage allocation is recorded as provenance because Modal's public Sandbox API does not expose a disk-quota parameter.
- The private `tests/` directory is never copied or mounted into the agent environment. A separate no-network verifier environment receives only the persisted model patch after Pi exits.
- The task source checkout must be clean and exactly match the pinned DeepSWE v1.1 revision; the repository commit and environment image come from validated task metadata.

Use `--deepswe <checkout> --task <id>` or the bounded `--task-set smoke`. Listing is explicit with `--deepswe <checkout> --list-tasks`; running every upstream task requires `--all` so an omitted selector cannot accidentally launch 113 × condition × repetition model calls.

### Docker and Modal backends

Docker remains the default and runs one task-condition cell at a time. Modal is opt-in for DeepSWE and permits independent cells to overlap while keeping each cell in a fresh Sandbox:

```bash
# One task on Modal
bun run benchmark -- --deepswe ../deep-swe --task abs-module-cache-flags \
  --backend modal --concurrency 1 --pricing off

# The bounded two-task smoke set, with at most four cells active
bun run benchmark -- --deepswe ../deep-swe --task-set smoke \
  --backend modal --concurrency 4 --pricing off

# Plan the identical task/condition/repetition matrix without contacting Modal
bun run benchmark -- --deepswe ../deep-swe --task-set smoke \
  --backend modal --concurrency 4 --pricing off --dry-run
```

Modal uses its normal `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` credentials (or `MODAL_PROFILE`). `--modal-app` defaults to `mapbench`; `--modal-environment`, `--modal-cloud`, and `--modal-region` select Modal placement without changing the task image. Each source extraction, agent run, and verifier run gets a distinct Sandbox created from the exact image in the pinned DeepSWE metadata. CPU and memory are set as both requests and hard limits, networking is blocked, and agent Sandboxes never receive `tests/`, `solution/`, or reference patches. Sandbox IDs, Modal SDK/runtime version, image, placement, requested resources, and concurrency are persisted in `config.json` and each `result.json`.

The harness synchronizes the disposable repository mirror to Modal around every Pi shell command. This gives the existing guarded Pi file tools and remote shell one coherent `/app` state without placing provider credentials or the Pi process inside the task image. A timed-out or failed cell still downloads any recoverable workspace state, terminates its Sandbox, and records a normal failed `RunResult`; one failed concurrent cell does not cancel its peers.

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
`targeted` selects the five default rows: baseline, each artifact in isolation, and Full MapBench. `factorial` selects all eight. The architecture-only workspace contains `.mapbench/architecture.md`; skeleton-only contains `.mapbench/skeleton/`; callgraph-only contains no visible MapBench files and receives only the `mapbench_query` tool. Combined conditions contain exactly their selected combination. Every row can inspect the complete main source. No row receives another treatment's files, generated AGENTS guidance, Mermaid, raw IR, or a shell capable of regenerating those artifacts.

## How task grading works

Each task contains:

```text
tasks/<id>/
  task.json       manifest, grader command, and optional checks
  prompt.md       answer contract shown to Pi
  grader/         private rubric, expected facts, controls, or task-local executable
```

The grader runs after Pi exits. Command placeholders are expanded as follows:

| Placeholder | Value |
|---|---|
| `{workspace}` | Fresh target-repository clone |
| `{grader}` | Private task grader directory outside the agent workspace |
| `{sharedGraders}` | Reusable grader directory for the current source or packaged runtime |
| `{answer}` | Persisted final response |
| `{events}` | Persisted Pi JSONL event trace |
| `{artifacts}` | Current run artifact directory outside the agent workspace |

A grader must print a final JSON object with numeric `score` and positive `maxScore`, plus boolean `passed`. A run passes only when the grader process succeeds, the score reaches `maxScore`, and the grader does not declare failure. Missing regression/typecheck/build commands are recorded as `unavailable`, never as successful.

### Grader families

- `benchmark/graders/grade_json.py` checks weighted repository facts declared by a task rubric.
- `benchmark/graders/grade_localization.py` scores ranked symbols and derives source-retrieval metrics from real command events; answer-declared metrics are ignored.
- `benchmark/graders/grade_execution_path.py` checks real runtime nodes, edges, ordering, endpoint metadata, validation, and side effects.
- A task-local grader can enforce another answer or behavioral contract while using the same result schema.

These are deterministic graders, not LLM judges. Their score is only as meaningful as the rubric or behavioral test. Repository grounding proves expected paths/symbols exist and controls behave correctly; it does not prove that the chosen answer key captures every scientifically relevant fact.

### Controls and fail-closed behavior

Before any model invocation, the harness runs each selected grader against an empty answer in a clean clone. It aborts if the grader passes, reports a configuration error, or fails to emit the required JSON result.

`benchmark ask` creates a deterministic localization task by asking one read-only Pi authoring call for repository-grounded expected paths/symbols. It verifies every proposed artifact against the exact target commit, then runs a known-good positive answer and an empty negative answer through the real grader. Review the generated `grader/expected.json` before treating the task as publication-quality.

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
graphics/figure-3a-mean-total-tokens.svg
graphics/figure-3b-mean-runtime.svg
graphics/figure-4-navigation-cost.svg
graphics/figure-5-per-task-treatment-effect.svg
graphics/figure-6-median-token-breakdown.svg
<condition>/<task>/run-*/
  events.jsonl
  stderr.log
  final-message.md
  changes.patch
  grader.json
  result.json
  deepswe/                    DeepSWE tasks only
    artifacts/model.patch     agent changes supplied to the verifier
    verifier/reward.json      official binary and partial scores
    verifier/ctrf.json        machine-readable test report
    verifier/test-stdout.txt  captured verifier output
```

Failed and timed-out runs remain in the sample. Every aggregate uses the arithmetic mean of the three raw repetitions. Pair IDs support condition wins/losses/ties without discarding unmatched failures.

### Publication figures

The report emits six figures (seven SVG files because Figure 3 is split into two cards) directly from `summary.runs`:

1. condition pass rates as a point plot;
2. task × condition pass rates as a heatmap;
3. pass rate against mean total tokens and mean runtime in separate scatterplots, without uncertainty whiskers;
4. per-run wall time to the first source edit, retaining no-edit runs as right-censored observations;
5. per-task paired pass-rate effects for Full MapBench minus baseline; and
6. the token breakdown of the median-total-token run for each condition.

Pass-rate figures use `hiddenGrader.passed`, never partial normalized grader scores. The paired effect uses only matching task/repetition `pairId` values. Token counts come from authoritative Pi usage events, and no source-size or source-byte proxy appears in the figure set.

Navigation telemetry comes from actual command and file-change events. The report uses elapsed wall-clock time to the first persisted source-code edit; runs without an edit are right-censored at the invocation duration. Live event arrival times are persisted for new runs, while legacy edited traces without timing remain unavailable rather than being estimated. This telemetry is diagnostic context, not the factual task score.

Token fields come only from assistant `message_end` events in Pi JSONL. Total input is `input + cacheRead + cacheWrite`; uncached input is `input + cacheWrite`. Pi's standard usage object does not split reasoning from output, so reasoning remains unavailable unless an extension explicitly emits it. Modeled cost prices Pi's authoritative output count once and never infers, subtracts, or double-charges reasoning.

Pricing is fetched before paid runs from OpenRouter's single-model API and frozen in `config.json`. Lookup fails closed. Use `--pricing off` when cost estimates are intentionally unnecessary. `--pricing-model <author/slug>` maps a private deployment alias to its public price record.

`benchmark:regrade` supports bundled answer-task runs: it clones the recorded target commit, reuses persisted answers and events, runs the current grader, and rebuilds summaries/reports without a model invocation. DeepSWE runs instead retain the submitted `model.patch` plus the official `reward.json`, CTRF report, and verifier logs in each immutable run artifact.
