/**
 * Support chat routes — vendor-to-platform support messaging.
 *
 * POST /api/support/message  — vendor sends a support message
 * GET  /api/support/messages — vendor fetches their message history
 */

import { db, users, supportMessages } from "../db/index.js";
import { desc, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { sendMail } from "../lib/email.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(requireAuth);

const SUPPORT_EMAIL = process.env["SUPPORT_EMAIL"] ?? process.env["SMTP_USER"] ?? "";

// ─── POST /api/support/message ────────────────────────────────────────────────

const messageSchema = z.object({
  message: z.string().min(1).max(2000),
  subject: z.string().max(120).optional(),
});

router.post("/support/message", async (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const userId = req.user!.userId;
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  const { message, subject } = parsed.data;
  const vendorName = user?.businessName ?? user?.name ?? "A vendor";
  const vendorEmail = user?.email ?? "unknown";
  const msgSubject = subject ?? "Support";

  // Each vendor gets ONE permanent thread ID — all their messages land in the same Gmail thread
  const threadMessageId = `<support-${userId}@keeosk.store>`;
  const isFirstMessage = !subject; // subsequent messages have no subject

  // Check if vendor has sent before (to set Re: prefix correctly)
  const existingCount = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM support_messages WHERE user_id = ${userId}
  `).then((r) => {
    const row = Array.isArray(r) ? r[0] : (r as any).rows?.[0];
    return parseInt(row?.cnt ?? "0", 10);
  }).catch(() => 0);

  const emailSubject = existingCount === 0
    ? `[Kiosk Support] ${msgSubject} — ${vendorName}`
    : `Re: [Kiosk Support] Support — ${vendorName}`;

  // Save message to DB first — this is the record GET /api/support/messages
  // reads back, so a silent failure here made messages vanish on reload even
  // though the client had already been told "sent" (the email side effects
  // below succeeding doesn't help if the row itself was never persisted).
  try {
    await db.insert(supportMessages).values({
      userId,
      subject: msgSubject,
      message,
      status: "open",
    });
  } catch (err) {
    logger.error({ err, userId }, "Failed to save support message");
    res.status(500).json({ success: false, error: "Could not save your message. Please try again." });
    return;
  }

  // Email the platform support team — always in the same thread per vendor
  if (SUPPORT_EMAIL) {
    sendMail(
      SUPPORT_EMAIL,
      emailSubject,
      `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
          <p style="color:#555;font-size:13px;margin-bottom:12px">${vendorName} · ${vendorEmail}</p>
          <p style="color:#0a0a0a;line-height:1.6;white-space:pre-wrap;font-size:15px">${message}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0" />
          <p style="color:#888;font-size:12px">Reply to this email to respond. Your reply will appear in the vendor's kiosk app.</p>
        </div>
      `,
      {
        // First message sets the thread ID; all subsequent reference it → one Gmail thread
        messageId: existingCount === 0 ? threadMessageId : undefined,
        inReplyTo: existingCount > 0 ? threadMessageId : undefined,
        references: existingCount > 0 ? threadMessageId : undefined,
      }
    ).catch(() => {});
  }

  // Send acknowledgement to vendor
  if (vendorEmail && vendorEmail !== "unknown") {
    sendMail(
      vendorEmail,
      "We received your message — Kiosk Support",
      `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="color:#0a0a0a;margin-bottom:8px">We got your message</h2>
          <p style="color:#555">Hi ${vendorName}, thanks for reaching out. Our team will get back to you within 24 hours.</p>
          <div style="background:#f4f4f5;border-radius:12px;padding:16px;margin:24px 0">
            <p style="color:#888;font-size:12px;margin:0">Your message:</p>
            <p style="color:#0a0a0a;margin:8px 0 0;white-space:pre-wrap">${message}</p>
          </div>
          <p style="color:#888;font-size:12px">Reply to this email if you need to add anything.</p>
        </div>
      `
    ).catch(() => {});
  }

  logger.info({ userId, subject: msgSubject }, "Support message received");
  res.json({ success: true, message: "Message sent. We'll get back to you within 24 hours." });
});

// ─── GET /api/support/messages ───────────────────────────────────────────────
// Returns message history for the vendor (needs support_messages table).

router.get("/support/messages", async (req, res) => {
  const userId = req.user!.userId;

  const rows = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.userId, userId))
    .orderBy(desc(supportMessages.createdAt))
    .limit(50)
    .catch(() => [] as (typeof supportMessages.$inferSelect)[]);

  // The typed query builder gives back a real Date for createdAt — go through
  // the query builder rather than raw sql() specifically so that's guaranteed,
  // and serialize it explicitly rather than relying on JSON.stringify to catch it.
  const data = rows.map((r) => ({
    id: r.id,
    message: r.message,
    subject: r.subject,
    status: r.status,
    reply: r.reply,
    created_at: r.createdAt.toISOString(),
  }));
  res.json({ success: true, data });
});

// ─── POST /api/support/messages/:id/reply ────────────────────────────────────
// Admin only — reply to a vendor support message.
// The reply appears in the vendor's kiosk chat screen on next poll.

router.post("/support/messages/:id/reply", async (req, res) => {
  const { reply } = req.body as { reply?: string };
  if (!reply?.trim()) {
    res.status(400).json({ success: false, error: "Reply text is required" });
    return;
  }

  await db.execute(sql`
    UPDATE support_messages
    SET reply = ${reply.trim()}, status = 'replied'
    WHERE id = ${req.params.id!}
  `);

  // Email the reply to the vendor
  const rows = await db.execute(sql`
    SELECT sm.user_id, sm.subject, u.email, u.name, u.business_name
    FROM support_messages sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.id = ${req.params.id!}
    LIMIT 1
  `).catch(() => ({ rows: [] as any[] }));

  const row = (Array.isArray(rows) ? rows[0] : (rows as any).rows?.[0]) as any;
  if (row?.email) {
    const vendorName = row.business_name ?? row.name ?? "there";
    const threadMessageId = `<support-${row.user_id}@keeosk.store>`;
    sendMail(
      row.email,
      `Re: [Kiosk Support] Support — Kiosk Team`,
      `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <p style="color:#555">Hi ${vendorName},</p>
          <div style="background:#f4f4f5;border-radius:12px;padding:16px;margin:16px 0">
            <p style="color:#0a0a0a;margin:0;white-space:pre-wrap;line-height:1.6">${reply.trim()}</p>
          </div>
          <p style="color:#888;font-size:12px">Open the Kiosk app → Settings → Contact Support to see this in your chat.</p>
        </div>
      `,
      {
        inReplyTo: threadMessageId,
        references: threadMessageId,
      }
    ).catch(() => {});
  }

  res.json({ success: true, message: "Reply sent" });
});

export default router;
