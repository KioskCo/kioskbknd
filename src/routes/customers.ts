/**
 * Customers & Newsletter routes (auth-protected, per-vendor).
 *
 * GET    /api/customers                  — list unique customers (derived from orders)
 * GET    /api/customers/newsletter       — list newsletter subscribers
 * POST   /api/customers/newsletter       — subscribe (public, called from shop checkout/form)
 * DELETE /api/customers/newsletter/:id   — unsubscribe (vendor removes a subscriber)
 */

import { db, orders, users, withDbRetry } from "../db/index.js";
import { customerNotes } from "../db/schema.js";
import { eq, sql, and } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { rateLimit } from "../middlewares/rateLimit.js";
import { sendMail } from "../lib/email.js";
import { getPushTokens } from "./auth.js";
import { sendPushToMany } from "../lib/pushNotifications.js";

const router = Router();

// ─── Ensure newsletter_subscribers table exists ──────────────────────────────
// This creates the table on first use; a proper migration is in MIGRATION_NOTES.md.
async function ensureNewsletterTable() {
  await withDbRetry(() => db.execute(sql`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id     TEXT NOT NULL,
      email       TEXT NOT NULL,
      name        TEXT,
      phone       TEXT,
      source      TEXT DEFAULT 'manual',
      subscribed  BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, email)
    )
  `), { label: "newsletter" });
}
ensureNewsletterTable().catch((e) => console.error("[newsletter] Table setup failed:", e));

// ─── GET /api/customers ───────────────────────────────────────────────────────
// Returns unique customers derived from the vendor's orders.

router.get("/customers", requireAuth, async (req, res) => {
  const userId = req.user!.userId;

  const rows = await db
    .select({
      buyerName: orders.buyerName,
      buyerPhone: orders.buyerPhone,
      buyerAddress: orders.buyerAddress,
      lastOrderAt: sql<string>`max(${orders.createdAt})`,
      totalOrders: sql<number>`count(*)::int`,
      totalSpent: sql<string>`sum(${orders.totalAmount}::numeric)::text`,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .groupBy(orders.buyerPhone, orders.buyerName, orders.buyerAddress)
    .orderBy(sql`max(${orders.createdAt}) desc`);

  res.json({ success: true, data: rows, total: rows.length });
});

// ─── GET /api/customers/newsletter ───────────────────────────────────────────

router.get("/customers/newsletter", requireAuth, async (req, res) => {
  const userId = req.user!.userId;

  const result = await db.execute(sql`
    SELECT id, email, name, phone, source, subscribed, created_at
    FROM newsletter_subscribers
    WHERE user_id = ${userId} AND subscribed = true
    ORDER BY created_at DESC
  `);

  // Drizzle execute() returns either the rows array directly (postgres.js) or { rows: [...] } (pg driver)
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  // Normalize created_at to strict ISO 8601 — the driver hands back either a Date
  // object or Postgres's native "YYYY-MM-DD HH:mm:ss+00" text form depending on
  // the pool, and the latter parses as Invalid Date on Hermes (React Native's JS
  // engine), even though it's fine in Node/V8. new Date(...).toISOString() is
  // reliable across both input shapes and always yields something Hermes accepts.
  const data = rows.map((r: any) => ({
    ...r,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
  res.json({ success: true, data, total: data.length });
});

// ─── POST /api/customers/newsletter ──────────────────────────────────────────
// Public endpoint — called from the shop newsletter form or checkout.
// Requires vendorId (the merchant's userId) in the body so we know who to subscribe to.

const subscribeSchema = z.object({
  vendorId: z.string().min(1, "vendorId required"),
  email: z.string().email("Valid email required"),
  name: z.string().optional(),
  phone: z.string().optional(),
  source: z.string().optional(),
});

router.post(
  "/customers/newsletter/subscribe",
  rateLimit(20, 60 * 60 * 1000), // 20 subscriptions per hour per IP
  async (req, res) => {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
      return;
    }

    const { vendorId, email, name, phone, source } = parsed.data;

    // (xmax = 0) is a standard Postgres idiom for "this row was actually just
    // inserted, not merely touched by the ON CONFLICT path" — a shop's
    // checkout form re-submits the same email on every order, and pushing a
    // notification for every one of those (someone who's already subscribed,
    // nothing changed) would just be noise. Only a genuine first-time signup
    // notifies the vendor.
    const upsertResult = await db.execute(sql`
      INSERT INTO newsletter_subscribers (user_id, email, name, phone, source)
      VALUES (${vendorId}, ${email.toLowerCase()}, ${name ?? null}, ${phone ?? null}, ${source ?? "shop"})
      ON CONFLICT (user_id, email) DO UPDATE SET
        subscribed = true,
        name = COALESCE(EXCLUDED.name, newsletter_subscribers.name),
        phone = COALESCE(EXCLUDED.phone, newsletter_subscribers.phone)
      RETURNING (xmax = 0) AS inserted
    `);
    const upsertRows = Array.isArray(upsertResult) ? upsertResult : (upsertResult as any).rows ?? [];
    const isNewSubscriber = upsertRows[0]?.inserted === true;

    // Push straight to the vendor's phone — this is what actually makes it show
    // up in the OS notification tray and arrive whether or not the app happens
    // to be open. (The in-app notification centre is a separate, client-side
    // concern — it just mirrors this when the app is next opened.) "default"
    // sound = the device's own standard notification tone, not overly loud.
    if (isNewSubscriber) {
      getPushTokens(vendorId).then((tokens) => {
        sendPushToMany(tokens, {
          title: "New newsletter signup 📬",
          body: name ? `${name} (${email}) just joined your newsletter.` : `${email} just joined your newsletter.`,
          data: { type: "newsletter_signup" },
          sound: "default",
        });
      }).catch(() => {});
    }

    res.json({ success: true, message: "Subscribed successfully" });
  }
);

// ─── DELETE /api/customers/newsletter/:id ────────────────────────────────────

router.delete("/customers/newsletter/:id", requireAuth, async (req, res) => {
  const userId = req.user!.userId;

  await db.execute(sql`
    UPDATE newsletter_subscribers
    SET subscribed = false
    WHERE id = ${req.params.id} AND user_id = ${userId}
  `);

  res.json({ success: true, message: "Subscriber removed" });
});

// ─── POST /api/customers/newsletter/bulk-delete ──────────────────────────────
// Vendor removes several subscribers at once (e.g. multi-select in the app).

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
});

router.post("/customers/newsletter/bulk-delete", requireAuth, async (req, res) => {
  const parsed = bulkDeleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }
  const userId = req.user!.userId;
  const { ids } = parsed.data;

  await db.execute(sql`
    UPDATE newsletter_subscribers
    SET subscribed = false
    WHERE user_id = ${userId} AND id = ANY(${ids}::text[])
  `);

  res.json({ success: true, removed: ids.length });
});

// ─── POST /api/customers/newsletter/send ─────────────────────────────────────
// Vendor sends an email broadcast to all their active subscribers.

const sendNewsletterSchema = z.object({
  subject: z.string().min(1).max(150),
  body:    z.string().min(1).max(10000),
  // Optional — restrict the send to a chosen subset (e.g. multi-select in the app).
  // Omitted/empty means "everyone currently subscribed", the original behavior.
  ids: z.array(z.string().min(1)).max(500).optional(),
});

router.post("/customers/newsletter/send", requireAuth, rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  const parsed = sendNewsletterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const userId = req.user!.userId;
  const { subject, body, ids } = parsed.data;

  const [vendor] = await db.select({ name: users.name, businessName: users.businessName })
    .from(users).where(eq(users.id, userId)).limit(1);

  const storeName = vendor?.businessName ?? vendor?.name ?? "Kiosk Store";

  const result = ids && ids.length > 0
    ? await db.execute(sql`
        SELECT email, name FROM newsletter_subscribers
        WHERE user_id = ${userId} AND subscribed = true AND id = ANY(${ids}::text[])
      `)
    : await db.execute(sql`
        SELECT email, name FROM newsletter_subscribers
        WHERE user_id = ${userId} AND subscribed = true
      `);
  const subscribers = (Array.isArray(result) ? result : (result as any).rows ?? []) as { email: string; name?: string }[];

  if (subscribers.length === 0) {
    res.json({ success: true, sent: 0, message: "No active subscribers" });
    return;
  }

  const unsubscribeBase = `${process.env["SHOP_BASE_URL"]?.replace("/@", "/unsubscribe/") ?? "https://keeosk.store/unsubscribe/"}`;

  let sent = 0;
  for (const sub of subscribers) {
    const greeting = sub.name ? `Hi ${sub.name},` : "Hi there,";
    const html = `
      <div style="font-family:sans-serif;max-width:560px;margin:auto;padding:32px">
        <p style="color:#555;margin-bottom:20px">${greeting}</p>
        <div style="color:#0a0a0a;line-height:1.7;white-space:pre-wrap">${body}</div>
        <hr style="border:none;border-top:1px solid #eee;margin:32px 0" />
        <p style="color:#aaa;font-size:12px">
          You're receiving this from <strong>${storeName}</strong>.
          <a href="${unsubscribeBase}${userId}" style="color:#aaa">Unsubscribe</a>
        </p>
      </div>
    `;
    const ok = await sendMail(sub.email, `${subject} — ${storeName}`, html).then(() => true).catch(() => false);
    if (ok) sent++;
  }

  res.json({ success: true, sent, total: subscribers.length });
});

