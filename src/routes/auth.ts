/**
 * Auth routes — email + password authentication.
 *
 * Signup flow:
 *   1. POST /api/auth/signup        — email + password → system sends OTP to email
 *   2. POST /api/auth/verify-email  — email + OTP → user created/verified, JWT returned
 *
 * Login flow:
 *   3. POST /api/auth/login         — email + password → JWT returned (no OTP)
 *
 * Profile:
 *   4. GET  /api/auth/me            — returns current merchant profile
 *   5. PATCH /api/auth/profile      — updates name, businessName, whatsappNumber
 *
 * DB columns needed on `users`:   email (unique), passwordHash
 * DB columns needed on `otpSessions`: email (can reuse `phone` column short-term, but
 *   schema migration to add `email` text column is recommended)
 */

import bcrypt from "bcryptjs";
import { db, withDbRetry } from "../db/index.js";
import {
  otpSessions, users, subscriptions,
} from "../db/index.js";
import { eq, and, gt, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { signToken } from "../lib/jwt.js";
import { sendSignupOtpEmail, sendPasswordResetEmail } from "../lib/email.js";
import { rateLimit } from "../middlewares/rateLimit.js";

// Auto-create push tokens table on startup
await withDbRetry(() => db.execute(sql`
  CREATE TABLE IF NOT EXISTS user_push_tokens (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id     TEXT NOT NULL,
    token       TEXT NOT NULL,
    platform    TEXT DEFAULT 'unknown',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, token)
  )
`), { label: "push" }).catch((e) => console.error("[push] Table setup failed:", e));

const router = Router();

// 10 attempts per 15 minutes per IP on sensitive auth routes
const authLimiter = rateLimit(10, 15 * 60 * 1000);

// ─── Helper: generate a 6-digit OTP ──────────────────────────────────────────

function generateOtp(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(100000 + (array[0]! % 900000));
}

function generateReferralCode(name?: string): string {
  const prefix = name ? name.slice(0, 4).toUpperCase().replace(/\s/g, "") : "KIOSK";
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${suffix}`;
}

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
// Registers a new merchant and sends an OTP to their email.

const signupSchema = z.object({
  email: z.string().email("Valid email required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  referralCode: z.string().optional(),
});

router.post("/auth/signup", authLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { email, password, referralCode } = parsed.data;
  const lowerEmail = email.toLowerCase();

  // Check if email is already fully verified
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, lowerEmail))
    .limit(1);

  // Block re-signup only if account is active (verified and not deleted)
  if (existing?.emailVerified && !existing.isDeleted) {
    res.status(409).json({ success: false, error: "An account with this email already exists" });
    return;
  }

  // Hash password and store pending user (or revive deleted/unverified account)
  const passwordHash = await bcrypt.hash(password, 12);
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  if (existing && (!existing.emailVerified || existing.isDeleted)) {
    // Reset deleted or unverified account to a fresh pending state
    await db.update(users).set({
      passwordHash,
      emailVerified: false,
      isDeleted: false,
      deletedAt: null,
      updatedAt: new Date(),
    }).where(eq(users.id, existing.id));
  } else {
    // Create pending (unverified) user record
    let referredById: string | undefined;
    if (referralCode) {
      const [referrer] = await db.select().from(users).where(eq(users.referralCode, referralCode)).limit(1);
      referredById = referrer?.id;
    }
    await db.insert(users).values({
      email: lowerEmail,
      passwordHash,
      emailVerified: false,
      referralCode: generateReferralCode(),
      referredById: referredById ?? null,
    });
  }

  // Invalidate previous OTPs for this email and insert a fresh one
  await db
    .update(otpSessions)
    .set({ used: true })
    .where(and(eq(otpSessions.phone, lowerEmail), eq(otpSessions.used, false)));

  await db.insert(otpSessions).values({
    phone: lowerEmail, // using phone column to store email until schema migration
    otp,
    expiresAt,
  });

  // OTP is saved — respond immediately so the client navigates to the verify
  // screen without waiting for the SMTP round-trip (which can be slow).
  res.json({ success: true, message: `Verification code sent to ${lowerEmail}` });
  req.log.info({ email: lowerEmail }, "Signup OTP sent");

  sendSignupOtpEmail(lowerEmail, otp).catch((e) =>
    req.log.error({ email: lowerEmail, err: e }, "Signup OTP email failed")
  );
});

// ─── POST /api/auth/verify-email ─────────────────────────────────────────────
// Verifies the OTP sent during signup and marks the user as verified. Returns JWT.

const verifyEmailSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6, "OTP must be 6 digits"),
});

router.post("/auth/verify-email", authLimiter, async (req, res) => {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { email, otp } = parsed.data;
  const lowerEmail = email.toLowerCase();

  const [session] = await db
    .select()
    .from(otpSessions)
    .where(
      and(
        eq(otpSessions.phone, lowerEmail),
        eq(otpSessions.otp, otp),
        eq(otpSessions.used, false),
        gt(otpSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) {
    res.status(401).json({ success: false, error: "Invalid or expired verification code" });
    return;
  }

  await db.update(otpSessions).set({ used: true }).where(eq(otpSessions.id, session.id));

  // Mark the user as verified
  const [user] = await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.email, lowerEmail))
    .returning();

  if (!user) {
    res.status(404).json({ success: false, error: "User not found" });
    return;
  }

  const token = signToken({ userId: user.id, email: user.email! });

  req.log.info({ userId: user.id }, "Email verified — merchant signed up");
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      businessName: user.businessName,
      referralCode: user.referralCode,
      kycVerified: user.kycVerified,
      walletBalance: user.walletBalance,
    },
  });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
// Logs in an existing merchant with email + password. No OTP needed.

const loginSchema = z.object({
  email: z.string().email("Valid email required"),
  password: z.string().min(1, "Password is required"),
});

router.post("/auth/login", authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { email, password } = parsed.data;
  const lowerEmail = email.toLowerCase();

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, lowerEmail))
    .limit(1);

  if (!user || !user.passwordHash) {
    // Generic message to avoid email enumeration
    res.status(401).json({ success: false, error: "Invalid email or password" });
    return;
  }

  if (user.isDeleted) {
    res.status(401).json({ success: false, error: "This account no longer exists. Sign up to create a new account." });
    return;
  }

  if (!user.emailVerified) {
    res.status(401).json({ success: false, error: "Email not verified. Please complete signup first." });
    return;
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    res.status(401).json({ success: false, error: "Invalid email or password" });
    return;
  }

  const token = signToken({ userId: user.id, email: user.email! });

  req.log.info({ userId: user.id }, "Merchant logged in");
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      businessName: user.businessName,
      referralCode: user.referralCode,
      kycVerified: user.kycVerified,
      walletBalance: user.walletBalance,
    },
  });
});

// ─── POST /api/auth/resend-otp ────────────────────────────────────────────────
// Resends the signup verification OTP.

const resendOtpSchema = z.object({
  email: z.string().email(),
});

router.post("/auth/resend-otp", authLimiter, async (req, res) => {
  const parsed = resendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const lowerEmail = parsed.data.email.toLowerCase();

  const [user] = await db.select().from(users).where(eq(users.email, lowerEmail)).limit(1);
  if (!user || user.emailVerified) {
    // Don't reveal whether email exists
    res.json({ success: true, message: "If that email is pending verification, a new code was sent." });
    return;
  }

  await db
    .update(otpSessions)
    .set({ used: true })
    .where(and(eq(otpSessions.phone, lowerEmail), eq(otpSessions.used, false)));

  const otp = generateOtp();
  await db.insert(otpSessions).values({
    phone: lowerEmail,
    otp,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  res.json({ success: true, message: "Verification code resent" });

  sendSignupOtpEmail(lowerEmail, otp).catch((e) =>
    req.log.error({ email: lowerEmail, err: e }, "Resend OTP email failed")
  );
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────

router.get("/auth/me", requireAuth, async (req, res) => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.user!.userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ success: false, error: "User not found" });
    return;
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      businessName: user.businessName,
      businessAddress: user.businessAddress,
      whatsappNumber: user.whatsappNumber,
      referralCode: user.referralCode,
      kycVerified: user.kycVerified,
      walletBalance: user.walletBalance,
      deliveryFeeLagos: user.deliveryFeeLagos,
      deliveryFeeOther: user.deliveryFeeOther,
      freeDeliveryThreshold: user.freeDeliveryThreshold,
      createdAt: user.createdAt,
    },
  });
});

// ─── PATCH /api/auth/profile ─────────────────────────────────────────────────

const updateProfileSchema = z.object({
  name: z.string().optional(),
  businessName: z.string().optional(),
  businessAddress: z.string().optional(),
  whatsappNumber: z.string().optional(),
  username: z.string().regex(/^[a-z0-9_]+$/, "Username can only contain lowercase letters, numbers, and underscores").optional(),
  customDomain: z.string().nullable().optional(),
  // Vendor-configured delivery charges shown at checkout.
  deliveryFeeLagos: z.number().min(0).max(100000).optional(),
  deliveryFeeOther: z.number().min(0).max(100000).optional(),
  freeDeliveryThreshold: z.number().min(0).max(1000000).nullable().optional(),
});

router.patch("/auth/profile", requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const [updated] = await db
    .update(users)
    .set({
      ...parsed.data,
      // decimal columns take strings
      deliveryFeeLagos: parsed.data.deliveryFeeLagos != null ? String(parsed.data.deliveryFeeLagos) : undefined,
      deliveryFeeOther: parsed.data.deliveryFeeOther != null ? String(parsed.data.deliveryFeeOther) : undefined,
      freeDeliveryThreshold: parsed.data.freeDeliveryThreshold != null ? String(parsed.data.freeDeliveryThreshold) : null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, req.user!.userId))
    .returning();

  res.json({ success: true, user: updated });
});

// ─── POST /api/auth/push-token ───────────────────────────────────────────────
// Vendor app registers its Expo push token so server can send notifications.

const pushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["android", "ios", "web"]).optional(),
});

router.post("/auth/push-token", requireAuth, async (req, res) => {
  const parsed = pushTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { token, platform } = parsed.data;
  const userId = req.user!.userId;

  await db.execute(sql`
    INSERT INTO user_push_tokens (user_id, token, platform)
    VALUES (${userId}, ${token}, ${platform ?? "unknown"})
    ON CONFLICT (user_id, token) DO NOTHING
  `);

  res.json({ success: true });
});

// ─── DELETE /api/auth/account ────────────────────────────────────────────────
// Permanently deletes the merchant's account and all associated data.
// Requires password confirmation to prevent accidental or malicious deletion.

const deleteAccountSchema = z.object({
  password: z.string().min(1, "Password is required to confirm account deletion"),
});

router.delete("/auth/account", requireAuth, async (req, res) => {
  const parsed = deleteAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  if (!user) {
    res.status(404).json({ success: false, error: "Account not found" });
    return;
  }

  // Verify password before allowing deletion
  const passwordOk = user.passwordHash
    ? await bcrypt.compare(parsed.data.password, user.passwordHash)
    : false;

  if (!passwordOk) {
    res.status(401).json({ success: false, error: "Incorrect password. Please try again." });
    return;
  }

  const userId = user.id;

  // ── Soft-delete: disable the account and clear credentials, keep all data ──
  await db.update(users).set({
    isDeleted: true,
    deletedAt: new Date(),
    passwordHash: null,            // prevent login
    whatsappAccessToken: null,     // revoke Meta integration
    whatsappPhoneNumberId: null,
    whatsappNumber: null,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  // Cancel any active subscriptions
  await db.update(subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")));

  // Clear ephemeral session data
  await db.execute(sql`DELETE FROM user_push_tokens WHERE user_id = ${userId}`);
  await db.update(otpSessions).set({ used: true }).where(eq(otpSessions.phone, user.email ?? ""));

  req.log.info({ userId }, "Account soft-deleted");
  res.json({ success: true, message: "Your account has been deactivated." });
});

// ─── POST /api/auth/forgot-password ─────────────────────────────────────────
// Sends a password-reset OTP to the merchant's email.
// Always returns success to avoid revealing whether the email exists.

const forgotPasswordSchema = z.object({
  email: z.string().email("Valid email required"),
});

router.post("/auth/forgot-password", authLimiter, async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const lowerEmail = parsed.data.email.toLowerCase();

  res.json({ success: true, message: "If an account exists for that email, a reset code has been sent." });

  const [user] = await db.select().from(users).where(eq(users.email, lowerEmail)).limit(1);
  if (!user || user.isDeleted || !user.emailVerified) return;

  await db.update(otpSessions).set({ used: true })
    .where(and(eq(otpSessions.phone, lowerEmail), eq(otpSessions.used, false)));

  const otp = generateOtp();
  await db.insert(otpSessions).values({
    phone: lowerEmail,
    otp,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  sendPasswordResetEmail(lowerEmail, otp).catch((e) =>
    req.log.error({ email: lowerEmail, err: e }, "Password reset email failed")
  );
});

// ─── POST /api/auth/reset-password ──────────────────────────────────────────
// Verifies the reset OTP and sets a new password.

const resetPasswordSchema = z.object({
  email: z.string().email("Valid email required"),
  otp: z.string().length(6, "Code must be 6 digits"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/auth/reset-password", authLimiter, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { otp, newPassword } = parsed.data;
  const lowerEmail = parsed.data.email.toLowerCase();

  const [session] = await db.select().from(otpSessions)
    .where(and(
      eq(otpSessions.phone, lowerEmail),
      eq(otpSessions.otp, otp),
      eq(otpSessions.used, false),
      gt(otpSessions.expiresAt, new Date()),
    ))
    .limit(1);

  if (!session) {
    res.status(401).json({ success: false, error: "Invalid or expired reset code" });
    return;
  }

  await db.update(otpSessions).set({ used: true }).where(eq(otpSessions.id, session.id));

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.email, lowerEmail));

  req.log.info({ email: lowerEmail }, "Password reset successful");
  res.json({ success: true, message: "Password updated. You can now sign in." });
});

// ─── Helper: get push tokens for a user ──────────────────────────────────────

export async function getPushTokens(userId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT token FROM user_push_tokens WHERE user_id = ${userId}
  `);
  const data = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  return data.map((r: any) => r.token as string).filter(Boolean);
}

export default router;
