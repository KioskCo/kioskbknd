/**
 * Expo Push Notifications — send push notifications to vendor mobile apps.
 *
 * Expo acts as a free push relay — no Apple/Google credentials needed on the server.
 * The mobile app registers an ExponentPushToken and stores it here via POST /api/auth/push-token.
 *
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */

import { logger } from "./logger";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Must match the Android notification channel the app creates in
// AppContext.tsx's registerPushToken(). Without this, Android ignores the
// app's channel entirely and uses its own generic default one instead.
const ANDROID_CHANNEL_ID = "kiosk-alerts";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
}

export async function sendPushNotification(
  token: string,
  msg: PushMessage
): Promise<void> {
  if (!token || !token.startsWith("ExponentPushToken[")) {
    return; // skip invalid or placeholder tokens
  }

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({
        to: token,
        title: msg.title,
        body: msg.body,
        data: msg.data ?? {},
        sound: msg.sound ?? "default",
        badge: msg.badge,
        channelId: ANDROID_CHANNEL_ID,
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Expo push notification failed");
    }
  } catch (err) {
    logger.warn({ err }, "Expo push send error — non-fatal");
  }
}

export async function sendPushToMany(
  tokens: string[],
  msg: PushMessage
): Promise<void> {
  const valid = tokens.filter((t) => t.startsWith("ExponentPushToken["));
  if (valid.length === 0) return;

  try {
    await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        valid.map((to) => ({
          to,
          title: msg.title,
          body: msg.body,
          data: msg.data ?? {},
          sound: msg.sound ?? "default",
          badge: msg.badge,
          channelId: ANDROID_CHANNEL_ID,
        }))
      ),
    });
  } catch (err) {
    logger.warn({ err }, "Expo push batch error — non-fatal");
  }
}
