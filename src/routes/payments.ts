/**
 * Payments routes — initialize and verify payments via Paystack or Flutterwave.
 *
 * POST /api/payments/initialize      — create a payment link for an order
 * GET  /api/payments/verify/:ref     — verify a transaction after redirect
 * POST /api/payments/webhook/paystack    — Paystack webhook receiver
 * POST /api/payments/webhook/flutterwave — Flutterwave webhook receiver
 */

import { db, orders, users, walletTransactions } from "../db/index.js";
import { and, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "./auth.js";

// Express augmentation so TypeScript recognises req.rawBody set by app.ts verify hook.
declare module "express-serve-static-core" {
  interface Request { rawBody?: Buffer; }
}
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { sendInvoiceMessage } from "../lib/whatsapp.js";
import {
  initializeTransaction as paystackInit,
  verifyTransaction as paystackVerify,
  verifyWebhookSignature as paystackVerifySig,
} from "../lib/paystack.js";
import {
  initializePayment as flwInit,
  verifyPayment as flwVerify,
  verifyWebhookSignature as flwVerifySig,
} from "../lib/flutterwave.js";
import { enqueuePaymentEvent } from "../lib/queue.js";
import { releaseWorkingCapitalToVendor } from "../jobs/escrow.js";

const router = Router();

// ─── POST /api/payments/initialize ───────────────────────────────────────────

const initSchema = z.object({
  orderId: z.string().uuid("Invalid order ID"),
  provider: z.enum(["paystack", "flutterwave"]).default("paystack"),
  callbackUrl: z.string().url().optional(),
  // Buyer's email is required by Paystack; optional for Flutterwave
  buyerEmail: z.string().email().optional(),
});

router.post("/payments/initialize", requireAuth, async (req, res) => {
  const parsed = initSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { orderId, provider, callbackUrl, buyerEmail } = parsed.data;

  // Fetch the order and ensure it belongs to the current merchant
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  if (order.status !== "pending") {
    res.status(400).json({ success: false, error: `Order is already ${order.status}` });
    return;
  }

  const reference = `kiosk-${order.id}-${Date.now()}`;
  const amountNaira = parseFloat(String(order.totalAmount));

  let paymentUrl: string;
  let paymentRef: string;

  if (provider === "paystack") {
    // Paystack uses kobo (multiply Naira by 100)
    const result = await paystackInit({
      email: buyerEmail ?? `${order.buyerPhone}@kiosk.app`,
      amountKobo: Math.round(amountNaira * 100),
      reference,
      callbackUrl,
      metadata: { orderId: order.id, userId: req.user!.userId },
    });
    paymentUrl = result.authorizationUrl;
    paymentRef = result.reference;
  } else {
    // Flutterwave uses Naira directly
    const result = await flwInit({
      txRef: reference,
      amountNaira,
      email: buyerEmail ?? `${order.buyerPhone}@kiosk.app`,
      phone: order.buyerPhone,
      name: order.buyerName,
      redirectUrl: callbackUrl ?? "kiosk://payment-callback",
      description: `Payment for order #${order.id.slice(0, 8).toUpperCase()}`,
      meta: { orderId: order.id },
    });
    paymentUrl = result.paymentLink;
    paymentRef = result.txRef;
  }

  // Save the payment reference to the order for later verification
  await db
    .update(orders)
    .set({ paymentReference: paymentRef, paymentProvider: provider, updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  // Optionally send the payment link to the buyer via WhatsApp
  try {
    await sendInvoiceMessage(order.buyerPhone, {
      merchantName: "Kiosk Merchant",
      orderId: order.id,
      items: [{ name: "Order items", qty: 1, price: amountNaira.toFixed(2) }],
      totalAmount: amountNaira.toFixed(2),
      paymentLink: paymentUrl,
    });
  } catch {
    req.log.warn("Invoice WhatsApp send failed — payment link still valid");
  }

  res.json({ success: true, data: { paymentUrl, reference: paymentRef, provider } });
});

// ─── GET /api/payments/verify/:reference ─────────────────────────────────────

router.get("/payments/verify/:reference", requireAuth, async (req, res) => {
  const reference = req.params["reference"] as string;

  // Find the order by payment reference
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.paymentReference, reference!),
        eq(orders.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "No order found for this reference" });
    return;
  }

  let status: string;
  let channel: string;

  if (order.paymentProvider === "flutterwave") {
    const result = await flwVerify(reference!);
    status = result.status;   // "successful" | "failed"
    channel = result.paymentType;
  } else {
    const result = await paystackVerify(reference!);
    status = result.status;   // "success" | "failed"
    channel = result.channel;
  }

  const paid =
    status === "success" ||    // Paystack
    status === "successful";   // Flutterwave

  if (paid && order.status === "pending") {
    await db
      .update(orders)
      .set({ status: "paid", paymentChannel: channel, updatedAt: new Date() })
      .where(eq(orders.id, order.id));

    // Split escrow: release working capital now that payment is confirmed.
    await releaseWorkingCapitalToVendor(order.id);
  }

  res.json({
    success: true,
    data: { paid, status, orderId: order.id, reference },
  });
});

