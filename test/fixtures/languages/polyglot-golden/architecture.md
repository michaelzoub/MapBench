<!-- @cartograph generated -->
# Architecture Index

This deterministic view is projected from one canonical structural representation. It distinguishes resolved static facts from external, heuristic, and unresolved boundaries; it does not infer runtime behavior.

## Repository / packages / services

### go/
- `go/main.go` — 1 callable
### python/
- `python/main.py` — 1 callable; 1 public
### rust/
- `rust/main.rs` — 1 callable
### src/
- `src/legacy.js` — 1 callable; 1 public
- `src/main.ts` — 1 callable; 1 public

## Major components and directories

- `go/main.go` — module
- `python/main.py` — module
- `rust/main.rs` — module
- `src/legacy.js` — module
- `src/main.ts` — module

## Detected entrypoints and public surfaces

- `python/main.py#python_entry` — python_entry() -> None (python/main.py:1:1)
- `src/legacy.js#legacy` — legacy() (src/legacy.js:1:8)
- `src/main.ts#typed` — typed(): void (src/main.ts:1:8)

## Component/module dependencies

No resolved cross-module dependencies were detected.

## Important execution flows

No resolved multi-symbol execution flows were detected.

## External boundaries

No external boundaries were detected.

## Unresolved / dynamic boundaries

No unresolved relationships were detected.

## Analysis coverage and limitations

- Tool/schema: `cartograph` / 1
- Languages: typescript, javascript, python, go, rust
- Files scanned: 5; skipped: 0; parse failures: 0
- Declarations: 5; relationships: 0; unresolved: 0
- Known: resolved edges are parser/linker evidence anchored to source locations.
- Heuristic or incomplete: exported surfaces and root flows are static indicators, not runtime registration or execution proof.
- Limitations: dynamic dispatch, reflection, callbacks, dependency injection, generated code, and runtime configuration may be unresolved.

## Static Call Roots

Static roots are callable declarations with no resolved repository callers and at least one resolved outgoing call. They are navigation hints, not guaranteed runtime entrypoints.

No connected static roots were detected.
