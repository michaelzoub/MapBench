# project-outline

`project-outline` creates deterministic architecture aids for TypeScript/JavaScript and Python repositories: a declaration-only source skeleton, a human-readable Mermaid architecture diagram, a compact architecture index, and a statically resolved call graph. It keeps source paths, repository-local imports, declarations, and symbol signatures while replacing implementations with compact relationship metadata. Function bodies show only repository callees, constructed classes, and unresolved dynamic calls; ordinary control flow and implementation details are removed.

## Outputs

For humans:

- Use the generated **skeleton** under `.project-outline/` to quickly inspect the project's functions, classes, imports, and signatures without reading full implementations.
- Open `.project-outline/architecture.mmd` as a **Mermaid architecture diagram** to understand how the system fits together. It is a bounded module-level view of important repository call, construction, and external-dependency relationships—not a dump of the full symbol call graph.

For agents:

- Read `.project-outline/architecture.md` for the compressed high-level map.
- Use `.project-outline/callgraph.json` (preferably through `project-outline query`) for precise symbol, caller, callee, construction, and boundary relationships.
- Read real source code only when implementation details or dynamic runtime behavior cannot be established from those artifacts.

Every artifact is generated programmatically from the same static analysis. The Mermaid diagram is deterministic and does not use an LLM.

## Usage

From a source checkout, install dependencies once and regenerate the repository outline with:

```bash
npm install
npm run outline
```

The `outline` script emits the local CLI without running the full repository typecheck, copies its runtime assets, and writes `.project-outline/`. Pass generator options after `--`:

```bash
npm run outline -- --root . --out .project-outline
npm run outline -- --language typescript
npm run outline -- --language python
```

To install the CLI command globally while developing this package, run `npm run build` followed by `npm link`. The installed CLI supports:

```bash
project-outline generate
project-outline generate --root . --out .project-outline
project-outline generate --language typescript
project-outline generate --language python
project-outline watch
project-outline clean
project-outline init
project-outline query "WorkerManager.process"
```

`--out` is resolved relative to `--root` and must remain inside that repository. The tool never writes to source files. Existing output is only updated or removed when every file in it has a recognized generated-file marker.

Before generation, the CLI inspects meaningful source files and project metadata. It ignores HTML, CSS, shell scripts, tests, generated code, migrations, configuration files, dependencies, and common build or infrastructure directories. A clearly dominant supported language is selected; repositories with meaningful application code in both language families receive both outlines. Detection failures explain how to use `--language typescript` or `--language python`.

The TypeScript parser reads a root `tsconfig.json` or `jsconfig.json` when present, including compiler options and path aliases. The Python parser requires Python 3.9 or newer (override its executable with `PROJECT_OUTLINE_PYTHON`) and uses the standard-library AST rather than text matching. It preserves functions, async functions, class signatures, inheritance, methods, decorators, annotations, defaults, dataclasses, enums, protocols, local imports, and meaningful module declarations. Function and method bodies, docstrings, comments, external imports, and declaration values that may contain configuration or secrets are removed.

Generation mirrors source paths under `.project-outline/`, writes deterministic `.project-outline/callgraph.json`, `.project-outline/architecture.md`, and `.project-outline/architecture.mmd` artifacts, and creates `.project-outline/AGENTS.md`. The Markdown architecture index groups callable symbols by module, identifies static root symbols, and lists bounded representative execution chains so an agent can answer system-level questions before opening implementation files. The Mermaid architecture aggregates that same call graph into a bounded module-level visualization, marks likely entry modules, combines repeated call and construction edges, and includes only the most relevant external dependency boundaries. `project-outline init` creates or updates a managed section in the repository's root `AGENTS.md` without replacing existing instructions. Only `init` writes outside the output directory.

The call graph contains repository functions, class methods, and constructors from every detected language. Symbol IDs and every `calls` / `calledBy` reference always use `<repository-relative file>#<qualified symbol>` (for example, `src/jobs.ts#Queue.run`), so references stay unique and stable when similarly named code is added elsewhere. Each entry includes a 1-based `file`, `line`, and `column` jump target plus its signature.

