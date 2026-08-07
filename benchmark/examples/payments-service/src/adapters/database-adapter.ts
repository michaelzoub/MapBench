import type { PaymentRecord } from "../domain/payment-types.js";

export class DatabaseAdapter {
  private readonly payments = new Map<string, PaymentRecord>();

  async insertPayment(payment: PaymentRecord): Promise<void> {
    this.payments.set(payment.id, payment);
  }

  findPayment(id: string): PaymentRecord | undefined {
    return this.payments.get(id);
  }
}
