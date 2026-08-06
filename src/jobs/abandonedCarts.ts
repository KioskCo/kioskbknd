/**
 * Abandoned-cart recovery job.
 *
 * Recurring: finds carts idle > 1 hour that haven't had a recovery email and
 * sends one. Extracted from POST /api/abandoned-carts/send-recovery so the same
 * logic can run both as a BullMQ repeatable job and the (backwards-compatible)
 * cron endpoint.
 */

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { abandonedCarts, db, templates, users } from "../db/index.js";
import { sendAbandonedCartEmail } from "../lib/email.js";
import { logger } from "../lib/logger.js";

const ABANDON_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour idle

export async function processAbandonedCartRecovery(): Promise<{ sent: number; total: number }> {
  const cutoff = new Date(Date.now() - ABANDON_THRESHOLD_MS);

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
      ),
    )
    .limit(100);

  let sent = 0;
  for (const cart of staleCarts) {
    try {
      const [vendor] = await db
        .select({ username: users.username, businessName: users.businessName })
        .from(users)
        .where(eq(users.id, cart.userId))
        .limit(1);

      if (!vendor?.username || !cart.buyerEmail) continue;

      const [tmpl] = await db
        .select({ launchUrl: templates.launchUrl })
        .from(templates)
        .where(and(eq(templates.userId, cart.userId), eq(templates.launched, true)))
        .limit(1);

      const storeUrl =
        tmpl?.launchUrl ??
        `${process.env["SHOP_BASE_URL"] ?? "https://kiosk.store"}/@${vendor.username}`;
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

  return { sent, total: staleCarts.length };
}