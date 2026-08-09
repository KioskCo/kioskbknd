/**
 * Database client — Drizzle ORM connected to PostgreSQL (Supabase).
 *
 * All tables are re-exported from here so routes can import from a single path:
 *   import { db, orders, users } from "../db/index.js";
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const queryClient = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 30,
  ssl: connectionString.includes("localhost") ? false : "require",
});

export const db = drizzle(queryClient, { schema });

/**
 * Retry a DB operation across transient connection failures.
 *
 * Network blips (CONNECT_TIMEOUT / ECONNREFUSED / ETIMEDOUT) at startup would
 * otherwise permanently skip one-time setup (e.g. `CREATE TABLE IF NOT EXISTS`)
 * until the next restart. Retries with exponential backoff; re-throws anything
 * that isn't a transient connection error, or once attempts are exhausted.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const label = opts.label ? ` ${opts.label}` : "";
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code =
        (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
        (err as { code?: string })?.code;
      const transient =
        code === "CONNECT_TIMEOUT" ||
        code === "ECONNREFUSED" ||
        code === "ETIMEDOUT" ||
        code === "ECONNRESET";
      if (!transient || attempt >= attempts) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.warn(`[db]${label} transient ${code}, retry ${attempt}/${attempts - 1} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Re-export all tables so routes can do: import { db, orders, users } from "../db/index.js"
export {
  users,
  otpSessions,
  products,
  orders,
  orderItems,
  templates,
  templatePages,
  templateSections,
  templateComponents,
  subscriptions,
  referrals,
  walletTransactions,
  bankAccounts,
  ads,
  whatsappMessages,
  logisticsBookings,
  userPushTokens,
  newsletterSubscribers,
  supportMessages,
  customerNotes,
  productReviews,
  discounts,
  restockAlerts,
  buyerReferrals,
  contactMessages,
  waitlist,
  abandonedCarts,
  disputes,
  appSettings,
} from "./schema.js";
