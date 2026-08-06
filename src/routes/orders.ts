/**
 * Orders routes — order lifecycle + escrow management.
 *
 * GET    /api/orders                      — list the merchant's orders
 * GET    /api/orders/:id                  — get a single order with its items
 * POST   /api/orders                      — create an order (from WhatsApp bot or manual)
 * PATCH  /api/orders/:id/status           — update status (shipped, delivered, cancelled)
 * POST   /api/orders/:id/release-escrow   — buyer submits OTP → funds released to merchant
 * POST   /api/orders/:id/refund-escrow    — merchant or admin initiates refund
 * GET    /api/orders/:id/invoice          — generate invoice data for an order
 */

import { db, orders, orderItems, products, users, walletTransactions, templates } from "../db/index.js";
import { and, eq, desc, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { sendOrderConfirmation, sendTextMessage } from "../lib/whatsapp.js";
import { sendSMS } from "../lib/termii.js";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "./auth.js";
import { rateLimitHit } from "../lib/redis.js";
import { refundOrder } from "../jobs/refund.js";

const router = Router();
router.use(requireAuth);

// ─── Helper: generate a 6-digit escrow OTP ───────────────────────────────────

function generateEscrowOtp(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(1000 + (arr[0]! % 9000)); // 4-digit: 1000–9999
}

// ─── GET /api/orders ──────────────────────────────────────────────────────────

router.get("/orders", async (req, res) => {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, req.user!.userId))
    .orderBy(desc(orders.createdAt));

  res.json({ success: true, data: rows });
});

// ─── GET /api/orders/:id ──────────────────────────────────────────────────────

router.get("/orders/:id", async (req, res) => {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, req.params.id!),
        eq(orders.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  // Fetch line items for this order
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  res.json({ success: true, data: { ...order, items } });
});

// ─── POST /api/orders ─────────────────────────────────────────────────────────

const createOrderSchema = z.object({
  buyerName: z.string().min(1),
  buyerPhone: z.string().min(10),
  buyerAddress: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid().optional(),
      productName: z.string().min(1),
      quantity: z.number().int().positive(),
      unitPrice: z.number().positive(),
    })
  ).min(1, "Order must have at least one item"),
});

router.post("/orders", async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { buyerName, buyerPhone, buyerAddress, notes, items } = parsed.data;

  // Calculate total from line items
  const totalAmount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const escrowOtp = generateEscrowOtp();

  // Create the order record — always start as pending with escrow locked
  const [order] = await db
    .insert(orders)
    .values({
      userId: req.user!.userId,
      buyerName,
      buyerPhone,
      buyerAddress: buyerAddress ?? null,
      notes: notes ?? null,
      totalAmount: String(totalAmount),
      escrowOtp,
      status: "pending",
      escrowStatus: "locked",
    })
    .returning();

  // Insert each line item
  await db.insert(orderItems).values(
    items.map((item) => ({
      orderId: order!.id,
      productId: item.productId ?? null,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: String(item.unitPrice),
    }))
  );

  // Notify the buyer via WhatsApp with their escrow OTP
  try {
    await sendOrderConfirmation(buyerPhone, {
      buyerName,
      orderId: order!.id,
      totalAmount: totalAmount.toFixed(2),
      escrowOtp,
    });
  } catch (err) {
    req.log.warn({ err }, "WhatsApp order confirmation failed — order still created");
  }

  req.log.info({ orderId: order!.id, totalAmount }, "Order created");
  res.status(201).json({ success: true, data: order });
});

// ─── PATCH /api/orders/:id/status ────────────────────────────────────────────

const updateStatusSchema = z.object({
  status: z.enum(["pending", "paid", "shipped", "delivered", "cancelled"]),
  trackingId: z.string().optional(),
  logisticsProvider: z.string().optional(),
});

router.patch("/orders/:id/status", async (req, res) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, req.params.id!),
        eq(orders.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!existing) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const [updated] = await db
    .update(orders)
    .set({
      status: parsed.data.status,
      trackingId: parsed.data.trackingId ?? existing.trackingId,
      logisticsProvider: parsed.data.logisticsProvider ?? existing.logisticsProvider,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, req.params.id!))
    .returning();

  // When merchant marks order delivered → SMS buyer a review link
  if (parsed.data.status === "delivered" && existing.buyerPhone) {
    (async () => {
      try {
        const [tmpl] = await db
          .select({ launchUrl: templates.launchUrl })
          .from(templates)
          .where(and(eq(templates.userId, req.user!.userId), eq(templates.launched, true)))
          .limit(1);

        const [vendor] = await db
          .select({ name: users.businessName, username: users.username })
          .from(users)
          .where(eq(users.id, req.user!.userId))
          .limit(1);

        const storeUrl = tmpl?.launchUrl ?? `https://keeosk.store/@${vendor?.username ?? ""}`;
        const reviewUrl = `${storeUrl}/review?orderId=${existing.id}`;
        const storeName = vendor?.name ?? vendor?.username ?? "the store";

        const reviewMsg = `Hi ${existing.buyerName}! 🎉 Your order from *${storeName}* has been delivered.\n\nHow was your experience? Leave a quick review (takes 30 seconds): ${reviewUrl}`;

        // Send via WhatsApp first (preferred in Nigeria), fall back to SMS
        await sendTextMessage(existing.buyerPhone, reviewMsg).catch(async () => {
          await sendSMS(existing.buyerPhone, reviewMsg.replace(/\*/g, ""));
        });
      } catch {
        // Non-fatal
      }
    })();
  }

  res.json({ success: true, data: updated });
});

