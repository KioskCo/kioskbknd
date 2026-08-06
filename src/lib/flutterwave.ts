/**
 * Flutterwave payment service.
 *
 * Used as the secondary payment provider (alongside Paystack).
 * Supports mobile money, bank transfers, and cards across Africa.
 * Docs: https://developer.flutterwave.com/docs
 *
 * Required environment variables:
 *   FLUTTERWAVE_SECRET_KEY       — starts with "FLWSECK_TEST-" or "FLWSECK-"
 *   FLUTTERWAVE_PUBLIC_KEY       — starts with "FLWPUBK_TEST-" or "FLWPUBK-"
 *   FLUTTERWAVE_WEBHOOK_SECRET_HASH — static hash you configure in Flutterwave dashboard
 */

import { logger } from "./logger";

const FLW_SECRET = process.env["FLUTTERWAVE_SECRET_KEY"] ?? "";
// Static secret hash set in Flutterwave dashboard → Webhooks → Secret hash.
// NOT the same as the API secret key.
const FLW_WEBHOOK_HASH = process.env["FLUTTERWAVE_WEBHOOK_SECRET_HASH"] ?? "";
const BASE_URL = "https://api.flutterwave.com/v3";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${FLW_SECRET}`,
    "Content-Type": "application/json",
  };
}

// ─── Initialize a payment link ────────────────────────────────────────────────

export interface FlwInitResult {
  paymentLink: string;
  txRef: string;
}

export async function initializePayment(params: {
  txRef: string;                // unique transaction reference you generate
  amountNaira: number;          // Flutterwave uses Naira (not kobo)
  email: string;
  phone: string;
  name: string;
  redirectUrl: string;
  description?: string;
  meta?: Record<string, unknown>;
}): Promise<FlwInitResult> {
  if (!FLW_SECRET) {
    logger.warn("FLUTTERWAVE_SECRET_KEY not set — returning mock payment link");
    return {
      paymentLink: `https://checkout.flutterwave.com/pay/dev-${params.txRef}`,
      txRef: params.txRef,
    };
  }

  const res = await fetch(`${BASE_URL}/payments`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      tx_ref: params.txRef,
      amount: params.amountNaira,
      currency: "NGN",
      redirect_url: params.redirectUrl,
      customer: {
        email: params.email,
        phonenumber: params.phone,
        name: params.name,
      },
      customizations: {
        title: "Kiosk Payment",
        description: params.description ?? "Order payment via Kiosk",
        logo: process.env["APP_URL"] ? `${process.env["APP_URL"]}/logo.png` : undefined,
      },
      meta: params.meta,
    }),
  });

  const body = (await res.json()) as {
    status: string;
    data: { link: string };
  };

  if (body.status !== "success") {
    logger.error({ body }, "Flutterwave init failed");
    throw new Error("Flutterwave payment initialization failed");
  }

  return {
    paymentLink: body.data.link,
    txRef: params.txRef,
  };
}

// ─── Verify a transaction ─────────────────────────────────────────────────────
// Flutterwave's verify endpoint (/v3/transactions/:id/verify) requires a NUMERIC
// transaction ID — not the tx_ref string. We search by tx_ref first to get the
// numeric ID, then call the verify endpoint for authoritative confirmation.

export interface FlwVerifyResult {
  status: string;              // "successful" | "failed" | "pending"
  txRef: string;
  amountNaira: number;
  currency: string;
  paymentType: string;         // card | mobilemoneyghana | account etc.
}

// Opt in to mock/dev verification (no real keys). Off by default so production
// fails closed — a payment is never reported as verified without a gateway key.
const ALLOW_MOCK = process.env["ALLOW_MOCK_PAYMENTS"] === "true";

export async function verifyPayment(txRef: string): Promise<FlwVerifyResult> {
  if (!FLW_SECRET) {
    if (!ALLOW_MOCK) {
      // Fail closed: never report a payment as successful without a configured key.
      logger.error("FLUTTERWAVE_SECRET_KEY not set — refusing to verify payment");
      throw new Error("FLUTTERWAVE_SECRET_KEY not configured");
    }
    logger.warn("FLUTTERWAVE_SECRET_KEY not set — ALLOW_MOCK_PAYMENTS=true, returning mock verify result");
    return {
      status: "successful",
      txRef,
      amountNaira: 0,
      currency: "NGN",
      paymentType: "card",
    };
  }

  // Step 1: find the numeric transaction ID by tx_ref
  const searchRes = await fetch(
    `${BASE_URL}/transactions?tx_ref=${encodeURIComponent(txRef)}`,
    { headers: headers() }
  );
  const searchBody = (await searchRes.json()) as {
    status: string;
    data: Array<{
      id: number;
      status: string;
      tx_ref: string;
      amount: number;
      currency: string;
      payment_type: string;
    }>;
  };

  const transaction = searchBody.data?.[0];
  if (!transaction?.id) {
    logger.error({ txRef, searchBody }, "Flutterwave: no transaction found for tx_ref");
    throw new Error(`Flutterwave: no transaction found for reference ${txRef}`);
  }

  // Step 2: call the authoritative verify endpoint with the numeric ID
  const res = await fetch(`${BASE_URL}/transactions/${transaction.id}/verify`, {
    headers: headers(),
  });

  const body = (await res.json()) as {
    status: string;
    data: {
      status: string;
      tx_ref: string;
      amount: number;
      currency: string;
      payment_type: string;
    };
  };

  if (body.status !== "success") {
    logger.error({ body }, "Flutterwave verify failed");
    throw new Error("Flutterwave payment verification failed");
  }

  return {
    status: body.data.status,
    txRef: body.data.tx_ref,
    amountNaira: body.data.amount,
    currency: body.data.currency,
    paymentType: body.data.payment_type,
  };
}

// ─── Refund a payment ────────────────────────────────────────────────────────

export async function refundPayment(txRef: string, amountNaira?: number): Promise<void> {
  if (!FLW_SECRET) {
    logger.info({ txRef }, "Mock Flutterwave refund — no key set");
    return;
  }

  // Flutterwave refunds by transaction ID, so find it by tx_ref first
  const searchRes = await fetch(
    `${BASE_URL}/transactions?tx_ref=${encodeURIComponent(txRef)}`,
    { headers: headers() }
  );
  const searchBody = (await searchRes.json()) as {
    status: string;
    data: Array<{ id: number }>;
  };

  const transaction = searchBody.data?.[0];
  if (!transaction?.id) {
    logger.error({ txRef }, "Flutterwave transaction not found for refund");
    throw new Error("Flutterwave: transaction not found — manual refund required");
  }

  const body: Record<string, unknown> = {};
  if (amountNaira) body.amount = amountNaira;

  const refundRes = await fetch(`${BASE_URL}/transactions/${transaction.id}/refund`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  const refundBody = (await refundRes.json()) as { status: string; message?: string };
  if (refundBody.status !== "success") {
    logger.error({ refundBody, txRef }, "Flutterwave refund failed");
    throw new Error(refundBody.message ?? "Flutterwave refund failed");
  }
}

// ─── Verify webhook signature ─────────────────────────────────────────────────
// Flutterwave sends the "verif-hash" header containing the static secret hash
// you configured in your Flutterwave dashboard under Webhooks → Secret hash.
// It is NOT an HMAC digest — just compare the header value directly.

export function verifyWebhookSignature(_payload: string, signature: string): boolean {
  if (!FLW_WEBHOOK_HASH) return ALLOW_MOCK; // fail closed unless mock payments are explicitly enabled
  return signature === FLW_WEBHOOK_HASH;
}
