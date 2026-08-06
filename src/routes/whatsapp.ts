/**
 * WhatsApp routes — Meta OAuth + webhook receiver + message sender.
 *
 * Public (no auth):
 *   GET  /api/whatsapp/webhook          — Meta webhook verification (hub.challenge)
 *   POST /api/whatsapp/webhook          — Receive inbound messages from customers
 *   GET  /api/whatsapp/oauth/callback   — Meta redirects here after Embedded Signup
 *
 * Authenticated:
 *   GET  /api/whatsapp/oauth/start      — Returns { authUrl } to open in browser
 *   GET  /api/whatsapp/status           — Returns { connected, phoneNumber, phoneNumberId }
 *   POST /api/whatsapp/disconnect       — Clears stored credentials
 *   POST /api/whatsapp/send             — Merchant manually sends a message
 *   GET  /api/whatsapp/messages         — List the merchant's message history
 *
 * AI behaviour rules:
 *  1. FIRST message from a customer → AI always responds with shop link.
 *  2. Order-related chat + vendor hasn't replied → AI responds on behalf of vendor.
 *  3. 6-hour order follow-up: if vendor hasn't replied → periodic AI nudge.
 *  4. Non-order general chat → AI does NOT respond (unless it's the first message).
 *  5. AI toggle (botEnabled on user record) gates rules 2–4 but NOT rule 1.
 */

import { db, whatsappMessages, orders, users, withDbRetry } from "../db/index.js";
import { eq, desc, and, gt, lt } from "drizzle-orm";
import { createHmac } from "crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import {
  sendTextMessage,
  verifyWebhook,
  buildOAuthUrl,
  exchangeCodeForToken,
  fetchVendorPhoneNumber,
  META_APP_ID,
  META_REDIRECT_URI,
} from "../lib/whatsapp.js";
import { sendSMS } from "../lib/termii.js";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "./auth.js";

const router = Router();

// ─── Webhook signature verification ──────────────────────────────────────────
// Meta sends X-Hub-Signature-256: sha256=<hmac> on every webhook POST.
// We verify it against META_APP_SECRET so only genuine Meta payloads are processed.

function verifyMetaSignature(req: Request & { rawBody?: Buffer }): boolean {
  const appSecret = process.env["META_APP_SECRET"];
  if (!appSecret) return true; // not configured in dev — skip gracefully

  const header = req.headers["x-hub-signature-256"] as string | undefined;
  if (!header || !req.rawBody) return false;

  const expected = `sha256=${createHmac("sha256", appSecret).update(req.rawBody).digest("hex")}`;
  // Constant-time comparison to avoid timing attacks
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SHOP_BASE_URL = process.env["SHOP_BASE_URL"] ?? "https://keeosk.store/@";

function shopLink(businessName: string): string {
  const slug = businessName.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9_]/g, "");
  return `${SHOP_BASE_URL}${slug}`;
}

const ORDER_KEYWORDS = [
  "order", "paid", "payment", "deliver", "delivery", "track", "tracking",
  "where", "status", "receipt", "invoice", "refund", "cancel", "escrow",
  "dispatch", "shipped", "arrived", "package", "item",
];

function looksLikeOrderChat(text: string): boolean {
  const lower = text.toLowerCase();
  return ORDER_KEYWORDS.some((kw) => lower.includes(kw));
}

async function isFirstMessageFromCustomer(merchantId: string, customerPhone: string): Promise<boolean> {
  const [prev] = await db
    .select()
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.userId, merchantId), eq(whatsappMessages.customerPhone, customerPhone)))
    .limit(1);
  return !prev;
}

async function findOrderForCustomer(merchantId: string, customerPhone: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.userId, merchantId), eq(orders.buyerPhone, customerPhone)))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  return order ?? null;
}

async function vendorRepliedSince(merchantId: string, customerPhone: string, since: Date): Promise<boolean> {
  const [reply] = await db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.userId, merchantId),
        eq(whatsappMessages.customerPhone, customerPhone),
        eq(whatsappMessages.direction, "outbound"),
        gt(whatsappMessages.createdAt, since),
      ),
    )
    .limit(1);
  return !!reply;
}

// ─── GET /api/whatsapp/webhook — Meta's verification handshake ────────────────

router.get("/whatsapp/webhook", (req, res) => {
  const mode      = req.query["hub.mode"] as string;
  const token     = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  const result = verifyWebhook(mode, token, challenge);
  if (result) {
    res.status(200).send(result);
  } else {
    res.status(403).json({ error: "Verification failed" });
  }
});

// ─── POST /api/whatsapp/webhook — receive inbound customer messages ────────────