`calls` is the sorted set of statically resolved repository callees. When lexical order differs, the optional `callsInSourceOrder` field records each callee's first source occurrence; it is not a runtime execution trace. `instantiates` names repository types as `<file>#<qualified type>`. Dynamic or ambiguous sites that may target project code are kept in `unresolvedProjectCalls`, while imported package APIs are kept separately in `externalCalls` and qualified by their import source (for example, `zod#z.number().parse`). Trivial language built-ins and standard collection/string helpers are omitted. Statically supplied callbacks become navigable project edges while the parameter invocation remains unresolved because runtime callers may supply other targets. Optional relationship fields are omitted when empty to limit artifact size.

## Development

```bash
npm test
```

Tests copy repository fixtures into temporary directories and verify exact generated output, exclusions, stale-file cleanup, and safe output boundaries.

## Codex benchmark

The package includes a reproducible, paired benchmark for measuring whether the generated outline helps Codex solve repository-level tasks. Node.js 20+ and an authenticated `codex` CLI are required. From a source checkout, the equivalent development command is `bun run benchmark -- ...`.

```bash
project-outline benchmark ask
project-outline benchmark init --repo ../my-project --task trace-checkout
project-outline benchmark --repo ../my-project --task trace-checkout --runs 3
project-outline benchmark --repo ../my-project --tasks ../shared-evals --all --runs 3
project-outline benchmark --repo ../my-project --task trace-checkout --conditions regular-code,all-outline-aids
project-outline benchmark --repo ../my-project --task trace-checkout --conditions factorial
bun run benchmark --repo ../research-agent
bun run benchmark --repo ../research-agent --task map-project --runs 3
bun run benchmark --repo ../research-agent --all --runs 3
bun run benchmark --repo ../research-agent --task pinpoint-worker-delegation --conditions regular-code,all-outline-aids
bun run benchmark --repo ../research-agent --task trace-cli-entrypoint --model gpt-5.6-terra
bun run benchmark --repo ../research-agent --task map-project --model private-alias --pricing-model openai/gpt-5.6-terra
bun run benchmark --repo ../research-agent --task map-project --pricing off
bun run benchmark --repo ../research-agent --task map-project --dry-run
bun run benchmark --repo ../research-agent --task map-project --keep-workspaces
bun run benchmark --example payments-service --runs 3 --debug-usage
bun run benchmark --example payments-service --task issue-to-symbol-localization --conditions regular-code,all-outline-aids
bun run benchmark --example payments-service --task reconstruct-payment-execution-path --pricing off --dry-run
bun run benchmark:report --results benchmark-results/<timestamp>
bun run benchmark:regrade --results benchmark-results/<timestamp>
```

For the shortest custom-eval workflow, run `bun run benchmark ask` from a source checkout (or `project-outline benchmark ask` after installation). The wizard asks for the repository path, task name, and repository-level question. It then uses one read-only Codex call against an exact clone of the repository's current `HEAD` to propose private file/symbol ground truth, verifies every proposed path and symbol against that commit, and runs a known-good answer plus an empty-answer negative control through the real grader. After showing where the private grader was written, it asks whether to launch the four targeted conditions. The default is three repetitions, or 12 benchmark model runs for one task. Use `--no-run` to create only, `--dry-run` to create and print the execution plan, or `--run` to skip the final confirmation.

The authored grader is deliberately a deterministic repository-localization grader: the evaluated answer must identify the files and symbols that establish the answer. It does not use an LLM judge during benchmark scoring. Review `.project-outline-evals/<task>/grader/expected.json` before treating results as publication-quality; automatic grounding verifies provenance and controls, not the scientific judgment that the selected evidence fully captures the question.

