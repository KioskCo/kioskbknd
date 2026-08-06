/**
 * Paystack fee helpers.
 *
 * Split deduction model:
 *   - At checkout  → the payment processing fee (1.5% + ₦100) is added to the
 *     buyer's total and recorded on the order as `commission`.
 *   - At withdrawal → Paystack's transfer fee is deducted from the vendor's
 *     wallet on top of the amount they are sending.
 *
 * Both figures are authoritative server-side; the kioskm/shop clients mirror
 * them for display only.
 */

export type PaymentProvider = "paystack" | "flutterwave";

export const PROCESSING_FEE_RATE = 0.015; // 1.5%
export const PROCESSING_FEE_FLAT = 100;   // ₦100 per transaction

// Flutterwave local-cards rate in Nigeria: 1.4% + ₦100.
export const FLUTTERWAVE_FEE_RATE = 0.014;
export const FLUTTERWAVE_FEE_FLAT = 100;

/** Paystack charges 1.5% + ₦100; Flutterwave 1.4% + ₦100 on local cards. */
export function computeProcessingFee(amount: number, provider?: PaymentProvider): number {
  if (amount <= 0) return 0;
  if (provider === "flutterwave") {
    return Math.ceil(amount * FLUTTERWAVE_FEE_RATE + FLUTTERWAVE_FEE_FLAT);
  }
  return Math.ceil(amount * PROCESSING_FEE_RATE + PROCESSING_FEE_FLAT);
}

/** Paystack transfer fee: flat ₦10 for amounts above ₦5,000, else free. */
export function computeTransferFee(amount: number): number {
  if (amount <= 0) return 0;
  return amount > 5_000 ? 10 : 0;
}