router.post("/whatsapp/webhook", async (req, res) => {
  // Verify Meta's HMAC signature before processing anything
  if (!verifyMetaSignature(req as Request & { rawBody?: Buffer })) {
    res.status(403).json({ error: "Invalid signature" });
    return;
  }

  // Always acknowledge immediately so Meta doesn't retry
  res.sendStatus(200);

  const body = req.body as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            id: string;
            from: string;
            type: string;
            text?: { body: string };
          }>;
          metadata?: { phone_number_id: string; display_phone_number: string };
        };
      }>;
    }>;
  };

  if (body.object !== "whatsapp_business_account") return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const messages     = change.value?.messages ?? [];
      const phoneNumberId = change.value?.metadata?.phone_number_id ?? "";

      for (const msg of messages) {
        if (msg.type !== "text" || !msg.text?.body) continue;

        const customerPhone = msg.from;
        const text          = msg.text.body;

        // ── Find the merchant by their stored phone_number_id ─────────────────
        // Each vendor has their own phone_number_id from Meta Embedded Signup.
        // We match directly against the DB column — no full-table scan needed.
        const [matchedMerchant] = await db
          .select()
          .from(users)
          .where(eq(users.whatsappPhoneNumberId, phoneNumberId))
          .limit(1);

        if (!matchedMerchant) {
          req.log.warn({ phoneNumberId }, "No merchant matched for incoming WhatsApp — message skipped");
          continue;
        }

        const merchantId           = matchedMerchant.id;
        const merchantBusinessName = matchedMerchant.businessName ?? matchedMerchant.name ?? "our store";
        const aiEnabled            = matchedMerchant.botEnabled !== false;

        req.log.info({ customerPhone, merchantId, text: text.slice(0, 80) }, "Inbound WhatsApp message");

        // Store the inbound message
        await db.insert(whatsappMessages).values({
          userId:           merchantId,
          customerPhone,
          direction:        "inbound",
          message:          text,
          whatsappMessageId: msg.id,
        });

        // ── Push notification to vendor ───────────────────────────────────────
        getPushTokens(merchantId).then((tokens) => {
          if (tokens.length > 0) {
            sendPushToMany(tokens, {
              title: `💬 New message from ${customerPhone.slice(-4)}`,
              body:  text.slice(0, 100),
              data:  { type: "whatsapp_message", customerPhone },
            });
          }
        }).catch(() => {});

        // Per-vendor credentials for outbound replies
        const vendorCreds = {
          token:         matchedMerchant.whatsappAccessToken ?? undefined,
          phoneNumberId: matchedMerchant.whatsappPhoneNumberId ?? undefined,
        };

        // ── Rule 1: First message → always respond with shop link ─────────────
        const isFirst = await isFirstMessageFromCustomer(merchantId, customerPhone);
        if (isFirst) {
          const link = shopLink(merchantBusinessName);
          const greeting =
            `👋 Hi! Welcome to *${merchantBusinessName}*.\n\n` +
            `Browse our store here:\n${link}\n\n` +
            `Reply with your question or order and we'll get back to you shortly!`;

          try {
            await sendTextMessage(`+${customerPhone}`, greeting, vendorCreds);
          } catch {
            await sendSMS(`+${customerPhone}`, `Welcome to ${merchantBusinessName}. Shop here: ${link}`);
          }
          await db.insert(whatsappMessages).values({
            userId: merchantId, customerPhone, direction: "outbound", message: greeting, status: "sent",
          });
          continue;
        }

        // ── Rules 2–4 are gated by AI toggle ─────────────────────────────────
        if (!aiEnabled) continue;

        const isOrderRelated = looksLikeOrderChat(text);
        if (!isOrderRelated) continue;

        // ── Rule 2: Order-related + unresponsive vendor ────────────────────────
        const order = await findOrderForCustomer(merchantId, customerPhone);
        if (!order) continue;

        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const vendorActive = await vendorRepliedSince(merchantId, customerPhone, twoHoursAgo);
        if (vendorActive) continue;

        const orderStatus  = order.status ?? "processing";
        const orderIdShort = order.id.slice(0, 8).toUpperCase();
        const statusMessages: Record<string, string> = {
          pending:   `Your order #${orderIdShort} has been received and is being processed.`,
          paid:      `Payment for order #${orderIdShort} is secured. We'll dispatch your items soon!`,
          shipped:   `Your order #${orderIdShort} is on its way! Tracking ID: ${order.trackingId ?? "pending"}.`,
          delivered: `Your order #${orderIdShort} has been delivered. Please confirm receipt!`,
          cancelled: `Your order #${orderIdShort} has been cancelled. Please contact us if you need help.`,
        };

        const reply =
          `📦 Hi! Here's an update on your order:\n\n` +
          (statusMessages[orderStatus] ?? `Order #${orderIdShort} status: ${orderStatus}.`) + "\n\n" +
          `If you need urgent help, please hold on — our team will be with you shortly.`;

        try {
          await sendTextMessage(`+${customerPhone}`, reply, vendorCreds);
        } catch {
          req.log.warn({ customerPhone }, "Rule 2 WhatsApp reply failed");
        }
        await db.insert(whatsappMessages).values({
          userId: merchantId, customerPhone, direction: "outbound", message: reply, status: "sent",
        });
      }
    }
  }
});

