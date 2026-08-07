import { DatabaseAdapter } from "./adapters/database-adapter.js";
import { PaymentService } from "./domain/payment-service.js";
import { PaymentValidator } from "./domain/payment-validator.js";
import { HttpRouter } from "./http/http-router.js";
import { PaymentController } from "./http/payment-controller.js";
import { registerPaymentRoutes } from "./http/payment-routes.js";
import { PaymentRepository } from "./persistence/payment-repository.js";

export function createApplication(): HttpRouter {
  const database = new DatabaseAdapter();
  const repository = new PaymentRepository(database);
  const service = new PaymentService(repository);
  const validator = new PaymentValidator();
  const controller = new PaymentController(validator, service);
  const router = new HttpRouter();
  registerPaymentRoutes(router, controller);
  return router;
}
