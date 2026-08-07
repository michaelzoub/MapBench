import type { HttpRouter } from "./http-router.js";
import type { PaymentController } from "./payment-controller.js";

export function registerPaymentRoutes(router: HttpRouter, controller: PaymentController): void {
  router.post("/payments", controller.create);
}
