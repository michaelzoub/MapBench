import type { DatabaseAdapter } from "../adapters/database-adapter.js";
import type { PaymentRecord } from "../domain/payment-types.js";

export class PaymentRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  async save(payment: PaymentRecord): Promise<void> {
    await this.database.insertPayment(payment);
  }
}
