/**
 * Abandoned cart routes
 *
 * POST /api/abandoned-carts/track        — storefront reports a cart (session + items + optional buyer info)
 * POST /api/abandoned-carts/recover/:token — buyer clicks email link; marks cart recovered
 * POST /api/abandoned-carts/send-recovery — internal/cron: finds carts idle >1h and sends recovery emails
 * GET  /api/abandoned-carts              — vendor lists their abandoned carts (with email status)
 */

import crypto from "crypto";
import { and, eq, desc, isNull, lt, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { abandonedCarts, db, templates, users } from "../db/index.js";
import { requireAuth } from "../middlewares/auth.js";
import { sendAbandonedCartEmail } from "../lib/email.js";
import { storeUrl as buildStoreUrl } from "../lib/shopBase.js";
import { logger } from "../lib/logger.js";

const router = Router();

const ABANDON_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour idle

// ─── Track a cart (called from the storefront when a buyer adds to cart) ──────

router.post("/track", async (req, res) => {
  const schema = z.object({
    sessionToken: z.string().min(1),
    vendorUsername: z.string().min(1),
    buyerEmail: z.string().email().optional(),
    buyerName: z.string().optional(),
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        price: z.number(),
        imageUrl: z.string().optional(),
      })
    ).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
  const { sessionToken, vendorUsername, buyerEmail, buyerName, items } = parsed.data;

  // Look up the vendor by username
  const [vendor] = await db.select({ id: users.id }).from(users).where(eq(users.username, vendorUsername)).limit(1);
  if (!vendor) return res.status(404).json({ error: "Store not found" });

  // Upsert — update items if session already exists, insert otherwise
  const existing = await db
    .select({ id: abandonedCarts.id })
    .from(abandonedCarts)
    .where(and(eq(abandonedCarts.sessionToken, sessionToken), eq(abandonedCarts.userId, vendor.id)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(abandonedCarts)
      .set({ items, buyerEmail, buyerName, updatedAt: new Date() })
      .where(eq(abandonedCarts.id, existing[0].id));
  } else {
    await db.insert(abandonedCarts).values({
      userId: vendor.id,
      sessionToken,
      buyerEmail: buyerEmail ?? null,
      buyerName: buyerName ?? null,
      items,
      recoveryToken: crypto.randomUUID(),
    });
  }

  res.json({ ok: true });
});

// ─── Mark cart recovered (buyer clicked the email link) ───────────────────────

router.post("/recover/:token", async (req, res) => {
  const { token } = req.params;
  const [cart] = await db
    .select({ id: abandonedCarts.id, items: abandonedCarts.items })
    .from(abandonedCarts)
    .where(eq(abandonedCarts.recoveryToken, token))
    .limit(1);

  if (!cart) return res.status(404).json({ error: "Recovery link is invalid or already used" });

  await db
    .update(abandonedCarts)
    .set({ recoveredAt: new Date(), updatedAt: new Date() })
    .where(eq(abandonedCarts.id, cart.id));

  res.json({ ok: true, items: cart.items });
});

// ─── Internal cron endpoint — finds idle carts and sends recovery emails ──────
// Call this from a cron job or Supabase pg_cron every 15 minutes.
// Protected by a shared secret in the header (CRON_SECRET env var).

router.post("/send-recovery", async (req, res) => {
  const secret = process.env["CRON_SECRET"];
  if (secret && req.headers["x-cron-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cutoff = new Date(Date.now() - ABANDON_THRESHOLD_MS);

  // Find carts that:
  //   - have a buyer email
  //   - were updated more than 1 hour ago (buyer stopped adding items)
  //   - have NOT had a recovery email sent yet
  //   - have NOT been recovered

  const staleCarts = await db
    .select({
      id: abandonedCarts.id,
      userId: abandonedCarts.userId,
      buyerEmail: abandonedCarts.buyerEmail,
      buyerName: abandonedCarts.buyerName,
      items: abandonedCarts.items,
      recoveryToken: abandonedCarts.recoveryToken,
    })
    .from(abandonedCarts)
    .where(
      and(
        sql`${abandonedCarts.buyerEmail} IS NOT NULL`,
        lt(abandonedCarts.updatedAt, cutoff),
        isNull(abandonedCarts.emailSentAt),
        isNull(abandonedCarts.recoveredAt),
      )
    )
    .limit(100);

  let sent = 0;
  for (const cart of staleCarts) {
    try {
      // Get vendor store info
      const [vendor] = await db
        .select({ username: users.username, businessName: users.businessName })
        .from(users)
        .where(eq(users.id, cart.userId))
        .limit(1);

      if (!vendor?.username || !cart.buyerEmail) continue;

      // Find the vendor's launched template to get the store URL
      const [tmpl] = await db
        .select({ launchUrl: templates.launchUrl })
        .from(templates)
        .where(and(eq(templates.userId, cart.userId), eq(templates.launched, true)))
        .orderBy(desc(templates.updatedAt))
        .limit(1);

      const storeUrl = tmpl?.launchUrl ?? buildStoreUrl(vendor.username);
      const items = cart.items as Array<{ name: string; price: number; imageUrl?: string }>;

      await sendAbandonedCartEmail({
        email: cart.buyerEmail,
        buyerName: cart.buyerName ?? "there",
        storeName: vendor.businessName ?? vendor.username,
        storeUrl,
        items,
        recoveryToken: cart.recoveryToken!,
      });

      await db
        .update(abandonedCarts)
        .set({ emailSentAt: new Date(), updatedAt: new Date() })
        .where(eq(abandonedCarts.id, cart.id));

      sent++;
    } catch (err) {
      logger.error({ err, cartId: cart.id }, "Failed to send abandoned cart email");
    }
  }

  res.json({ sent, total: staleCarts.length });
});

// ─── Vendor view of their abandoned carts ─────────────────────────────────────

router.get("/", requireAuth, async (req, res) => {
  const userId = (req as any).user.id;
  const carts = await db
    .select()
    .from(abandonedCarts)
    .where(eq(abandonedCarts.userId, userId))
    .orderBy(sql`${abandonedCarts.updatedAt} DESC`)
    .limit(100);

  res.json({ carts });
});

export default router;
