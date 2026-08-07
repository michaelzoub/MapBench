import type { HttpRequest, HttpResponse } from "./http-router.js";
import type { PaymentService } from "../domain/payment-service.js";
import type { PaymentValidator } from "../domain/payment-validator.js";

export class PaymentController {
  constructor(
    private readonly validator: PaymentValidator,
    private readonly service: PaymentService,
  ) {}

  readonly create = async (request: HttpRequest): Promise<HttpResponse> => {
    const command = this.validator.validate(request.body);
    const payment = await this.service.execute(command);
    return { status: 201, body: payment };
  };
}
