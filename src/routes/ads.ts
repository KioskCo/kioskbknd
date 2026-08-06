/**
 * Ads routes — merchant ad campaigns.
 *
 * GET    /api/ads           — list the merchant's ads
 * POST   /api/ads           — create a new ad (stores all details + media)
 * PATCH  /api/ads/:id       — update ad (status, budget, etc.)
 * DELETE /api/ads/:id       — delete ad (spend rolls into historical, not reduced)
 * POST   /api/ads/:id/pay   — initialize payment for an ad campaign
 * POST   /api/ads/:id/launch — mark ad as active after payment
 */

import { db, ads, users } from "../db/index.js";
import { eq, and, desc, sum } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import {
  initializeTransaction as paystackInit,
  verifyTransaction as paystackVerify,
} from "../lib/paystack.js";

const router = Router();
router.use(requireAuth);

// ─── GET /api/ads ─────────────────────────────────────────────────────────────

router.get("/ads", async (req, res) => {
  const rows = await db
    .select()
    .from(ads)
    .where(eq(ads.userId, req.user!.userId))
    .orderBy(desc(ads.createdAt));

  // Calculate total historical spend (sum of all ads including deleted ones)
  const [spendResult] = await db
    .select({ total: sum(ads.spent) })
    .from(ads)
    .where(eq(ads.userId, req.user!.userId));

  res.json({
    success: true,
    data: rows,
    totalHistoricalSpend: parseFloat(String(spendResult?.total ?? "0")),
  });
});

// ─── POST /api/ads ────────────────────────────────────────────────────────────

const createAdSchema = z.object({
  name: z.string().min(1, "Ad name is required"),
  description: z.string().optional(),
  platforms: z.array(z.enum(["instagram", "facebook", "tiktok", "youtube"])).min(1),
  budget: z.number().positive("Budget must be greater than 0"),
  imageUrl: z.string().url().optional(),
  videoUrl: z.string().url().optional(),
  targetAudience: z.string().optional(),
});

router.post("/ads", async (req, res) => {
  const parsed = createAdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const [ad] = await db
    .insert(ads)
    .values({
      userId: req.user!.userId,
      ...parsed.data,
      budget: String(parsed.data.budget),
      platforms: parsed.data.platforms,
      status: "draft",
    })
    .returning();

  req.log.info({ adId: ad!.id }, "Ad created");
  res.status(201).json({ success: true, data: ad });
});

// ─── PATCH /api/ads/:id ───────────────────────────────────────────────────────

const updateAdSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  platforms: z.array(z.enum(["instagram", "facebook", "tiktok", "youtube"])).optional(),
  budget: z.number().positive().optional(),
  imageUrl: z.string().url().optional(),
  videoUrl: z.string().url().optional(),
  targetAudience: z.string().optional(),
  status: z.enum(["active", "paused", "draft"]).optional(),
});

router.patch("/ads/:id", async (req, res) => {
  const parsed = updateAdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(ads)
    .where(and(eq(ads.id, req.params.id!), eq(ads.userId, req.user!.userId)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ success: false, error: "Ad not found" });
    return;
  }

  const updates: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  if (parsed.data.budget !== undefined) {
    updates.budget = String(parsed.data.budget);
  }

  const [updated] = await db
    .update(ads)
    .set(updates)
    .where(eq(ads.id, req.params.id!))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── DELETE /api/ads/:id ──────────────────────────────────────────────────────
// NOTE: Deleting an ad does NOT reduce total spend; spend is already accumulated

router.delete("/ads/:id", async (req, res) => {
  const [existing] = await db
    .select()
    .from(ads)
    .where(and(eq(ads.id, req.params.id!), eq(ads.userId, req.user!.userId)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ success: false, error: "Ad not found" });
    return;
  }

  await db.delete(ads).where(eq(ads.id, req.params.id!));

  req.log.info({ adId: req.params.id, spentPreserved: existing.spent }, "Ad deleted — spend preserved in historical total");
  res.json({ success: true, message: "Ad deleted" });
});

// ─── POST /api/ads/:id/pay ────────────────────────────────────────────────────
// Initialize payment for an ad campaign

router.post("/ads/:id/pay", async (req, res) => {
  const [ad] = await db
    .select()
    .from(ads)
    .where(and(eq(ads.id, req.params.id!), eq(ads.userId, req.user!.userId)))
    .limit(1);

  if (!ad) {
    res.status(404).json({ success: false, error: "Ad not found" });
    return;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.user!.userId))
    .limit(1);

  const budgetNaira = parseFloat(String(ad.budget));
  const reference = `kiosk-ad-${ad.id}-${Date.now()}`;

  const result = await paystackInit({
    email: user?.email ?? `${req.user!.userId}@kiosk.app`,
    amountKobo: Math.round(budgetNaira * 100),
    reference,
    metadata: { adId: ad.id, userId: req.user!.userId, type: "ad_payment" },
  });

  await db
    .update(ads)
    .set({ paymentReference: reference, paymentProvider: "paystack", updatedAt: new Date() })
    .where(eq(ads.id, ad.id));

  res.json({ success: true, data: { paymentUrl: result.authorizationUrl, reference, provider: "paystack" } });
});

// ─── POST /api/ads/:id/launch ─────────────────────────────────────────────────
// Mark ad as active — verifies the payment succeeded before setting status.

router.post("/ads/:id/launch", async (req, res) => {
  const [ad] = await db
    .select()
    .from(ads)
    .where(and(eq(ads.id, req.params.id!), eq(ads.userId, req.user!.userId)))
    .limit(1);

  if (!ad) {
    res.status(404).json({ success: false, error: "Ad not found" });
    return;
  }

  if (ad.status === "active") {
    res.status(400).json({ success: false, error: "Ad is already active" });
    return;
  }

  // Require that payment was initialised
  if (!ad.paymentReference || !ad.paymentProvider) {
    res.status(402).json({ success: false, error: "Payment must be completed before launching. Call /ads/:id/pay first." });
    return;
  }

  // Verify the payment actually succeeded (prevents launching without paying)
  try {
    const paid = await paystackVerify(ad.paymentReference);
    if (paid.status !== "success") {
      res.status(402).json({ success: false, error: "Payment has not been completed. Please pay first." });
      return;
    }
  } catch {
    res.status(402).json({ success: false, error: "Could not verify payment. Please try again." });
    return;
  }

  const [updated] = await db
    .update(ads)
    .set({
      status: "active",
      spent: String(ad.budget),
      startDate: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(ads.id, ad.id))
    .returning();

  req.log.info({ adId: ad.id }, "Ad launched after payment verified");
  res.json({ success: true, data: updated });
});

export default router;
