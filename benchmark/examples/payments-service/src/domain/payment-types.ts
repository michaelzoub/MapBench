export interface CreatePaymentCommand {
  accountId: string;
  amountCents: number;
  currency: "CAD" | "USD";
}

export interface PaymentRecord extends CreatePaymentCommand {
  id: string;
  createdAt: string;
}
