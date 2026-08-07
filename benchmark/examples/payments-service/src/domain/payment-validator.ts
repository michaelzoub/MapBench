import type { CreatePaymentCommand } from "./payment-types.js";

export class PaymentValidator {
  validate(input: unknown): CreatePaymentCommand {
    if (!input || typeof input !== "object") throw new Error("payment body is required");
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.accountId !== "string" || candidate.accountId.length === 0) {
      throw new Error("accountId is required");
    }
    if (!Number.isInteger(candidate.amountCents) || Number(candidate.amountCents) <= 0) {
      throw new Error("amountCents must be a positive integer");
    }
    // Deliberate benchmark bug: supported lowercase currency codes are rejected.
    if (candidate.currency !== "CAD" && candidate.currency !== "USD") {
      throw new Error("currency must be CAD or USD");
    }
    return candidate as unknown as CreatePaymentCommand;
  }
}