`benchmark init` remains available for manual setup. It creates `.project-outline-evals/<id>/` in the target project with a prompt, a fail-closed expected-artifact grader, and a manifest. Replace the prompt and the placeholder file/symbol expectations, then run the benchmark. A project-local task root is selected automatically; use `--tasks <directory>` to keep or share eval definitions elsewhere. Project-local eval and grader files are deleted from every disposable agent clone before the run, even if they are committed, so the answer key is not visible to Codex.

The generated grader is intended for repository navigation and localization questions. For implementation evals, replace its command with a private behavioral test that exercises the changed workspace and emits a final JSON object containing `score`, `maxScore`, and `passed`. Before any model invocation, the harness runs every grader against an empty answer in a clean clone and aborts if the grader passes, is misconfigured, or does not emit the required result. This negative control prevents a no-op or broken grader from producing persuasive efficiency numbers.

Each run uses a new local clone checked out at the same recorded target commit. Codex never runs in the source repository. The harness also creates a fresh `CODEX_HOME` for every run, copies only `auth.json` when file-based authentication is required, starts a new `codex exec --ephemeral` process without any resume/session argument, and removes that home after the result is persisted. `CODEX_THREAD_ID` is explicitly removed from the child environment. The recorded baseline Git tree hash proves that repetitions of a condition received byte-identical repository and generated Project Outline artifacts; a recorded prompt SHA-256 proves that all treatments received the same prompt. The benchmark aborts on either kind of drift. Condition order is deterministically randomized within each task/run pair, while `pairId` retains the pairing used for wins, losses, and ties.

Benchmark Codex runs always use exactly three independent repetitions for every selected task/condition cell, on `gpt-5.6-terra` with low reasoning effort by default. Reports preserve all three raw values and use their arithmetic mean for every aggregate. The default four targeted conditions are regular code and each of architecture map, call graph, and skeleton alone. This design tests each generated artifact directly without paying for multi-artifact combinations. A bundled example selects its three compatible tasks by default: high-level architecture explanation, issue-to-symbol localization, and `POST /payments` execution-path reconstruction. Passing `--task` deliberately selects a subset. `--model` can select another model; reasoning remains fixed to low so every condition uses the same cost and latency profile. Partial targeted selections emit an explicit warning.

The payments example is materialized as a temporary Git repository and never mutates `benchmark/examples/payments-service`. It contains a real dynamic route registry, controller, validator, domain service, repository, database adapter, runnable test, and a deliberate lowercase-currency validation issue. This makes the path eval test both static graph navigation and the source verification needed at a dynamic dispatch boundary.

Use `--conditions targeted` to select the default four explicitly, `--conditions factorial` to opt into the complete 2³ design, or a comma-separated condition list for a smaller exploratory run. Multi-artifact combinations are not run by default. Report labels are inclusion-based so a standalone graph says exactly what each condition received. “Regular code” is the repository without generated project-outline aids.

| CLI condition | Report label | Default | Architecture map | Skeleton | Call graph |
|---|---|:---:|:---:|:---:|:---:|
| `regular-code` | Regular code | ✓ | — | — | — |
| `outline-only` | Architecture map only | ✓ | ✓ | — | — |
| `skeleton-only` | Skeleton only | ✓ | — | ✓ | — |
| `callgraph-only` | Call graph only | ✓ | — | — | ✓ |
| `outline-skeleton` | Architecture + skeleton | — | ✓ | ✓ | — |
| `outline-callgraph` | Architecture + call graph | — | ✓ | — | ✓ |
| `skeleton-callgraph` | Skeleton + call graph | — | — | ✓ | ✓ |
| `all-outline-aids` | All three artifacts | — | ✓ | ✓ | ✓ |

Here, the **architecture map** is one high-level `.project-outline/architecture.md` index of modules, roots, and representative execution chains. The **skeleton** is different: it is a mirrored source tree containing file structure, imports, declarations, and signatures with implementation bodies removed. The **call graph** is `callgraph.json` plus the query helper. To avoid confounding artifact quality with hidden-directory discovery, generated conditions receive the same neutral managed root `AGENTS.md` section naming the available paths. That notice supplies no navigation strategy, and the generated `.project-outline/AGENTS.md` protocol is removed from every benchmark workspace.

