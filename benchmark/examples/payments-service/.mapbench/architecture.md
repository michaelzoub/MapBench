<!-- @cartograph generated -->
# Architecture Index

This deterministic view is projected from one canonical structural representation. It distinguishes resolved static facts from external, heuristic, and unresolved boundaries; it does not infer runtime behavior.

## Repository / packages / services

### src/
- `src/adapters/database-adapter.ts` — 2 callables, 1 type declaration; 3 public
- `src/app.ts` — 1 callable; 1 public
- `src/domain/payment-service.ts` — 2 callables, 1 type declaration; 3 public
- `src/domain/payment-types.ts` — 2 type declarations; 2 public
- `src/domain/payment-validator.ts` — 1 callable, 1 type declaration; 2 public
- `src/http/http-router.ts` — 2 callables, 4 type declarations; 6 public
- `src/http/payment-controller.ts` — 2 callables, 1 type declaration; 3 public
- `src/http/payment-routes.ts` — 1 callable; 1 public
- `src/persistence/payment-repository.ts` — 2 callables, 1 type declaration; 3 public

## Major components and directories

- `src/adapters/database-adapter.ts` — module
- `src/app.ts` — module
- `src/domain/payment-service.ts` — module
- `src/domain/payment-types.ts` — module
- `src/domain/payment-validator.ts` — module
- `src/http/http-router.ts` — module
- `src/http/payment-controller.ts` — module
- `src/http/payment-routes.ts` — module
- `src/persistence/payment-repository.ts` — module

## Detected entrypoints and public surfaces

- `src/adapters/database-adapter.ts#DatabaseAdapter` — class DatabaseAdapter (src/adapters/database-adapter.ts:3:8)
- `src/adapters/database-adapter.ts#DatabaseAdapter.findPayment` — findPayment(id: string): PaymentRecord | undefined (src/adapters/database-adapter.ts:10:3)
- `src/adapters/database-adapter.ts#DatabaseAdapter.insertPayment` — insertPayment(payment: PaymentRecord): Promise<void> (src/adapters/database-adapter.ts:6:3)
- `src/app.ts#createApplication` — createApplication(): HttpRouter (src/app.ts:9:8)
- `src/domain/payment-service.ts#PaymentService` — class PaymentService (src/domain/payment-service.ts:5:8)
- `src/domain/payment-service.ts#PaymentService.constructor` — constructor(private readonly repository: PaymentRepository) (src/domain/payment-service.ts:6:3)
- `src/domain/payment-service.ts#PaymentService.execute` — execute(command: CreatePaymentCommand): Promise<PaymentRecord> (src/domain/payment-service.ts:8:3)
- `src/domain/payment-types.ts#CreatePaymentCommand` — interface CreatePaymentCommand (src/domain/payment-types.ts:1:8)
- `src/domain/payment-types.ts#PaymentRecord` — interface PaymentRecord (src/domain/payment-types.ts:7:8)
- `src/domain/payment-validator.ts#PaymentValidator` — class PaymentValidator (src/domain/payment-validator.ts:3:8)
- `src/domain/payment-validator.ts#PaymentValidator.validate` — validate(input: unknown): CreatePaymentCommand (src/domain/payment-validator.ts:4:3)
- `src/http/http-router.ts#HttpRequest` — interface HttpRequest (src/http/http-router.ts:1:8)
- `src/http/http-router.ts#HttpResponse` — interface HttpResponse (src/http/http-router.ts:5:8)
- `src/http/http-router.ts#HttpRouter` — class HttpRouter (src/http/http-router.ts:12:8)
- `src/http/http-router.ts#HttpRouter.dispatch` — dispatch(method: string, path: string, request: HttpRequest): Promise<HttpResponse> (src/http/http-router.ts:19:3)
- `src/http/http-router.ts#HttpRouter.post` — post(path: string, handler: RouteHandler): void (src/http/http-router.ts:15:3)
- `src/http/http-router.ts#RouteHandler` — type RouteHandler (src/http/http-router.ts:10:8)
- `src/http/payment-controller.ts#PaymentController` — class PaymentController (src/http/payment-controller.ts:5:8)
- `src/http/payment-controller.ts#PaymentController.constructor` — constructor( private readonly validator: PaymentValidator, private readonly service: PaymentService, ) (src/http/payment-controller.ts:6:3)
- `src/http/payment-controller.ts#PaymentController.create` — create(request: HttpRequest): Promise<HttpResponse> (src/http/payment-controller.ts:11:21)
- `src/http/payment-routes.ts#registerPaymentRoutes` — registerPaymentRoutes(router: HttpRouter, controller: PaymentController): void (src/http/payment-routes.ts:4:8)
- `src/persistence/payment-repository.ts#PaymentRepository` — class PaymentRepository (src/persistence/payment-repository.ts:4:8)
- `src/persistence/payment-repository.ts#PaymentRepository.constructor` — constructor(private readonly database: DatabaseAdapter) (src/persistence/payment-repository.ts:5:3)
- `src/persistence/payment-repository.ts#PaymentRepository.save` — save(payment: PaymentRecord): Promise<void> (src/persistence/payment-repository.ts:7:3)

