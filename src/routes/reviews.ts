/**
 * Product reviews routes.
 *
 * Public (buyer-facing):
 *   POST /api/reviews              — submit a review (verified purchase check)
 *   GET  /api/reviews/product/:id  — get approved reviews for a product (public)
 *
 * Auth-protected (vendor):
 *   GET    /api/reviews             — list all reviews for this vendor
 *   PATCH  /api/reviews/:id         — approve/hide + add reply
 *   DELETE /api/reviews/:id         — delete a review
 */

import { Router } from "express";
import { db, orders, orderItems, productReviews, users } from "../db/index.js";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { rateLimit } from "../middlewares/rateLimit.js";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "./auth.js";

const router = Router();

// ─── POST /api/reviews (public — buyer submits) ───────────────────────────────

const submitSchema = z.object({
  vendorId:    z.string().min(1),
  productId:   z.string().optional(),
  productName: z.string().min(1).max(200),
  orderId:     z.string().optional(),       // used to verify purchase
  buyerEmail:  z.string().email().optional(),
  buyerName:   z.string().min(1).max(120),
  rating:      z.number().int().min(1).max(5),
  body:        z.string().max(2000).optional(),
  photoUrls:   z.array(z.string().url()).max(3).optional(),
});

router.post("/reviews", rateLimit(10, 60 * 60 * 1000), async (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { vendorId, productId, productName, orderId, buyerEmail, buyerName, rating, body, photoUrls } = parsed.data;

  // Verify purchase — must have a real order from this vendor
  if (orderId) {
    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userId, vendorId)))
      .limit(1);
    if (!order) {
      res.status(403).json({ success: false, error: "Order not found — cannot verify purchase." });
      return;
    }
    // If productId supplied, make sure it was in that order
    if (productId) {
      const [item] = await db
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(and(eq(orderItems.orderId, orderId), eq(orderItems.productId, productId)))
        .limit(1);
      if (!item) {
        res.status(403).json({ success: false, error: "Product not found in this order." });
        return;
      }
    }
  }

  // Prevent duplicate review for same order+product
  if (orderId && productId) {
    const existing = await db
      .select({ id: productReviews.id })
      .from(productReviews)
      .where(and(eq(productReviews.orderId, orderId), eq(productReviews.productId, productId)))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ success: false, error: "You have already reviewed this product." });
      return;
    }
  }

  const [review] = await db.insert(productReviews).values({
    vendorId,
    productId: productId ?? null,
    productName,
    orderId: orderId ?? null,
    buyerEmail: buyerEmail ?? null,
    buyerName,
    rating,
    body: body ?? null,
    photoUrls: photoUrls ?? [],
    status: orderId ? "approved" : "pending", // verified purchases auto-approve
  }).returning();

  // Notify vendor (fire-and-forget)
  getPushTokens(vendorId).then((tokens) => {
    if (tokens.length > 0) {
      sendPushToMany(tokens, {
        title: "⭐ New review",
        body: `${buyerName} rated "${productName}" ${rating} star${rating !== 1 ? "s" : ""}`,
        data: { screen: "reviews" },
      });
    }
  }).catch(() => null);

  res.status(201).json({ success: true, data: review });
});

// ─── GET /api/reviews/product/:productId (public) ────────────────────────────

router.get("/reviews/product/:productId", async (req, res) => {
  const rows = await db
    .select({
      id: productReviews.id,
      buyerName: productReviews.buyerName,
      rating: productReviews.rating,
      body: productReviews.body,
      photoUrls: productReviews.photoUrls,
      reply: productReviews.reply,
      createdAt: productReviews.createdAt,
    })
    .from(productReviews)
    .where(and(eq(productReviews.productId, req.params.productId as string), eq(productReviews.status, "approved")))
    .orderBy(desc(productReviews.createdAt))
    .limit(50);

  const avgRating = rows.length
    ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 10) / 10
    : null;

  res.json({ success: true, data: rows, avgRating, total: rows.length });
});

// ─── GET /api/reviews/order/:orderId (public — buyer fetches items to review) ──

