/**
 * WhatsApp Business API service.
 *
 * Supports two modes:
 *  1. Per-vendor  — pass { token, phoneNumberId } from the vendor's stored OAuth credentials.
 *  2. System-wide — falls back to WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID env vars
 *                   for platform-level messages (OTP, order confirmations sent by Kiosk itself).
 *
 * Required environment variables:
 *   WHATSAPP_TOKEN           — system-level fallback token (Meta Business Suite)
 *   WHATSAPP_PHONE_NUMBER_ID — system-level fallback phone number ID
 *   WHATSAPP_VERIFY_TOKEN    — arbitrary string set in Meta's webhook config
 *   META_APP_ID              — Facebook App ID (for Embedded Signup OAuth)
 *   META_APP_SECRET          — Facebook App Secret (for code exchange)
 *   META_REDIRECT_URI        — e.g. https://api.kiosk.store/api/whatsapp/oauth/callback
 */

import { logger } from "./logger.js";

const SYSTEM_TOKEN         = process.env["WHATSAPP_TOKEN"] ?? "";
const SYSTEM_PHONE_ID      = process.env["WHATSAPP_PHONE_NUMBER_ID"] ?? "";
const GRAPH_API_VERSION    = "v19.0";

export const META_APP_ID      = process.env["META_APP_ID"] ?? "";
export const META_APP_SECRET  = process.env["META_APP_SECRET"] ?? "";
export const META_REDIRECT_URI = process.env["META_REDIRECT_URI"] ?? "";

// ─── Internal helper ──────────────────────────────────────────────────────────

async function graphPost(
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error("Meta Graph API error"), { status: res.status, meta: err });
  }
  return res.json();
}

async function graphGet(path: string, token: string): Promise<unknown> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error("Meta Graph API error"), { status: res.status, meta: err });
  }
  return res.json();
}

// ─── Send a plain text message ────────────────────────────────────────────────

export interface SendOptions {
  /** Per-vendor access token. Falls back to system token if omitted. */
  token?: string;
  /** Per-vendor phone number ID. Falls back to system ID if omitted. */
  phoneNumberId?: string;
}

export async function sendTextMessage(
  to: string,
  text: string,
  opts?: SendOptions,
): Promise<{ messageId: string }> {
  const token   = opts?.token       || SYSTEM_TOKEN;
  const phoneId = opts?.phoneNumberId || SYSTEM_PHONE_ID;

  if (!token || !phoneId) {
    logger.warn({ to, text: text.slice(0, 60) }, "WhatsApp not configured — message not sent");
    return { messageId: `dev-${Date.now()}` };
  }

  const data = (await graphPost(
    `/${phoneId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    token,
  )) as { messages: Array<{ id: string }> };

  return { messageId: data.messages[0]?.id ?? "" };
}

// ─── Send an OTP via WhatsApp (system-level) ─────────────────────────────────

export async function sendOtpMessage(phone: string, otp: string): Promise<void> {
  const message =
    `🔐 Your Kiosk verification code is: *${otp}*\n\n` +
    `This code expires in 10 minutes. Do not share it with anyone.`;
  await sendTextMessage(phone, message);
}

// ─── Send an order confirmation (system-level) ────────────────────────────────

export async function sendOrderConfirmation(
  phone: string,
  params: {
    buyerName: string;
    orderId: string;
    totalAmount: string;
    escrowOtp: string;
  },
): Promise<void> {
  const message =
    `✅ *Order Confirmed!*\n\n` +
    `Hi ${params.buyerName}, your order #${params.orderId.slice(0, 8).toUpperCase()} has been placed.\n\n` +
    `💰 *Total:* ₦${params.totalAmount}\n` +
    `🔒 *Escrow:* Your funds are safely held in escrow.\n\n` +
    `📦 When your order is delivered, use this release code to confirm receipt:\n` +
    `*${params.escrowOtp}*\n\n` +
    `_Do not share this code until you receive your items._`;
  await sendTextMessage(phone, message);
}

// ─── Send an invoice (system-level) ──────────────────────────────────────────

export async function sendInvoiceMessage(
  phone: string,
  params: {
    merchantName: string;
    orderId: string;
    items: Array<{ name: string; qty: number; price: string }>;
    totalAmount: string;
    paymentLink: string;
  },
): Promise<void> {
  const itemList = params.items.map((i) => `• ${i.name} × ${i.qty} — ₦${i.price}`).join("\n");
  const message =
    `🧾 *Invoice from ${params.merchantName}*\n` +
    `Order: #${params.orderId.slice(0, 8).toUpperCase()}\n\n` +
    `${itemList}\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `*Total: ₦${params.totalAmount}*\n\n` +
    `💳 Pay securely here:\n${params.paymentLink}\n\n` +
    `_Powered by Kiosk — Your WhatsApp, Automated_`;
  await sendTextMessage(phone, message);
}

// ─── Meta OAuth helpers ───────────────────────────────────────────────────────

/** Build the Meta Embedded Signup OAuth URL for a specific vendor. */
export function buildOAuthUrl(vendorId: string): string {
  const params = new URLSearchParams({
    client_id:     META_APP_ID,
    redirect_uri:  META_REDIRECT_URI,
    scope:         "whatsapp_business_management,whatsapp_business_messaging",
    response_type: "code",
    state:         vendorId,
  });
  return `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
}

/** Exchange an OAuth code for a long-lived user access token. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`);
  url.searchParams.set("client_id",     META_APP_ID);
  url.searchParams.set("client_secret", META_APP_SECRET);
  url.searchParams.set("redirect_uri",  META_REDIRECT_URI);
  url.searchParams.set("code",          code);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error("Meta token exchange failed"), { meta: err });
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

interface PhoneNumberResult {
  phoneNumberId: string;
  displayPhoneNumber: string;
}

/**
 * Given a user access token, walk the Meta graph to find the vendor's
 * WhatsApp phone number ID and display number.
 * Returns the first verified/active phone number found.
 */
export async function fetchVendorPhoneNumber(token: string): Promise<PhoneNumberResult | null> {
  try {
    // Step 1: get the user's FB ID
    const me = (await graphGet("/me?fields=id", token)) as { id: string };

    // Step 2: get the businesses this user manages
    const bizRes = (await graphGet(
      `/${me.id}/businesses?fields=id`,
      token,
    )) as { data: Array<{ id: string }> };

    for (const biz of bizRes.data ?? []) {
      // Step 3: get WABAs owned by this business
      const wabaRes = (await graphGet(
        `/${biz.id}/owned_whatsapp_business_accounts?fields=id`,
        token,
      )) as { data: Array<{ id: string }> };

      for (const waba of wabaRes.data ?? []) {
        // Step 4: get phone numbers for this WABA
        const phoneRes = (await graphGet(
          `/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name`,
          token,
        )) as { data: Array<{ id: string; display_phone_number: string }> };

        if (phoneRes.data?.length) {
          const phone = phoneRes.data[0]!;
          return {
            phoneNumberId:      phone.id,
            displayPhoneNumber: phone.display_phone_number,
          };
        }
      }
    }
    return null;
  } catch (err) {
    logger.warn({ err }, "fetchVendorPhoneNumber failed");
    return null;
  }
}

// ─── Webhook verification (GET) ───────────────────────────────────────────────

export function verifyWebhook(mode: string, token: string, challenge: string): string | null {
  const verifyToken = process.env["WHATSAPP_VERIFY_TOKEN"] ?? "kiosk-webhook";
  if (mode === "subscribe" && token === verifyToken) return challenge;
  return null;
}