## Component/module dependencies

- `src/adapters/database-adapter.ts → src/domain/payment-types.ts` — import
- `src/app.ts → src/adapters/database-adapter.ts` — import, instantiate
- `src/app.ts → src/domain/payment-service.ts` — import, instantiate
- `src/app.ts → src/domain/payment-validator.ts` — import, instantiate
- `src/app.ts → src/http/http-router.ts` — import, instantiate
- `src/app.ts → src/http/payment-controller.ts` — import, instantiate
- `src/app.ts → src/http/payment-routes.ts` — call, import
- `src/app.ts → src/persistence/payment-repository.ts` — import, instantiate
- `src/domain/payment-service.ts → src/domain/payment-types.ts` — import
- `src/domain/payment-service.ts → src/persistence/payment-repository.ts` — call, import
- `src/domain/payment-validator.ts → src/domain/payment-types.ts` — import
- `src/http/payment-controller.ts → src/domain/payment-service.ts` — call, import
- `src/http/payment-controller.ts → src/domain/payment-validator.ts` — call, import
- `src/http/payment-controller.ts → src/http/http-router.ts` — import
- `src/http/payment-routes.ts → src/http/http-router.ts` — call, import
- `src/http/payment-routes.ts → src/http/payment-controller.ts` — import
- `src/persistence/payment-repository.ts → src/adapters/database-adapter.ts` — call, import
- `src/persistence/payment-repository.ts → src/domain/payment-types.ts` — import

## Important execution flows

- `src/app.ts#createApplication` → `src/http/payment-routes.ts#registerPaymentRoutes` → `src/http/http-router.ts#HttpRouter.post`
- `src/http/payment-controller.ts#PaymentController.create` → `src/domain/payment-service.ts#PaymentService.execute` → `src/persistence/payment-repository.ts#PaymentRepository.save` → `src/adapters/database-adapter.ts#DatabaseAdapter.insertPayment`
- `src/http/payment-controller.ts#PaymentController.create` → `src/domain/payment-validator.ts#PaymentValidator.validate`

## External boundaries

- `src/domain/payment-service.ts#PaymentService.execute` — call node:crypto#randomUUID (src/domain/payment-service.ts:1:1)
- `src/domain/payment-service.ts#<module>` — import node:crypto (src/domain/payment-service.ts:1:1)

## Unresolved / dynamic boundaries

- `src/domain/payment-service.ts#PaymentService.execute` — call `Date` (src/domain/payment-service.ts:1:1) — dynamic, callback, or ambiguous resolution
- `src/domain/payment-service.ts#PaymentService.execute` — call `new Date().toISOString` (src/domain/payment-service.ts:1:1) — dynamic, callback, or ambiguous resolution
- `src/domain/payment-validator.ts#PaymentValidator.validate` — call `Error` (src/domain/payment-validator.ts:1:1) — dynamic, callback, or ambiguous resolution
- `src/domain/payment-validator.ts#PaymentValidator.validate` — call `Number.isInteger` (src/domain/payment-validator.ts:1:1) — dynamic, callback, or ambiguous resolution

## Analysis coverage and limitations

- Tool/schema: `cartograph` / 1
- Languages: typescript
- Files scanned: 9; skipped: 0; parse failures: 0
- Declarations: 24; relationships: 38; unresolved: 4
- Known: resolved edges are parser/linker evidence anchored to source locations.
- Heuristic or incomplete: exported surfaces and root flows are static indicators, not runtime registration or execution proof.
- Limitations: dynamic dispatch, reflection, callbacks, dependency injection, generated code, and runtime configuration may be unresolved.

## Static Call Roots

Static roots are callable declarations with no resolved repository callers and at least one resolved outgoing call. They are navigation hints, not guaranteed runtime entrypoints.

- `src/app.ts#createApplication` — `src/app.ts:9:8`
- `src/http/payment-controller.ts#PaymentController.create` — `src/http/payment-controller.ts:11:21`
