/**
 * Paystack payment service.
 *
 * Paystack is the primary payment gateway for Nigerian merchants.
 * Docs: https://paystack.com/docs/api/
 *
 * Required environment variable:
 *   PAYSTACK_SECRET_KEY — starts with "sk_live_" (or "sk_test_" for dev)
 */

import { logger } from "./logger";

const PAYSTACK_KEY = process.env["PAYSTACK_SECRET_KEY"] ?? "";
const BASE_URL = "https://api.paystack.co";

/** Common headers for every Paystack API call. */
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${PAYSTACK_KEY}`,
    "Content-Type": "application/json",
  };
}

// ─── Initialize a transaction ─────────────────────────────────────────────────

export interface InitializeResult {
  authorizationUrl: string; // redirect buyer to this URL
  accessCode: string;
  reference: string;
}

export async function initializeTransaction(params: {
  email: string;
  amountKobo: number;      // Paystack uses kobo (100 kobo = ₦1)
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}): Promise<InitializeResult> {
  if (!PAYSTACK_KEY) {
    logger.warn("PAYSTACK_SECRET_KEY not set — returning mock payment URL");
    return {
      authorizationUrl: `https://paystack.com/pay/dev-${params.reference}`,
      accessCode: "dev-access-code",
      reference: params.reference,
    };
  }

  const res = await fetch(`${BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email: params.email,
      amount: params.amountKobo,
      reference: params.reference,
      callback_url: params.callbackUrl,
      metadata: params.metadata,
    }),
  });

  const body = (await res.json()) as {
    status: boolean;
    data: { authorization_url: string; access_code: string; reference: string };
  };

  if (!body.status) {
    logger.error({ body }, "Paystack initialization failed");
    throw new Error("Payment initialization failed");
  }

  return {
    authorizationUrl: body.data.authorization_url,
    accessCode: body.data.access_code,
    reference: body.data.reference,
  };
}

// ─── Verify a transaction ─────────────────────────────────────────────────────

export interface VerifyResult {
  status: string;          // "success" | "failed" | "abandoned"
  reference: string;
  amountKobo: number;
  channel: string;         // card | bank_transfer | ussd
  paidAt: string;
}

// Opt into mock/dev payment behavior (e.g. provider "paystack"/"flutterwave"
// with no real keys) by setting ALLOW_MOCK_PAYMENTS=true. Off by default so
// production fails closed — a payment is never reported as successful without
// a configured gateway key.
const ALLOW_MOCK = process.env["ALLOW_MOCK_PAYMENTS"] === "true";

export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  if (!PAYSTACK_KEY) {
    if (!ALLOW_MOCK) {
      // Fail closed: never claim a payment is successful without a configured key.
      logger.error("PAYSTACK_SECRET_KEY not set — refusing to verify payment");
      throw new Error("PAYSTACK_SECRET_KEY not configured");
    }
    logger.warn("PAYSTACK_SECRET_KEY not set — ALLOW_MOCK_PAYMENTS=true, returning mock verify result");
    return {
      status: "success",
      reference,
      amountKobo: 0,
      channel: "card",
      paidAt: new Date().toISOString(),
    };
  }

  const res = await fetch(`${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: headers(),
  });

  const body = (await res.json()) as {
    status: boolean;
    data: {
      status: string;
      reference: string;
      amount: number;
      channel: string;
      paid_at: string;
    };
  };

  if (!body.status) {
    logger.error({ body, reference }, "Paystack verify failed");
    throw new Error("Payment verification failed");
  }

  return {
    status: body.data.status,
    reference: body.data.reference,
    amountKobo: body.data.amount,
    channel: body.data.channel,
    paidAt: body.data.paid_at,
  };
}

// ─── Refund a transaction ─────────────────────────────────────────────────────

export async function refundTransaction(reference: string, amountKobo?: number): Promise<void> {
  if (!PAYSTACK_KEY) {
    logger.info({ reference }, "Mock Paystack refund — no key set");
    return;
  }

  const body: Record<string, unknown> = { transaction: reference };
  if (amountKobo) body.amount = amountKobo;

  const res = await fetch(`${BASE_URL}/refund`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  const result = (await res.json()) as { status: boolean; message?: string };
  if (!result.status) {
    logger.error({ result, reference }, "Paystack refund failed");
    throw new Error(result.message ?? "Paystack refund failed");
  }
}

// ─── Create transfer recipient ───────────────────────────────────────────────
// Must be called once per bank account before initiating a transfer.

export async function createTransferRecipient(params: {
  accountName: string;
  accountNumber: string;
  bankCode: string;
}): Promise<string> {
  if (!PAYSTACK_KEY) {
    logger.warn("PAYSTACK_SECRET_KEY not set — returning mock recipient code");
    return `mock-recipient-${Date.now()}`;
  }

  const res = await fetch(`${BASE_URL}/transferrecipient`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "nuban",
      name: params.accountName,
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency: "NGN",
    }),
  });

  const body = (await res.json()) as { status: boolean; data: { recipient_code: string }; message?: string };
  if (!body.status) {
    logger.error({ body }, "Paystack create recipient failed");
    throw new Error(body.message ?? "Failed to create transfer recipient");
  }

  return body.data.recipient_code;
}

// ─── Initiate transfer ────────────────────────────────────────────────────────
// Sends real money from your Paystack balance to a vendor's bank account.

export async function initiateTransfer(params: {
  amountKobo: number;
  recipientCode: string;
  reference: string;
  reason: string;
}): Promise<{ transferCode: string; status: string }> {
  if (!PAYSTACK_KEY) {
    logger.warn("PAYSTACK_SECRET_KEY not set — returning mock transfer");
    return { transferCode: `mock-transfer-${Date.now()}`, status: "pending" };
  }

  const res = await fetch(`${BASE_URL}/transfer`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      source: "balance",
      amount: params.amountKobo,
      recipient: params.recipientCode,
      reference: params.reference,
      reason: params.reason,
    }),
  });

  const body = (await res.json()) as {
    status: boolean;
    data: { transfer_code: string; status: string };
    message?: string;
  };

  if (!body.status) {
    logger.error({ body }, "Paystack transfer failed");
    throw new Error(body.message ?? "Transfer failed");
  }

  return { transferCode: body.data.transfer_code, status: body.data.status };
}

// ─── Verify webhook signature ─────────────────────────────────────────────────

import { createHmac } from "crypto";

/**
 * Paystack signs webhooks with HMAC-SHA512 using your secret key.
 * Always verify before processing webhook events in production.
 */
export function verifyWebhookSignature(payload: string, signature: string): boolean {
  if (!PAYSTACK_KEY) return ALLOW_MOCK; // fail closed unless mock payments are explicitly enabled
  const hash = createHmac("sha512", PAYSTACK_KEY).update(payload).digest("hex");
  return hash === signature;
}