// ─── POST /api/orders/:id/release-escrow ─────────────────────────────────────
// Buyer provides OTP they received → merchant's wallet is credited

router.post("/orders/:id/release-escrow", async (req, res) => {
  const { otp } = req.body as { otp?: string };

  if (!otp || otp.length !== 4) {
    res.status(400).json({ success: false, error: "A 4-digit delivery code is required" });
    return;
  }

  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, req.params.id!),
        eq(orders.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  if (order.escrowStatus !== "locked") {
    res.status(400).json({ success: false, error: `Escrow is already ${order.escrowStatus}` });
    return;
  }

  // Anti-fraud: a merchant cannot release escrow on an order that was never paid.
  if (order.status !== "paid") {
    res.status(400).json({ success: false, error: "Order is not paid yet — escrow cannot be released" });
    return;
  }

  if (order.escrowOtp !== otp) {
    // Brute-force protection: only increment the counter on a *failed* attempt so
    // a user who mistypes then enters the correct PIN is never locked out, and a
    // legit delivery can't be DoS'd by junk requests.
    const lockedOut = await rateLimitHit(`escrow-otp:${order.id}`, 5, 15 * 60 * 1000);
    if (lockedOut) {
      res.status(429).json({ success: false, error: "Too many incorrect PIN attempts. Try again in 15 minutes." });
      return;
    }
    res.status(400).json({ success: false, error: "Incorrect OTP — escrow not released" });
    return;
  }

  // Atomically mark order as released — the WHERE guard ensures only one concurrent
  // request can succeed (second call finds escrowStatus = 'released' and returns early above)
  const released = await db
    .update(orders)
    .set({ escrowStatus: "released", status: "delivered", updatedAt: new Date() })
    .where(and(eq(orders.id, order.id), eq(orders.escrowStatus, "locked")))
    .returning();

  if (released.length === 0) {
    res.status(400).json({ success: false, error: "Escrow already released by a concurrent request" });
    return;
  }

  const orderAmount = parseFloat(String(order.totalAmount));

  // Split escrow: the working-capital portion was already released at payment,
  // so delivery-confirmation only releases the escrowed remainder. Legacy orders
  // (escrowAmount null) release the full total.
  const escrowAmount = order.escrowAmount !== null ? Number(order.escrowAmount) : NaN;
  const releaseAmount = Number.isFinite(escrowAmount) && escrowAmount > 0
    ? Math.min(escrowAmount, orderAmount)
    : orderAmount;

  // Atomic increment — avoids read-modify-write race condition
  await db.execute(sql`
    UPDATE users
    SET wallet_balance = COALESCE(wallet_balance::numeric, 0) + ${releaseAmount}
    WHERE id = ${req.user!.userId}
  `);

  // Record wallet transaction
  await db.insert(walletTransactions).values({
    userId:      req.user!.userId,
    type:        "credit",
    amount:      String(releaseAmount),
    reference:   order.id,
    description: `Escrow released — Order ${order.orderNumber ?? order.id}`,
    status:      "completed",
  });

  // Push notification to vendor
  getPushTokens(req.user!.userId).then((tokens) => {
    sendPushToMany(tokens, {
      title: "Funds credited to wallet",
      body:  `₦${releaseAmount.toLocaleString("en-NG")} from Order ${order.orderNumber ?? ""} is now in your wallet`,
      data:  { type: "escrow_release", orderId: order.id },
    });
  }).catch(() => {});

  req.log.info({ orderId: order.id, credited: releaseAmount }, "Escrow released");
  res.json({ success: true, message: "Escrow released — funds credited to your wallet" });
});

// ─── POST /api/orders/:id/refund-escrow ──────────────────────────────────────
// Refunds the escrow AND restores product stock quantities (via shared helper)

router.post("/orders/:id/refund-escrow", async (req, res) => {
  const ok = await refundOrder(req.params.id!, { by: "merchant" });
  if (!ok) {
    // refundOrder returns false when the order doesn't exist or escrow is released.
    const [exists] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, req.params.id!))
      .limit(1);
    if (!exists) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    res.status(400).json({ success: false, error: "Escrow cannot be refunded (already released or cancelled)" });
    return;
  }
  res.json({ success: true, message: "Escrow refunded to buyer and stock restored" });
});

// ─── GET /api/orders/:id/invoice — returns invoice data ──────────────────────

router.get("/orders/:id/invoice", async (req, res) => {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, req.params.id!),
        eq(orders.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const [merchant] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.user!.userId))
    .limit(1);

  res.json({
    success: true,
    invoice: {
      orderId: order.id,
      invoiceNumber: `INV-${order.id.slice(0, 8).toUpperCase()}`,
      issuedAt: order.createdAt,
      merchant: {
        name: merchant?.businessName ?? merchant?.name ?? "Merchant",
        phone: merchant?.phone,
        whatsappNumber: merchant?.whatsappNumber,
      },
      buyer: {
        name: order.buyerName,
        phone: order.buyerPhone,
        address: order.buyerAddress,
      },
      items: items.map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: String(parseFloat(String(i.unitPrice)) * i.quantity),
      })),
      totalAmount: order.totalAmount,
      status: order.status,
      escrowStatus: order.escrowStatus,
      paymentProvider: order.paymentProvider,
      paymentReference: order.paymentReference,
    },
  });
});

export default router;
