/**
 * Referrals routes — merchant referral programme.
 *
 * GET  /api/referrals          — stats + referred list + referral wallet balance
 * POST /api/referrals/withdraw — withdraw referral earnings (separate from main wallet)
 *
 * Rules:
 *  - ₦200 credited to referrer when referred vendor pays any subscription plan
 *  - Earnings live in a SEPARATE referral wallet (not the main walletBalance)
 *  - Referral wallet balance = sum(referral_credit) - sum(referral_withdrawal) in wallet_transactions
 *  - Vendor can withdraw immediately once balance > 0
 */

import { db, referrals, users, walletTransactions, bankAccounts, buyerReferrals } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { shopBaseUrl } from "../lib/shopBase.js";

// The vendor-invite link's domain — derived from the same SHOP_BASE_URL env var
// that drives every other link on the platform (see lib/shopBase.ts), so
// pointing the platform at a new frontend only ever requires that one env
// change. shopBaseUrl() always ends in "/@" (it's meant to be a store-path
// prefix); strip that back to a bare origin for this non-store link.
function platformOrigin(): string {
  return shopBaseUrl().replace(/\/@$/, "");
}

const router = Router();
router.use(requireAuth);

export const REFERRAL_REWARD = 200; // ₦200 flat per paid referral

// ─── GET /api/referrals ───────────────────────────────────────────────────────

router.get("/referrals", async (req, res) => {
  const userId = req.user!.userId;

  const [merchant] = await db
    .select({ referralCode: users.referralCode, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const referred = await db
    .select({
      id: referrals.id,
      referredId: referrals.referredId,
      status: referrals.status,
      reward: referrals.reward,
      createdAt: referrals.createdAt,
      referredName: users.name,
      referredPhone: users.phone,
    })
    .from(referrals)
    .leftJoin(users, eq(referrals.referredId, users.id))
    .where(eq(referrals.referrerId, userId))
    .orderBy(desc(referrals.createdAt));

  // Referral wallet balance from wallet_transactions (separate from main wallet)
  const balanceRow = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'referral_credit' THEN amount::numeric ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN type = 'referral_withdrawal' THEN amount::numeric ELSE 0 END), 0)
      AS balance
    FROM wallet_transactions
    WHERE user_id = ${userId}
      AND type IN ('referral_credit', 'referral_withdrawal')
      AND status = 'completed'
  `);

  const rows = Array.isArray(balanceRow) ? balanceRow : (balanceRow as any).rows ?? [];
  const referralBalance = parseFloat(String(rows[0]?.balance ?? "0"));

  const paidReferrals = referred.filter((r) => r.status === "rewarded").length;
  const pendingReferrals = referred.filter((r) => r.status === "pending").length;

  res.json({
    success: true,
    data: {
      referralCode: merchant?.referralCode,
      referralLink: `${platformOrigin()}/join?ref=${merchant?.referralCode}`,
      referralBalance,
      rewardPerReferral: REFERRAL_REWARD,
      paidReferrals,
      pendingReferrals,
      totalReferrals: referred.length,
      referred: referred.map((r) => ({
        id: r.id,
        name: r.referredName ?? "Merchant",
        phone: r.referredPhone,
        status: r.status,
        reward: r.reward,
        joinedAt: r.createdAt,
      })),
    },
  });
});

// ─── POST /api/referrals/withdraw ────────────────────────────────────────────
// Vendor withdraws their referral wallet balance to their primary bank account.

const withdrawSchema = z.object({
  amount: z.number().positive("Amount must be positive"),
});

router.post("/referrals/withdraw", async (req, res) => {
  const userId = req.user!.userId;
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { amount } = parsed.data;

  // Compute current referral balance
  const balanceRow = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'referral_credit' THEN amount::numeric ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN type = 'referral_withdrawal' THEN amount::numeric ELSE 0 END), 0)
      AS balance
    FROM wallet_transactions
    WHERE user_id = ${userId}
      AND type IN ('referral_credit', 'referral_withdrawal')
      AND status = 'completed'
  `);
  const rows = Array.isArray(balanceRow) ? balanceRow : (balanceRow as any).rows ?? [];
  const balance = parseFloat(String(rows[0]?.balance ?? "0"));

  if (amount > balance) {
    res.status(400).json({ success: false, error: `Insufficient referral balance. Available: ₦${balance.toFixed(2)}` });
    return;
  }

  // Ensure vendor has a bank account on file
  const [bank] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.userId, userId))
    .orderBy(desc(bankAccounts.isPrimary))
    .limit(1);

  if (!bank) {
    res.status(400).json({ success: false, error: "Add a bank account in Settings before withdrawing" });
    return;
  }

  const reference = `ref-withdraw-${userId}-${Date.now()}`;

  await db.insert(walletTransactions).values({
    userId,
    type: "referral_withdrawal",
    amount: String(amount),
    reference,
    description: `Referral withdrawal to ${bank.bankName} ****${bank.accountNumber.slice(-4)}`,
    status: "completed",
  });

  req.log.info({ userId, amount, reference }, "Referral withdrawal processed");
  res.json({
    success: true,
    message: `₦${amount.toLocaleString()} withdrawal initiated to ${bank.bankName} ****${bank.accountNumber.slice(-4)}`,
    data: { amount, reference, bank: { name: bank.bankName, last4: bank.accountNumber.slice(-4) } },
  });
});

// ─── GET /api/referrals/buyers ───────────────────────────────────────────────
// Vendor sees buyer referral stats: who referred others and how many times

router.get("/referrals/buyers", async (req, res) => {
  const userId = req.user!.userId;

  const rows = await db
    .select()
    .from(buyerReferrals)
    .where(eq(buyerReferrals.vendorId, userId))
    .orderBy(desc(buyerReferrals.timesUsed));

  const totalUsed = rows.reduce((s, r) => s + (r.timesUsed ?? 0), 0);

  const [vendor] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  res.json({
    success: true,
    data: {
      totalReferrers: rows.length,
      totalReferredOrders: totalUsed,
      vendorUsername: vendor?.username ?? "",
      referrers: rows.map((r) => ({
        id: r.id,
        buyerName: r.buyerName,
        buyerPhone: r.buyerPhone,
        code: r.code,
        timesUsed: r.timesUsed ?? 0,
        createdAt: r.createdAt,
      })),
    },
  });
});

export default router;
