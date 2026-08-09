/**
 * Waitlist routes — early-access signup with 20% subscription discount.
 *
 * POST /api/waitlist          — add email to waitlist (public)
 * GET  /api/waitlist/check    — check if the authenticated user's email is on waitlist (auth required)
 */

import { Router } from "express";
import { z } from "zod";
import { db, waitlist, users } from "../db/index.js";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

export const WAITLIST_DISCOUNT = 0.20; // 20% off

// ─── POST /api/waitlist ───────────────────────────────────────────────────────

const joinSchema = z.object({
  email: z.string().email(),
  phone: z.string().optional(),
  name: z.string().optional(),
});

router.post("/waitlist", async (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid data" });
    return;
  }
  const { email, phone, name } = parsed.data;
  try {
    await db
      .insert(waitlist)
      .values({ email, phone, name })
      .onConflictDoNothing();
    res.json({ success: true, message: "You're on the waitlist! You'll receive 20% off your first subscription." });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not join waitlist" });
  }
});

// ─── GET /api/waitlist/check ──────────────────────────────────────────────────

router.get("/waitlist/check", requireAuth, async (req, res) => {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user!.userId)).limit(1);
  if (!user?.email) {
    res.json({ onWaitlist: false });
    return;
  }
  const [entry] = await db.select({ id: waitlist.id }).from(waitlist).where(eq(waitlist.email, user.email)).limit(1);
  res.json({ onWaitlist: !!entry, discount: entry ? WAITLIST_DISCOUNT : 0 });
});

export default router;
