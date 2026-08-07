import { randomUUID } from "node:crypto";
import type { PaymentRepository } from "../persistence/payment-repository.js";
import type { CreatePaymentCommand, PaymentRecord } from "./payment-types.js";

export class PaymentService {
  constructor(private readonly repository: PaymentRepository) {}

  async execute(command: CreatePaymentCommand): Promise<PaymentRecord> {
    const payment: PaymentRecord = {
      ...command,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.repository.save(payment);
    return payment;
  }
}
