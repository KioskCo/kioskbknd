/**
 * Termii SMS — Nigerian SMS gateway for fallback customer messaging.
 *
 * Used when WhatsApp 24-hour messaging window has expired.
 * Cost: ~₦2-5 per SMS.
 * Docs: https://developer.termii.com/messaging
 *
 * Required environment variables:
 *   TERMII_API_KEY    — from app.termii.com → API settings
 *   TERMII_SENDER_ID  — approved sender name (default: "Kiosk")
 */

import { logger } from "./logger";

const API_KEY = process.env["TERMII_API_KEY"] ?? "";
const SENDER_ID = process.env["TERMII_SENDER_ID"] ?? "Kiosk";
const BASE_URL = "https://api.ng.termii.com/api";

export async function sendSMS(to: string, message: string): Promise<void> {
  // Normalize phone — remove + prefix, Termii uses numbers only
  const phone = to.replace(/^\+/, "").replace(/\s/g, "");

  if (!API_KEY) {
    logger.info({ to: phone, message: message.slice(0, 60) }, "[Termii Mock] SMS would be sent");
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: phone,
        from: SENDER_ID,
        sms: message,
        type: "plain",
        api_key: API_KEY,
        channel: "generic",
      }),
    });

    const body = (await res.json()) as { message: string; message_id?: string };
    if (body.message !== "Successfully Sent") {
      logger.warn({ body, to: phone }, "Termii SMS send may have failed");
    }
  } catch (err) {
    logger.warn({ err, to: phone }, "Termii SMS error — non-fatal");
  }
}
