<!-- @cartograph generated -->
# Architecture Index

This deterministic view is projected from one canonical structural representation. It distinguishes resolved static facts from external, heuristic, and unresolved boundaries; it does not infer runtime behavior.

## Repository / packages / services

### src/
- `src/storage/candidate-store.ts` — 2 callables, 2 type declarations; 4 public
- `src/types.ts` — 3 type declarations; 3 public
- `src/workers/worker-manager.ts` — 6 callables, 1 type declaration; 6 public

## Major components and directories

- `src/storage/candidate-store.ts` — module
- `src/types.ts` — module
- `src/workers/worker-manager.ts` — module

## Detected entrypoints and public surfaces

- `src/storage/candidate-store.ts#CandidateStore` — class CandidateStore (src/storage/candidate-store.ts:7:8)
- `src/storage/candidate-store.ts#CandidateStore.constructor` — constructor(public readonly options: StoreOptions) (src/storage/candidate-store.ts:10:3)
- `src/storage/candidate-store.ts#CandidateStore.find` — find(id: string): Promise<Candidate | undefined> (src/storage/candidate-store.ts:14:3)
- `src/storage/candidate-store.ts#StoreOptions` — interface StoreOptions (src/storage/candidate-store.ts:3:8)
- `src/types.ts#Candidate` — interface Candidate (src/types.ts:1:8)
- `src/types.ts#Evaluation` — type Evaluation (src/types.ts:6:8)
- `src/types.ts#WorkerState` — enum WorkerState (src/types.ts:11:8)
- `src/workers/worker-manager.ts#WorkerManager` — class WorkerManager (src/workers/worker-manager.ts:8:8)
- `src/workers/worker-manager.ts#WorkerManager.constructor` — constructor( private readonly store: CandidateStore, public retries = undefined, ) (src/workers/worker-manager.ts:16:3)
- `src/workers/worker-manager.ts#WorkerManager.map` — map(candidate: TCandidate, callback: (value: TCandidate) = undefined): TResult (src/workers/worker-manager.ts:29:3)
- `src/workers/worker-manager.ts#WorkerManager.process` — process(candidate: TCandidate): Promise<Evaluation> (src/workers/worker-manager.ts:23:3)
- `src/workers/worker-manager.ts#createWorker` — createWorker(store: CandidateStore) (src/workers/worker-manager.ts:42:29)
- `src/workers/worker-manager.ts#normalizeId` — normalizeId(id = undefined) (src/workers/worker-manager.ts:44:8)

## Component/module dependencies

- `src/storage/candidate-store.ts → src/types.ts` — import
- `src/workers/worker-manager.ts → src/storage/candidate-store.ts` — call, import, instantiate
- `src/workers/worker-manager.ts → src/types.ts` — import

## Important execution flows

- `src/workers/worker-manager.ts#WorkerManager.process` → `src/storage/candidate-store.ts#CandidateStore.find`
- `src/workers/worker-manager.ts#bootstrap` → `src/workers/worker-manager.ts#createWorker`

## External boundaries

- `src/workers/worker-manager.ts#<module>` — import node:crypto (src/workers/worker-manager.ts:1:1)
- `src/workers/worker-manager.ts#<module>` — import zod (src/workers/worker-manager.ts:1:1)
- `src/workers/worker-manager.ts#WorkerManager.process` — call zod#z.number().parse (src/workers/worker-manager.ts:26:48)

## Unresolved / dynamic boundaries

- `src/workers/worker-manager.ts#WorkerManager.map` — call `callback` (src/workers/worker-manager.ts:30:12) — dynamic, callback, or ambiguous resolution

## Analysis coverage and limitations

- Tool/schema: `cartograph` / 1
- Languages: typescript
- Files scanned: 3; skipped: 0; parse failures: 0
- Declarations: 14; relationships: 12; unresolved: 1
- Known: resolved edges are parser/linker evidence anchored to source locations.
- Heuristic or incomplete: exported surfaces and root flows are static indicators, not runtime registration or execution proof.
- Limitations: dynamic dispatch, reflection, callbacks, dependency injection, generated code, and runtime configuration may be unresolved.

## Static Call Roots

Static roots are callable declarations with no resolved repository callers and at least one resolved outgoing call. They are navigation hints, not guaranteed runtime entrypoints.

- `src/workers/worker-manager.ts#WorkerManager.process` — `src/workers/worker-manager.ts:23:3`
- `src/workers/worker-manager.ts#bootstrap` — `src/workers/worker-manager.ts:48:1`
