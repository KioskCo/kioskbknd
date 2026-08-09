/**
 * Promo / platform settings.
 *
 * Waitlist program (existing):
 *   - Users whose email is on the waitlist get a 20% discount on EVERY plan,
 *     forever (does not expire).
 *
 * Early-adopter program:
 *   - The first `EARLY_ADOPTER_LIMIT` users who verify their email — but NOT
 *     waitlist members — get a 20% discount on the 6-month and 12-month plans.
 *   - This early-adopter discount is NOT forever: it only applies for the first
 *     `EARLY_ADOPTER_DISCOUNT_MONTHS` months after the user signed up.
 *
 * Beta program:
 *   - The first `BETA_TESTER_LIMIT` users get free access while beta testing
 *     is enabled.
 *   - The switch is stored in `app_settings` under `beta_testing_enabled`
 *     and can be flipped by an admin via PATCH /api/admin/settings. An
 *     optional `BETA_TESTING_ENABLED` env var overrides the DB value when set.
 */

import { db, appSettings } from "../db/index.js";
import { eq } from "drizzle-orm";

export const EARLY_ADOPTER_LIMIT = 1000;
export const BETA_TESTER_LIMIT = 100;
export const EARLY_ADOPTER_DISCOUNT = 0.2; // 20%
export const EARLY_ADOPTER_DISCOUNT_MONTHS = 3; // early-adopter offer lasts 3 months
export const BETA_SETTING_KEY = "beta_testing_enabled";

const parseBool = (v: string | null | undefined): boolean | null => {
  if (v === undefined || v === null || v === "") return null;
  return v.toLowerCase() === "true" || v === "1";
};

/** True if the beta (free) testing program is currently enabled. */
export async function betaTestingEnabled(): Promise<boolean> {
  const env = parseBool(process.env["BETA_TESTING_ENABLED"]);
  if (env !== null) return env;

  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, BETA_SETTING_KEY))
    .limit(1);

  const stored = parseBool(row?.value);
  // Default to ON if never configured.
  return stored ?? true;
}

/** Ensure the beta setting row exists so the admin toggle can update it. */
export async function ensureBetaSetting(): Promise<void> {
  const [row] = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, BETA_SETTING_KEY))
    .limit(1);
  if (!row) {
    await db
      .insert(appSettings)
      .values({ key: BETA_SETTING_KEY, value: "true" })
      .onConflictDoNothing();
  }
}

/** True if a user is a beta tester (early signup) AND the program is live. */
export async function isBetaTester(signupOrder: number | null | undefined): Promise<boolean> {
  if (signupOrder == null || signupOrder > BETA_TESTER_LIMIT) return false;
  return betaTestingEnabled();
}

/** True if a user is an early adopter (first 1000 signups). */
export function isEarlyAdopter(signupOrder: number | null | undefined): boolean {
  return signupOrder != null && signupOrder <= EARLY_ADOPTER_LIMIT;
}

/**
 * True if the early-adopter 20% discount is still active for this user.
 * Only counts within `EARLY_ADOPTER_DISCOUNT_MONTHS` of their signup date
 * Warning: waitlist members should be excluded at the call site —
 * they keep the 20% waitlist discount forever instead.
 */
export function isEarlyAdopterActive(user: { signupOrder?: number | null; createdAt?: Date | string | null }): boolean {
  if (!isEarlyAdopter(user.signupOrder)) return false;
  const createdAt = user.createdAt ? new Date(user.createdAt) : null;
  if (!createdAt) return false;
  const cutoff = new Date(createdAt);
  cutoff.setMonth(cutoff.getMonth() + EARLY_ADOPTER_DISCOUNT_MONTHS);
  return new Date() <= cutoff;
}

/** Comma-separated admin emails from env (lower-cased). */
export function adminEmails(): string[] {
  return (process.env["ADMIN_EMAILS"] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True if the given email is a configured admin account. */
export function isAdminEmail(email?: string | null): boolean {
  const admins = adminEmails();
  return admins.length > 0 && admins.includes((email ?? "").toLowerCase());
}