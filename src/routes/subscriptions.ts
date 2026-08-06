/**
 * Subscriptions routes — merchant subscription plans.
 *
 * GET  /api/subscriptions/me   — get the current merchant's active subscription
 * POST /api/subscriptions/pay  — initialize payment for a plan
 * POST /api/subscriptions/activate — activate subscription after payment
 */

import { db, subscriptions, users, referrals, walletTransactions, waitlist } from "../db/index.js";
import { eq, desc, and } from "drizzle-orm";
import { REFERRAL_REWARD } from "./referrals.js";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "./auth.js";
import { initializeTransaction as paystackInit, verifyTransaction as paystackVerify } from "../lib/paystack.js";
import { initializePayment as flwInit, verifyPayment as flwVerify } from "../lib/flutterwave.js";

const router = Router();
router.use(requireAuth);

const PRICE_PER_MONTH = 500; // ₦500/month
const PLANS = {
  "3months": { amount: 3000,  months: 3,  label: "3-Month Plan" },
  "6months": { amount: 6000,  months: 6,  label: "6-Month Plan" },
  "yearly":  { amount: 12000,  months: 12, label: "Annual Plan" },
};

function resolvePlan(plan: string, months?: number) {
  if (plan === "custom") {
    const m = Math.max(1, Math.min(120, months ?? 1));
    return { amount: PRICE_PER_MONTH * m, months: m, label: `${m}-Month Custom Plan` };
  }
  return PLANS[plan as keyof typeof PLANS];
}

// ─── GET /api/subscriptions/me ────────────────────────────────────────────────

const ADMIN_EMAILS = (process.env["ADMIN_EMAILS"] ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

router.get("/subscriptions/me", async (req, res) => {
  // Admin accounts get a permanent free subscription
  if (ADMIN_EMAILS.length > 0 && ADMIN_EMAILS.includes((req.user!.email ?? "").toLowerCase())) {
    return res.json({
      success: true,
      data: {
        id: "admin",
        userId: req.user!.userId,
        plan: "yearly",
        status: "active",
        startDate: new Date("2024-01-01").toISOString(),
        endDate:   new Date("2099-01-01").toISOString(),
        paymentProvider: null,
        paymentReference: null,
      },
    });
  }

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, req.user!.userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  res.json({ success: true, data: sub ?? null });
});

// ─── POST /api/subscriptions/pay ─────────────────────────────────────────────

const paySchema = z.object({
  plan: z.enum(["3months", "6months", "yearly", "custom"]),
  months: z.number().int().min(1).max(120).optional(),
  provider: z.enum(["paystack", "flutterwave"]).default("paystack"),
  callbackUrl: z.string().url().optional(),
});

router.post("/subscriptions/pay", async (req, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { plan, months, provider, callbackUrl } = parsed.data;
  if (plan === "custom" && !months) {
    res.status(400).json({ success: false, error: "months is required for custom plans" });
    return;
  }
  const planInfo = resolvePlan(plan, months);

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);

  // Apply 30% waitlist discount if the user's email is on the waitlist
  let discountedAmount = planInfo.amount;
  let isWaitlistMember = false;
  if (user?.email) {
    const [wlEntry] = await db.select({ id: waitlist.id }).from(waitlist).where(eq(waitlist.email, user.email)).limit(1);
    if (wlEntry) {
      isWaitlistMember = true;
      discountedAmount = Math.round(planInfo.amount * 0.70); // 30% off
    }
  }

  const reference = `kiosk-sub-${req.user!.userId}-${plan}${months ? `-${months}mo` : ""}-${Date.now()}`;

  let paymentUrl: string;

  if (provider === "paystack") {
    const result = await paystackInit({
      email: user?.email ?? `${req.user!.userId}@kiosk.app`,
      amountKobo: discountedAmount * 100,
      reference,
      callbackUrl,
      metadata: { plan, userId: req.user!.userId, type: "subscription" },
    });
    paymentUrl = result.authorizationUrl;
  } else {
    const result = await flwInit({
      txRef: reference,
      amountNaira: discountedAmount,
      email: user?.email ?? `${req.user!.userId}@kiosk.app`,
      phone: user?.phone ?? "",
      name: user?.name ?? "Merchant",
      redirectUrl: callbackUrl ?? "https://kiosk.app/subscription/success",
      description: `Kiosk ${planInfo.label}`,
      meta: { plan, userId: req.user!.userId },
    });
    paymentUrl = result.paymentLink;
  }

  res.json({ success: true, data: { paymentUrl, reference, provider, plan, months: planInfo.months, amount: discountedAmount, originalAmount: planInfo.amount, waitlistDiscount: isWaitlistMember } });
});

