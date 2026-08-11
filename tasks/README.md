# Eval task catalog

This directory contains benchmark definitions, not harness implementation. Folder names are stable task IDs used by CLI selection, result paths, pair IDs, and regrading provenance.

## Bundled tasks

| Task ID | Intended target | What the answer must establish | Grader |
|---|---|---|---|
| `explain-system-architecture` | Bundled `payments-service` example | Components, registration, and normal request flow | Weighted rubric facts |
| `issue-to-symbol-localization` | Bundled `payments-service` example | Ranked symbols for lowercase currency validation | Ranked localization + real-source budget |
| `reconstruct-payment-execution-path` | Bundled `payments-service` example | HTTP-to-database nodes, edges, ordering, validation, and side effects | Execution-path grader |
| `map-project` | Research-agent repository | CLI boundary, orchestration, loop, state, persistence, and validation | Weighted rubric facts |
| `pinpoint-worker-delegation` | Research-agent repository | Delegation assembly, admission, budget, isolation, and nested execution | Weighted rubric facts |
| `trace-cli-entrypoint` | Research-agent repository | `autore` entrypoint, direct calls, runtime flow, and conditional branches | Weighted rubric facts |
| `trace-final-answer-validation` | Research-agent repository | Validator construction, call site, policy outcomes, and revision limit | Weighted rubric facts |
| `map-architecture-find-smartcontract-creation` | x402 marketplace repository | High-level components and contract deployment evidence | Task-local expected-artifact grader |
| `trace-async-payout-after-http-settlement` | x402 marketplace repository | Settlement boundary, state machines, two transactions, worker flow, and replay guards | Task-local weighted rubric grader |

Not every task is compatible with every repository. `--all` means every task in the selected task root; it does not infer target compatibility.

## Task anatomy

```text
<task-id>/
  task.json
  prompt.md
  grader/
```

- `task.json` is the versioned manifest. Its `id` must match the directory name. It declares the human title, prompt file, grader command, timeout, and optional regression/typecheck/build checks.
- `prompt.md` is the exact task contract given to every condition. It must not reveal the answer key.
- `grader/` is private evaluator data. It can contain a rubric, expected artifacts, positive/negative controls, or a task-local executable.

Reusable grader executables live in `benchmark/graders/`. Task-local graders stay beside their rubric when their logic is specific to one task.

The harness expands `{workspace}`, `{grader}`, `{sharedGraders}`, `{answer}`, and `{events}` in grader/check commands. A grader must end with JSON containing numeric `score`, positive `maxScore`, and boolean `passed`.

## Discover and validate tasks

```bash
# List all bundled tasks as part of a dry-run plan.
bun run benchmark --repo ../compatible-target --all --pricing off --dry-run

# Validate one task's manifest, prompt, and command plan.
bun run benchmark --repo ../target --task trace-async-payout-after-http-settlement --pricing off --dry-run

# Exercise shared graders, controls, and the complete benchmark harness.
bun run benchmark:test
```

See [Benchmark methodology](../docs/benchmark.md) for isolation, conditions, scoring, controls, and results.