router.get("/reviews/order/:orderId", async (req, res) => {
  const { orderId } = req.params as { orderId: string };

  const [order] = await db
    .select({ id: orders.id, vendorId: orders.userId, buyerName: orders.buyerName })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const items = await db
    .select({ productId: orderItems.productId, productName: orderItems.productName })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  const [vendor] = await db
    .select({ name: users.businessName, username: users.username })
    .from(users)
    .where(eq(users.id, order.vendorId))
    .limit(1);

  res.json({
    success: true,
    data: {
      orderId,
      buyerName: order.buyerName,
      vendorId: order.vendorId,
      vendorName: vendor?.name ?? vendor?.username ?? "this store",
      items: items.filter((i) => i.productId != null),
    },
  });
});

// ─── GET /api/reviews/top (public — top approved reviews for a vendor) ────────

router.get("/reviews/top", async (req, res) => {
  const vendorId = String(req.query["vendorId"] ?? "").trim();
  const limit = Math.min(Number(req.query["limit"] ?? 3), 10);
  if (!vendorId) {
    res.status(400).json({ success: false, error: "vendorId is required" });
    return;
  }

  const rows = await db
    .select({
      id: productReviews.id,
      buyerName: productReviews.buyerName,
      rating: productReviews.rating,
      body: productReviews.body,
      productName: productReviews.productName,
      createdAt: productReviews.createdAt,
    })
    .from(productReviews)
    .where(and(eq(productReviews.vendorId, vendorId), eq(productReviews.status, "approved")))
    .orderBy(desc(productReviews.rating), desc(productReviews.createdAt))
    .limit(limit);

  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.json({ success: true, data: rows });
});

// ─── GET /api/reviews (vendor — all reviews) ─────────────────────────────────

router.get("/reviews", requireAuth, async (req, res) => {
  const vendorId = req.user!.userId;
  const rows = await db
    .select()
    .from(productReviews)
    .where(eq(productReviews.vendorId, vendorId))
    .orderBy(desc(productReviews.createdAt));

  const avgRating = rows.length
    ? Math.round((rows.filter((r) => r.status === "approved").reduce((s, r) => s + r.rating, 0) /
        Math.max(rows.filter((r) => r.status === "approved").length, 1)) * 10) / 10
    : null;

  // Group by product for product rating insights
  const byProduct: Record<string, { name: string; count: number; avgRating: number }> = {};
  for (const r of rows.filter((r) => r.status === "approved")) {
    const key = r.productId ?? r.productName;
    if (!byProduct[key]) byProduct[key] = { name: r.productName, count: 0, avgRating: 0 };
    byProduct[key].count++;
    byProduct[key].avgRating = (byProduct[key].avgRating * (byProduct[key].count - 1) + r.rating) / byProduct[key].count;
  }

  res.json({ success: true, data: rows, avgRating, total: rows.length, productInsights: Object.values(byProduct) });
});

// ─── PATCH /api/reviews/:id (vendor — approve/hide/reply) ────────────────────

router.patch("/reviews/:id", requireAuth, async (req, res) => {
  const vendorId = req.user!.userId;
  const { status, reply } = req.body as { status?: string; reply?: string };

  const [existing] = await db
    .select({ id: productReviews.id })
    .from(productReviews)
    .where(and(eq(productReviews.id, req.params.id as string), eq(productReviews.vendorId, vendorId)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ success: false, error: "Review not found" });
    return;
  }

  const patch: Record<string, unknown> = {};
  if (status && ["approved", "hidden", "pending"].includes(status)) patch["status"] = status;
  if (reply !== undefined) patch["reply"] = reply;

  const [updated] = await db
    .update(productReviews)
    .set(patch)
    .where(eq(productReviews.id, req.params.id as string))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── DELETE /api/reviews/:id (vendor) ────────────────────────────────────────

router.delete("/reviews/:id", requireAuth, async (req, res) => {
  const vendorId = req.user!.userId;
  await db
    .delete(productReviews)
    .where(and(eq(productReviews.id, req.params.id as string), eq(productReviews.vendorId, vendorId)));
  res.json({ success: true });
});

export default router;