// ─── GET /api/whatsapp/oauth/callback — Meta redirects here after Embedded Signup ──

router.get("/whatsapp/oauth/callback", async (req, res) => {
  const code     = req.query["code"] as string | undefined;
  const vendorId = req.query["state"] as string | undefined;
  const error    = req.query["error"] as string | undefined;

  const closeScript = (success: boolean, message: string) => `
    <!DOCTYPE html><html><head><title>Kiosk — WhatsApp Connect</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
             justify-content: center; min-height: 100vh; margin: 0; background: #F9FAFB; }
      .card { background: #fff; border-radius: 16px; padding: 40px 32px; text-align: center;
              box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 360px; }
      .icon { font-size: 48px; margin-bottom: 12px; }
      h2 { margin: 0 0 8px; font-size: 20px; color: #111; }
      p  { margin: 0; font-size: 14px; color: #6B7280; line-height: 1.5; }
    </style></head><body>
    <div class="card">
      <div class="icon">${success ? "✅" : "❌"}</div>
      <h2>${success ? "WhatsApp Connected!" : "Connection Failed"}</h2>
      <p>${message}</p>
      <p style="margin-top:16px;font-size:12px;color:#9CA3AF">You can close this window and return to Kiosk.</p>
    </div></body></html>`;

  if (error || !code || !vendorId) {
    res.status(400).send(closeScript(false, "The connection was cancelled or an error occurred. Please try again from the Kiosk app."));
    return;
  }

  try {
    // Exchange authorization code for access token
    const accessToken = await exchangeCodeForToken(code);

    // Walk Meta's graph to get the vendor's phone number ID
    const phoneInfo = await fetchVendorPhoneNumber(accessToken);

    // Store credentials on the vendor's record
    await db
      .update(users)
      .set({
        whatsappAccessToken:    accessToken,
        whatsappPhoneNumberId:  phoneInfo?.phoneNumberId  ?? null,
        whatsappNumber:         phoneInfo?.displayPhoneNumber ?? null,
      })
      .where(eq(users.id, vendorId));

    res.send(closeScript(
      true,
      phoneInfo
        ? `Your WhatsApp Business number <strong>${phoneInfo.displayPhoneNumber}</strong> is now connected to Kiosk.`
        : "Your account is connected. Go back to Kiosk to confirm your number.",
    ));
  } catch (err) {
    req.log.error({ err, vendorId }, "WhatsApp OAuth callback failed");
    res.status(500).send(closeScript(false, "Something went wrong while connecting your account. Please try again."));
  }
});

// ─── Authenticated routes ─────────────────────────────────────────────────────

router.use(requireAuth);

// ─── GET /api/whatsapp/oauth/start — return the Meta OAuth URL ────────────────

router.get("/whatsapp/oauth/start", (req, res) => {
  if (!META_APP_ID || !META_REDIRECT_URI) {
    res.status(503).json({ success: false, error: "WhatsApp OAuth is not configured on this server." });
    return;
  }
  const authUrl = buildOAuthUrl(req.user!.userId);
  res.json({ success: true, data: { authUrl } });
});

// ─── GET /api/whatsapp/status — check if this vendor is connected ─────────────

router.get("/whatsapp/status", async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);

  const connected = !!(user?.whatsappPhoneNumberId && user?.whatsappAccessToken);
  res.json({
    success: true,
    data: {
      connected,
      phoneNumber:   user?.whatsappNumber     ?? null,
      phoneNumberId: user?.whatsappPhoneNumberId ?? null,
    },
  });
});

// ─── POST /api/whatsapp/disconnect — revoke stored credentials ────────────────

router.post("/whatsapp/disconnect", async (req, res) => {
  await db
    .update(users)
    .set({ whatsappAccessToken: null, whatsappPhoneNumberId: null, whatsappNumber: null })
    .where(eq(users.id, req.user!.userId));

  res.json({ success: true });
});

// ─── POST /api/whatsapp/send — merchant manually sends a message ──────────────

const sendSchema = z.object({
  to:      z.string().min(10, "Recipient phone number is required"),
  message: z.string().min(1, "Message cannot be empty"),
});

router.post("/whatsapp/send", async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { to, message } = parsed.data;

  // Load the vendor's per-account credentials
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  const vendorCreds = {
    token:         user?.whatsappAccessToken   ?? undefined,
    phoneNumberId: user?.whatsappPhoneNumberId ?? undefined,
  };

  const result = await sendTextMessage(to, message, vendorCreds);

  await db.insert(whatsappMessages).values({
    userId:           req.user!.userId,
    customerPhone:    to,
    direction:        "outbound",
    message,
    whatsappMessageId: result.messageId,
    status:           "sent",
  });

  res.json({ success: true, data: { messageId: result.messageId } });
});