// ─── POST /api/payments/webhook/paystack ─────────────────────────────────────
// Paystack calls this URL automatically on payment events

router.post("/payments/webhook/paystack", async (req, res) => {
  const signature = req.headers["x-paystack-signature"] as string;
  // Use the raw request bytes captured by app.ts verify hook.
  // Re-serialising req.body with JSON.stringify may reorder keys and break the HMAC.
  const rawBody = req.rawBody?.toString("utf8") ?? JSON.stringify(req.body);

  if (!paystackVerifySig(rawBody, signature)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { event, data } = req.body as {
    event: string;
    data: { reference: string; status: string; channel: string; transfer_code?: string };
  };

  req.log.info({ event, reference: data.reference }, "Paystack webhook received");

  if (event === "charge.success") {
    // Enqueue stateless processing — the worker marks the order paid and sends
    // the vendor push. jobId = provider:reference makes retries idempotent.
    await enqueuePaymentEvent({
      provider: "paystack",
      reference: data.reference,
      channel: data.channel,
      idempotencyKey: `paystack:${data.reference}:${event}`,
    });
  }

  // Withdrawals (bank transfers OUT to the vendor) are asynchronous at Paystack's
  // end — POST /wallet/withdraw only ever sees "pending" or an immediate synchronous
  // failure. These events are the only way the vendor finds out whether the money
  // actually landed. wallet.ts stores the wallet_transactions row keyed by
  // transfer_code (see the update right after initiateTransfer()), so that's what
  // ties a webhook event back to the right withdrawal.
  if (event === "transfer.success" || event === "transfer.failed" || event === "transfer.reversed") {
    const transferCode = data.transfer_code;
    if (transferCode) {
      const [txn] = await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.reference, transferCode))
        .limit(1);

      // Idempotent — a webhook can be redelivered, only act on it once.
      if (txn && txn.status === "pending") {
        if (event === "transfer.success") {
          await db.update(walletTransactions).set({ status: "completed" }).where(eq(walletTransactions.id, txn.id));
          getPushTokens(txn.userId).then((tokens) => {
            sendPushToMany(tokens, {
              title: "✅ Withdrawal completed",
              body: `₦${parseFloat(String(txn.amount)).toLocaleString("en-NG")} has landed in your bank account.`,
              data: { type: "withdrawal_completed", txnId: txn.id },
            });
          }).catch(() => {});
        } else {
          // transfer.failed / transfer.reversed — the wallet was already debited
          // when the withdrawal was initiated. NOT auto-re-crediting here: the
          // transfer fee charged to the vendor isn't stored as its own field
          // (only embedded in the transaction's description text), so precisely
          // reconstructing "amount + fee" to reverse is not reliable enough to
          // do unattended against a real balance. Flagging loudly instead so
          // it's not silently lost, and a human can verify + credit correctly.
          await db.update(walletTransactions).set({ status: "failed" }).where(eq(walletTransactions.id, txn.id));
          req.log.error({ txnId: txn.id, userId: txn.userId, event }, "Withdrawal transfer failed after initiation — needs manual wallet review");
          getPushTokens(txn.userId).then((tokens) => {
            sendPushToMany(tokens, {
              title: "⚠️ Withdrawal failed",
              body: `Your ₦${parseFloat(String(txn.amount)).toLocaleString("en-NG")} withdrawal could not be completed. Our team has been notified — contact support if it isn't resolved soon.`,
              data: { type: "withdrawal_failed", txnId: txn.id },
            });
          }).catch(() => {});
        }
      }
    }
  }

  res.sendStatus(200);
});

// ─── POST /api/payments/webhook/flutterwave ───────────────────────────────────

router.post("/payments/webhook/flutterwave", async (req, res) => {
  const signature = req.headers["verif-hash"] as string;
  const rawBody = JSON.stringify(req.body);

  if (!flwVerifySig(rawBody, signature)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { event, data } = req.body as {
    event: string;
    data: { tx_ref: string; status: string; payment_type: string };
  };

  req.log.info({ event, txRef: data.tx_ref }, "Flutterwave webhook received");

  if (event === "charge.completed" && data.status === "successful") {
    await enqueuePaymentEvent({
      provider: "flutterwave",
      reference: data.tx_ref,
      channel: data.payment_type,
      idempotencyKey: `flutterwave:${data.tx_ref}:${event}`,
    });
  }

  res.sendStatus(200);
});

export default router;