`--dry-run` validates live pricing, the repository commit, task manifests, prompts, conditions, execution order, and the exact Codex and grader command plans without creating workspaces or invoking Codex. The empty-answer grader preflight runs at the start of a real benchmark because it intentionally uses a disposable clone.

Results are written below `benchmark-results/<timestamp>/`. Every condition contains task/run subdirectories with `events.jsonl`, `stderr.log`, `final-message.md`, `changes.patch`, `grader.json`, and `result.json`. With `--debug-usage`, each run also contains `usage-events.json`, preserving the exact raw `turn.completed` usage event(s) beside the parsed metrics. Token fields come only from those Codex JSONL events. Codex `input_tokens` is reported as total input and includes `cached_input_tokens`; uncached input is the exact difference of those authoritative fields. Cached input is therefore never added again when calculating total tokens or token cost. Output and reasoning output remain unavailable when Codex does not report them; total is either Codex's reported total or the exact sum of authoritative total input and output fields, with every derivation recorded in provenance. No tokenizer or character estimate is used. The top level contains the immutable run configuration, machine-readable summary, Markdown summary, self-contained HTML report, and standalone SVG graphics. Reports keep factual correctness separate from efficiency. The focused chart set covers the condition design, task-level accuracy and comparisons, arithmetic-mean accuracy/tokens/time/cost, token composition, paired outcomes, and one duplicate-source-read diagnostic. Detailed raw-run, token-provenance, command, file, navigation-output, and evaluator metrics remain available in the report tables and machine-readable summary without producing a separate graph for each measure. Every standalone graph includes a separate condition legend. Failed and timed-out runs remain in the sample rather than disappearing from the report.

If a private grader is corrected, `benchmark:regrade` reuses the persisted final responses, grades them against a fresh clean clone of the recorded commit, rebuilds the summary and report, and writes `regrade.json`. It never invokes Codex, so evaluator fixes do not incur model cost or change the recorded behavior traces.

### Tasks and private graders

Bundled tasks live in `benchmark/tasks/<id>/`; custom tasks use the same structure under `.project-outline-evals/<id>/` or a directory passed with `--tasks`:

```text
task.json
prompt.md
grader/          # never copied into the Codex workspace
```

The prompt must describe behavior without revealing the answer. The grader command runs only after Codex exits and should print a final JSON line containing numeric `score` and `maxScore` fields plus boolean `passed`. Hidden behavioral-test score is the primary accuracy metric. The placeholders `{workspace}`, `{grader}`, `{answer}`, and `{events}` give the command access to the disposable repository, private grader directory, persisted final response, and real Codex event trace. Regression, typecheck, and build commands are declared separately; absent commands are recorded as `unavailable` rather than treated as success.

Before creating any benchmark workspace or invoking Codex, the harness fetches the selected model's current token prices from OpenRouter's public single-model API. Common unqualified model names are mapped to their OpenRouter author (`gpt-*` to `openai/*`, `claude-*` to `anthropic/*`, and `gemini-*` to `google/*`). Use `--pricing-model <author/slug>` for a deployment alias. The source URL, resolved model ID, canonical slug, retrieval time, prices, and any estimation limitations are frozen into `config.json`, so every run in the result set uses the same price snapshot.

Pricing lookup fails closed: an unavailable or malformed provider response stops the benchmark before paid model runs begin. Use `--pricing off` only when cost estimates are intentionally unnecessary. OpenRouter sometimes publishes context-length overrides; Codex's JSON stream reports aggregate turn usage rather than every request's prompt length, so the report records that limitation and uses base token prices instead of pretending the tier can be selected exactly.

Harness tests cover clone isolation, exact ablation contents, hidden-grader isolation, Codex JSONL parsing, token and cost accounting, timeouts, paired summaries, and deterministic report generation:

```bash
bun run benchmark:test
```