// ─── POST /api/subscriptions/activate ────────────────────────────────────────
// Called after successful payment verification

const activateSchema = z.object({
  plan: z.enum(["3months", "6months", "yearly", "custom"]),
  months: z.number().int().min(1).max(120).optional(),
  reference: z.string().min(1),
  provider: z.enum(["paystack", "flutterwave"]).default("paystack"),
});

router.post("/subscriptions/activate", async (req, res) => {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { plan, months, reference, provider } = parsed.data;
  if (plan === "custom" && !months) {
    res.status(400).json({ success: false, error: "months is required for custom plans" });
    return;
  }
  const planInfo = resolvePlan(plan, months);

  // Verify the payment actually succeeded
  let paid = false;
  if (provider === "flutterwave") {
    const result = await flwVerify(reference);
    paid = result.status === "successful";
  } else {
    const result = await paystackVerify(reference);
    paid = result.status === "success";
  }

  if (!paid) {
    res.status(402).json({ success: false, error: "Payment has not been confirmed" });
    return;
  }

  const startDate = new Date();
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + planInfo.months);

  const [sub] = await db
    .insert(subscriptions)
    .values({
      userId: req.user!.userId,
      plan,
      status: "active",
      startDate,
      endDate,
      paymentReference: reference,
      paymentProvider: provider,
    })
    .returning();

  req.log.info({ userId: req.user!.userId, plan }, "Subscription activated");

  // Credit referrer ₦200 referral reward if this user was referred and not yet rewarded
  try {
    const [subscriber] = await db
      .select({ referredById: users.referredById })
      .from(users)
      .where(eq(users.id, req.user!.userId))
      .limit(1);

    if (subscriber?.referredById) {
      const [existingReferral] = await db
        .select()
        .from(referrals)
        .where(
          and(
            eq(referrals.referrerId, subscriber.referredById),
            eq(referrals.referredId, req.user!.userId),
            eq(referrals.status, "rewarded"),
          )
        )
        .limit(1);

      if (!existingReferral) {
        // Update referral record to rewarded
        await db
          .update(referrals)
          .set({ status: "rewarded", reward: String(REFERRAL_REWARD) })
          .where(
            and(
              eq(referrals.referrerId, subscriber.referredById),
              eq(referrals.referredId, req.user!.userId),
            )
          );

        // Credit referral wallet (separate from main wallet)
        await db.insert(walletTransactions).values({
          userId: subscriber.referredById,
          type: "referral_credit",
          amount: String(REFERRAL_REWARD),
          reference: `ref-credit-${req.user!.userId}-${Date.now()}`,
          description: `Referral reward — invited merchant subscribed`,
          status: "completed",
        });

        // Notify referrer they earned a reward
        getPushTokens(subscriber.referredById).then((tokens) => {
          sendPushToMany(tokens, {
            title: "Referral reward earned!",
            body:  `₦${REFERRAL_REWARD.toLocaleString("en-NG")} added to your referral wallet`,
            data:  { type: "referral_credit" },
          });
        }).catch(() => {});

        req.log.info({ referrerId: subscriber.referredById, referredId: req.user!.userId }, "Referral reward credited");
      }
    }
  } catch (err) {
    req.log.error({ err }, "Failed to process referral credit");
  }

  // Notify the vendor their subscription is active
  getPushTokens(req.user!.userId).then((tokens) => {
    sendPushToMany(tokens, {
      title: "Subscription activated",
      body:  `Your ${sub.plan} plan is now active. Enjoy all features!`,
      data:  { type: "subscription_activated" },
    });
  }).catch(() => {});

  res.json({ success: true, data: sub });
});

// ─── POST /api/subscriptions/cancel ──────────────────────────────────────────

router.post("/subscriptions/cancel", async (req, res) => {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, req.user!.userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!sub) {
    res.status(404).json({ success: false, error: "No active subscription found" });
    return;
  }

  const [updated] = await db
    .update(subscriptions)
    .set({ status: "cancelled" })
    .where(eq(subscriptions.id, sub.id))
    .returning();

  req.log.info({ userId: req.user!.userId, subId: sub.id }, "Subscription cancelled");
  res.json({ success: true, data: updated });
});

export default router;