// ─── GET /api/whatsapp/messages — message history for current merchant ─────────

router.get("/whatsapp/messages", async (req, res) => {
  const rows = await db
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.userId, req.user!.userId))
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(100);

  res.json({ success: true, data: rows });
});

// ─── Background job: 6-hour order follow-up ───────────────────────────────────

export function startOrderFollowUpScheduler(): void {
  const SIX_HOURS      = 6 * 60 * 60 * 1000;
  const CHECK_INTERVAL = 60 * 60 * 1000;

  async function runCheck() {
    try {
      const sixHoursAgo = new Date(Date.now() - SIX_HOURS);

      const recentOrders = await withDbRetry(() => db
        .select()
        .from(orders)
        .where(
          and(
            gt(orders.createdAt, new Date(Date.now() - 48 * 60 * 60 * 1000)),
            lt(orders.createdAt, sixHoursAgo),
          ),
        )
        .limit(50), { label: "OrderFollowUp" });

      for (const order of recentOrders) {
        if (!order.buyerPhone || !order.userId) continue;

        // Only chase orders that are still live and unsettled:
        //  • not yet dispatched (shipped), delivered, or cancelled
        //  • escrow still "locked" — the buyer hasn't released the PIN that pays
        //    the vendor's wallet. released/refunded means the order is settled,
        //    so there is nothing left to follow up on.
        if (order.status === "shipped" || order.status === "delivered" || order.status === "cancelled") continue;
        if (order.escrowStatus !== "locked") continue;

        // The bot only steps in when the CUSTOMER actually reached out. Find that
        // customer's most recent inbound message to this vendor.
        const [lastInbound] = await db
          .select()
          .from(whatsappMessages)
          .where(
            and(
              eq(whatsappMessages.userId, order.userId),
              eq(whatsappMessages.customerPhone, order.buyerPhone),
              eq(whatsappMessages.direction, "inbound"),
            ),
          )
          .orderBy(desc(whatsappMessages.createdAt))
          .limit(1);
        if (!lastInbound?.createdAt) continue; // customer never messaged → nothing to follow up on

        // Only act once that message has gone unanswered for a full 6 hours.
        if (lastInbound.createdAt > sixHoursAgo) continue;

        // Skip if the vendor (or an earlier auto follow-up) already responded
        // after the customer's last message — only nudge on genuine silence.
        const responded = await vendorRepliedSince(order.userId, order.buyerPhone, lastInbound.createdAt);
        if (responded) continue;

        const [merchant] = await db.select().from(users).where(eq(users.id, order.userId)).limit(1);
        if (!merchant || merchant.botEnabled === false) continue;
        // Only follow up for vendors who have actually linked their WhatsApp.
        if (!merchant.whatsappAccessToken || !merchant.whatsappPhoneNumberId) continue;

        const orderIdShort = order.id.slice(0, 8).toUpperCase();
        const followUp =
          `👋 Hi! This is an update from *${merchant.businessName ?? merchant.name ?? "Kiosk"}*.\n\n` +
          `Your order #${orderIdShort} is still being processed.\n` +
          `We'll have it ready for dispatch soon. Thank you for your patience!\n\n` +
          `Reply here if you have any questions.`;

        const vendorCreds = {
          token:         merchant.whatsappAccessToken   ?? undefined,
          phoneNumberId: merchant.whatsappPhoneNumberId ?? undefined,
        };

        try {
          await sendTextMessage(`+${order.buyerPhone}`, followUp, vendorCreds);
        } catch {
          await sendSMS(
            `+${order.buyerPhone}`,
            `Hi! Update from ${merchant.businessName ?? "Kiosk"}: Your order is still being processed. Reply or call us for help.`,
          );
        }
        await db.insert(whatsappMessages).values({
          userId: order.userId, customerPhone: order.buyerPhone,
          direction: "outbound", message: followUp, status: "sent",
        }).catch(() => {});
      }
    } catch (err) {
      const code =
        (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
        (err as { code?: string })?.code;
      // A network blip just means we skip this run; the next tick retries.
      // Log it as a one-line warning instead of a full stack trace.
      if (code === "CONNECT_TIMEOUT" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET") {
        console.warn(`[OrderFollowUp] skipped this run — network unavailable (${code}); will retry next tick`);
      } else {
        console.error("[OrderFollowUp] Error:", err);
      }
    }
  }

  setInterval(runCheck, CHECK_INTERVAL);
  setTimeout(runCheck, 30_000);
}

export default router;
