/**
 * Escrow + payment job processors.
 *
 * These run inside a BullMQ worker (see src/workers.ts), and are also called
 * directly (inline) when Redis is not enabled, so the core flows always work.
 */

import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db, orders, walletTransactions } from "../db/index.js";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "../routes/auth.js";
import { logger } from "../lib/logger.js";
import { refundOrder } from "./refund.js";

export { refundOrder };

// ─── Mark an order paid (moved out of the HTTP webhook so it can be enqueued) ─

export interface PaymentEvent {
  provider: "paystack" | "flutterwave";
  reference: string;
  channel?: string;
}

export async function handlePaymentEvent(evt: PaymentEvent): Promise<void> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.paymentReference, evt.reference))
    .limit(1);

  // Idempotent: only the very first event for a pending order flips it to paid.
  if (!order || order.status !== "pending") return;
  if (order.escrowStatus === "released" || order.escrowStatus === "refunded") return;

  await db
    .update(orders)
    .set({
      status: "paid",
      paymentChannel: evt.channel ?? order.paymentChannel,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, order.id));

  // Split escrow: release the working-capital portion to the vendor's wallet now.
  await releaseWorkingCapitalToVendor(order.id);

  getPushTokens(order.userId)
    .then((tokens) =>
      sendPushToMany(tokens, {
        title: "💰 Payment received!",
        body: `₦${parseFloat(String(order.totalAmount)).toLocaleString("en-NG")} paid by ${order.buyerName}`,
        data: { type: "payment", orderId: order.id },
      }),
    )
    .catch(() => {});

  logger.info({ orderId: order.id, provider: evt.provider }, "Order marked paid via queue");
}

// ─── Working-capital release — split escrow ─────────────────────────────────────
// On payment confirmation, release `releasePercentAtPayment` (e.g. 50%) of the
// order total to the vendor's wallet immediately so they can procure stock.
// The remainder stays in escrow (`escrowAmount`) until the buyer confirms delivery.
//
// Anti-scam trade-off: if the vendor fails to ship before `escrowExpiresAt`, the
// auto-refund job only refunds `escrowAmount`. The working-capital portion is a
// business loss for the vendor, which is the honest cost that keeps scammers out.
//
// Guarded to run exactly once per order: the UPDATE claims the escrow split with
// `escrow_amount IS NULL`, so concurrent payment events can never double-credit.

export async function releaseWorkingCapitalToVendor(orderId: string): Promise<boolean> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return false;
  if (order.status !== "paid" || order.escrowStatus !== "locked") return false;
  if (order.escrowAmount !== null) return false; // split already applied

  const total = parseFloat(String(order.totalAmount));
  const pct = parseFloat(String(order.releasePercentAtPayment ?? "0"));
  if (!(pct > 0) || total <= 0) return false;

  const workingCapital = Math.round(total * pct * 100) / 100;
  const escrowAmount = Math.round((total - workingCapital) * 100) / 100;

  const claimed = await db
    .update(orders)
    .set({
      escrowAmount:       String(escrowAmount),
      workingCapitalAmount: String(workingCapital),
      updatedAt:          new Date(),
    })
    .where(and(eq(orders.id, order.id), isNull(orders.escrowAmount)))
    .returning();

  if (claimed.length === 0) return false;

  await db.execute(sql`
    UPDATE users
    SET wallet_balance = COALESCE(wallet_balance::numeric, 0) + ${workingCapital}
    WHERE id = ${order.userId}
  `);

  await db.insert(walletTransactions).values({
    userId:      order.userId,
    type:        "credit",
    amount:      String(workingCapital),
    reference:   order.id,
    description: `Working capital released (${Math.round(pct * 100)}%) — Order ${order.orderNumber ?? order.id}. ${escrowAmount.toFixed(2)} held in escrow until delivery.`,
    status:      "completed",
  });

  getPushTokens(order.userId)
    .then((tokens) =>
      sendPushToMany(tokens, {
        title: "💸 Working capital released",
        body: `₦${workingCapital.toLocaleString("en-NG")} from Order ${order.orderNumber ?? ""} is in your wallet. ₦${escrowAmount.toLocaleString("en-NG")} stays in escrow until delivery.`,
        data: { type: "escrow_release", orderId: order.id },
      }),
    )
    .catch(() => {});

  logger.info({ orderId: order.id, workingCapital, escrowAmount }, "Working capital released to vendor");
  return true;
}

// ─── Escrow auto-refund — buyer protection on pre-orders ───────────────────────
// Recurring job: any order with an `escrowExpiresAt` in the past that still
// hasn't shipped is auto-refunded. No auto-release: the seller only gets paid
// when the buyer's delivery PIN is released.

export async function processEscrowDeadlines(): Promise<number> {
  const now = new Date();

  const overdue = await db
    .select()
    .from(orders)
    .where(
      and(
        isNotNull(orders.escrowExpiresAt),
        lt(orders.escrowExpiresAt, now),
        // paid (or still pending) but never shipped before the deadline
        eq(orders.status, "pending"),
        ne(orders.escrowStatus, "released"),
        ne(orders.escrowStatus, "refunded"),
        ne(orders.escrowStatus, "disputed"),
      ),
    )
    .limit(200);

  // Paid-but-unshipped preorders are the actual scam case: a webhook flips the
  // order to "paid" while it is still waiting to be shipped, so match those too.
  const overduePaid = await db
    .select()
    .from(orders)
    .where(
      and(
        isNotNull(orders.escrowExpiresAt),
        lt(orders.escrowExpiresAt, now),
        eq(orders.status, "paid"),
        ne(orders.escrowStatus, "released"),
        ne(orders.escrowStatus, "refunded"),
        ne(orders.escrowStatus, "disputed"),
      ),
    )
    .limit(200);

  let refunded = 0;
  for (const o of [...overdue, ...overduePaid]) {
    const ok = await refundOrder(o.id, {
      reason: "Not shipped before the pre-order deadline",
      by: "escrow-auto",
    });
    if (ok) refunded++;
  }
  return refunded;
}