// ─── Customer Notes ───────────────────────────────────────────────────────────
// GET    /api/customers/notes/:phone   — get all notes for a customer
// POST   /api/customers/notes          — add a note
// DELETE /api/customers/notes/:id      — delete a note

router.get("/customers/notes/:phone", requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const phone = decodeURIComponent(req.params.phone as string);
  const rows = await db
    .select()
    .from(customerNotes)
    .where(and(eq(customerNotes.userId, userId), eq(customerNotes.customerPhone, phone)))
    .orderBy(customerNotes.createdAt);
  res.json({ success: true, data: rows });
});

router.post("/customers/notes", requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const { customerPhone, note, tag } = req.body as { customerPhone?: string; note?: string; tag?: string };
  if (!customerPhone || !note?.trim()) {
    res.status(400).json({ success: false, error: "customerPhone and note are required" });
    return;
  }
  const [row] = await db.insert(customerNotes).values({ userId, customerPhone, note: note.trim(), tag: tag ?? null }).returning();
  res.status(201).json({ success: true, data: row });
});

router.delete("/customers/notes/:id", requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  await db.delete(customerNotes).where(and(eq(customerNotes.id, req.params.id as string), eq(customerNotes.userId, userId)));
  res.json({ success: true });
});

// ─── POST /api/customers/newsletter/unsubscribe ───────────────────────────────
// Public — customer clicks unsubscribe link from email.

router.post("/customers/newsletter/unsubscribe", async (req, res) => {
  const { vendorId, email } = req.body as { vendorId?: string; email?: string };
  if (!vendorId || !email) {
    res.status(400).json({ success: false, error: "vendorId and email required" });
    return;
  }

  await db.execute(sql`
    UPDATE newsletter_subscribers
    SET subscribed = false
    WHERE user_id = ${vendorId} AND email = ${email.toLowerCase()}
  `);

  res.json({ success: true, message: "Unsubscribed successfully" });
});

export default router;
