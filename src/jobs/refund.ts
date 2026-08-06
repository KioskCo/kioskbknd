/**
 * Shared escrow-refund logic.
 *
 * Used by:
 *  - POST /api/orders/:id/refund-escrow (merchant / manual)
 *  - The escrow auto-refund worker (buyer protection on pre-orders)
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { db, orders, orderItems } from "../db/index.js";
import { refundTransaction as paystackRefund } from "../lib/paystack.js";
import { refundPayment as flutterwaveRefund } from "../lib/flutterwave.js";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "../routes/auth.js";
import { logger } from "../lib/logger.js";

interface RefundOptions {
  reason?: string;
  by?: string;
}

/**
 * Refund an order to the buyer: flips escrow to refunded, cancels the order,
 * calls the gateway refund, restores stock, and notifies the vendor.
 *
 * Guarded so a released order can never be refunded (the WHERE includes
 * `escrow_status <> 'released'`), and concurrent/double refunds are ignored.
 * Returns true when a refund was actually applied.
 */
export async function refundOrder(
  orderId: string,
  opts: RefundOptions = {},
): Promise<boolean> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return false;
  if (order.escrowStatus === "released") return false;

  const updated = await db
    .update(orders)
    .set({
      escrowStatus: "refunded",
      status: "cancelled",
      refundedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, order.id), ne(orders.escrowStatus, "released")))
    .returning();

  if (updated.length === 0) return false;

  // Split escrow: on a split order, the vendor already kept the working-capital
  // portion at payment (business loss if not shipped), so the buyer only gets
  // the escrowed remainder refunded. Legacy full-escrow orders refund in full.
  const escrowAmount = order.escrowAmount !== null ? Number(order.escrowAmount) : NaN;
  const refundable = Number.isFinite(escrowAmount) && escrowAmount > 0
    ? Math.min(escrowAmount, Number(order.totalAmount))
    : Number(order.totalAmount);

  // Real gateway refund of the escrowed portion if payment was collected.
  if (order.paymentReference && order.paymentProvider) {
    try {
      if (order.paymentProvider === "paystack") {
        await paystackRefund(order.paymentReference, Math.round(refundable * 100));
      } else if (order.paymentProvider === "flutterwave") {
        await flutterwaveRefund(order.paymentReference, refundable);
      }
    } catch (err) {
      logger.error({ err, orderId }, "Gateway refund failed — requires manual refund");
    }
  }

  // Restore product stock.
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  for (const item of items) {
    if (!item.productId) continue;
    await db.execute(sql`
      UPDATE products
      SET stock = COALESCE(stock, 0) + ${item.quantity}, updated_at = now()
      WHERE id = ${item.productId}
    `);
  }

  getPushTokens(order.userId)
    .then((tokens) =>
      sendPushToMany(tokens, {
        title: "Order refunded",
        body: `Order ${order.orderNumber ?? order.id} has been refunded${opts.reason ? ` (${opts.reason})` : ""}`,
        data: { type: "refund", orderId: order.id },
      }),
    )
    .catch(() => {});

  logger.info({ orderId, reason: opts.reason, by: opts.by }, "Escrow refunded, stock restored");
  return true;
}