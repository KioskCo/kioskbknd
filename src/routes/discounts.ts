/**
 * Discount codes routes.
 *
 * Vendor-protected:
 *   GET    /api/discounts          — list vendor's discount codes
 *   POST   /api/discounts          — create a discount code
 *   PATCH  /api/discounts/:id      — enable/disable a code
 *   DELETE /api/discounts/:id      — delete a code
 *
 * Public (buyer-facing):
 *   POST /api/discounts/validate   — validate a code for checkout (returns discount value)
 */

import { Router } from "express";
import { db, discounts } from "../db/index.js";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

// ─── GET /api/discounts (vendor) ──────────────────────────────────────────────

router.get("/discounts", requireAuth, async (req, res) => {
  const rows = await db
    .select()
    .from(discounts)
    .where(eq(discounts.vendorId, req.user!.userId))
    .orderBy(desc(discounts.createdAt));
  res.json({ success: true, data: rows });
});

// ─── POST /api/discounts/validate (public) ────────────────────────────────────
// Must be before /:id to avoid conflict

router.post("/discounts/validate", async (req, res) => {
  const { code, vendorId, orderTotal } = req.body as { code?: string; vendorId?: string; orderTotal?: number };

  if (!code || !vendorId) {
    res.status(400).json({ success: false, error: "code and vendorId are required" });
    return;
  }

  const [discount] = await db
    .select()
    .from(discounts)
    .where(
      and(
        eq(discounts.vendorId, vendorId),
        eq(discounts.code, code.toUpperCase().trim()),
        eq(discounts.active, true),
      ),
    )
    .limit(1);

  if (!discount) {
    res.status(404).json({ success: false, error: "Invalid or expired discount code" });
    return;
  }

  // Check expiry
  if (discount.expiresAt && new Date(discount.expiresAt) < new Date()) {
    res.status(400).json({ success: false, error: "This discount code has expired" });
    return;
  }

  // Check max uses
  if (discount.maxUses !== null && (discount.usesCount ?? 0) >= discount.maxUses) {
    res.status(400).json({ success: false, error: "This discount code has reached its usage limit" });
    return;
  }

  // Check min order
  const minOrder = parseFloat(String(discount.minOrder ?? 0));
  if (orderTotal !== undefined && orderTotal < minOrder) {
    res.status(400).json({
      success: false,
      error: `Minimum order of ₦${minOrder.toLocaleString("en-NG")} required for this code`,
    });
    return;
  }

  const value = parseFloat(String(discount.value));
  const discountAmount = discount.type === "percent"
    ? Math.round(((orderTotal ?? 0) * value) / 100)
    : Math.min(value, orderTotal ?? 0);

  res.json({
    success: true,
    data: {
      id: discount.id,
      code: discount.code,
      type: discount.type,
      value,
      discountAmount,
      label: discount.type === "percent" ? `${value}% off` : `₦${value.toLocaleString("en-NG")} off`,
    },
  });
});

// ─── POST /api/discounts (vendor) ────────────────────────────────────────────

const createSchema = z.object({
  code:      z.string().min(2).max(30).transform((s) => s.toUpperCase().trim()),
  type:      z.enum(["percent", "fixed"]),
  value:     z.number().positive(),
  minOrder:  z.number().min(0).optional(),
  maxUses:   z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

router.post("/discounts", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  try {
    const [discount] = await db.insert(discounts).values({
      vendorId:  req.user!.userId,
      code:      parsed.data.code,
      type:      parsed.data.type,
      value:     String(parsed.data.value),
      minOrder:  parsed.data.minOrder !== undefined ? String(parsed.data.minOrder) : "0",
      maxUses:   parsed.data.maxUses ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    }).returning();

    res.status(201).json({ success: true, data: discount });
  } catch {
    res.status(409).json({ success: false, error: "A discount code with that name already exists" });
  }
});

// ─── PATCH /api/discounts/:id (vendor — toggle active) ───────────────────────

router.patch("/discounts/:id", requireAuth, async (req, res) => {
  const { active } = req.body as { active?: boolean };
  const [existing] = await db.select({ id: discounts.id })
    .from(discounts)
    .where(and(eq(discounts.id, req.params.id as string), eq(discounts.vendorId, req.user!.userId)))
    .limit(1);

  if (!existing) { res.status(404).json({ success: false, error: "Discount not found" }); return; }

  const [updated] = await db.update(discounts)
    .set({ active: active ?? true })
    .where(eq(discounts.id, req.params.id as string))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── DELETE /api/discounts/:id (vendor) ──────────────────────────────────────

router.delete("/discounts/:id", requireAuth, async (req, res) => {
  await db.delete(discounts)
    .where(and(eq(discounts.id, req.params.id as string), eq(discounts.vendorId, req.user!.userId)));
  res.json({ success: true });
});

// ─── POST /api/discounts/:id/use — increment uses count (called after order placed) ──

router.post("/discounts/:id/use", requireAuth, async (req, res) => {
  const [existing] = await db.select({ id: discounts.id, usesCount: discounts.usesCount })
    .from(discounts)
    .where(and(eq(discounts.id, req.params.id as string), eq(discounts.vendorId, req.user!.userId)))
    .limit(1);

  if (!existing) { res.status(404).json({ success: false, error: "Discount not found" }); return; }

  await db.update(discounts)
    .set({ usesCount: (existing.usesCount ?? 0) + 1 })
    .where(eq(discounts.id, req.params.id as string));

  res.json({ success: true });
});

export default router;
