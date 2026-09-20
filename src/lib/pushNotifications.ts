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

// Without an explicit `badge` in the payload, APNs/FCM leave the app icon's
// badge exactly as it was — they do NOT auto-increment it just because a
// notification was delivered. That's why the icon showed nothing new until
// the app was actually opened (the only place badge count was ever being
// set was a client-side effect that only runs while the app is running).
// Defaulting every push to badge 1 isn't a precise unread tally — the server
// doesn't track a per-vendor unread count — but it guarantees the icon
// visibly changes the moment something happens, which is the actual thing
// being asked for. Once the app opens, AppContext's own effect immediately
// corrects it to the real in-app unread count.
const DEFAULT_BADGE = 1;

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
        badge: msg.badge ?? DEFAULT_BADGE,
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
          badge: msg.badge ?? DEFAULT_BADGE,
          channelId: ANDROID_CHANNEL_ID,
        }))
      ),
    });
  } catch (err) {
    logger.warn({ err }, "Expo push batch error — non-fatal");
  }
}
