/**
 * Wallet routes — merchant wallet & bank accounts.
 *
 * GET    /api/wallet/balance       — get wallet balance + recent transactions
 * POST   /api/wallet/withdraw      — initiate a withdrawal to bank account
 * GET    /api/wallet/transactions  — list all transactions
 *
 * Bank accounts:
 * GET    /api/wallet/banks         — list saved bank accounts
 * POST   /api/wallet/banks         — add a bank account
 * DELETE /api/wallet/banks/:id     — remove a bank account
 * PATCH  /api/wallet/banks/:id/primary — set as primary account
 */

import { db, users, walletTransactions, bankAccounts } from "../db/index.js";
import { eq, desc, sql, and } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "./auth.js";
import { createTransferRecipient, initiateTransfer } from "../lib/paystack.js";
import { computeTransferFee } from "../lib/fees.js";

const router = Router();
router.use(requireAuth);

function formatNaira(n: number): string {
  return n.toLocaleString("en-NG", { minimumFractionDigits: 0 });
}

// ─── GET /api/wallet/balance ──────────────────────────────────────────────────

router.get("/wallet/balance", async (req, res) => {
  const userId = req.user!.userId;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  const recentTxns = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(10);

  // Compute escrow balance: sum of locked orders belonging to this merchant
  const escrowRows = await db.execute(sql`
    SELECT COALESCE(SUM(total_amount::numeric), 0)::text AS escrow_balance
    FROM orders
    WHERE user_id = ${userId} AND escrow_status = 'locked'
  `);
  const escrowRow = Array.isArray(escrowRows) ? escrowRows[0] : (escrowRows as any).rows?.[0];
  const escrowBalance = parseFloat(escrowRow?.escrow_balance ?? "0");

  res.json({
    success: true,
    data: {
      balance: parseFloat(String(user?.walletBalance ?? "0")),
      escrowBalance,
      transactions: recentTxns,
    },
  });
});

// ─── GET /api/wallet/transactions ─────────────────────────────────────────────

router.get("/wallet/transactions", async (req, res) => {
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, req.user!.userId))
    .orderBy(desc(walletTransactions.createdAt));

  res.json({ success: true, data: rows });
});

// ─── POST /api/wallet/withdraw ────────────────────────────────────────────────

const withdrawSchema = z.object({
  amount: z.number().positive("Withdrawal amount must be greater than 0"),
  bankAccountId: z.string().uuid("Invalid bank account ID"),
});

router.post("/wallet/withdraw", async (req, res) => {
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { amount, bankAccountId } = parsed.data;

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  const balance = parseFloat(String(user?.walletBalance ?? "0"));

  // Paystack transfer fee is charged to the vendor on top of the withdrawal.
  const transferFee = computeTransferFee(amount);
  const totalDebit = amount + transferFee;

  if (totalDebit > balance) {
    res.status(400).json({ success: false, error: `Insufficient wallet balance (₦${formatNaira(transferFee)} transfer fee included)` });
    return;
  }

  const [bank] = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.userId, req.user!.userId)))
    .limit(1);

  if (!bank) {
    res.status(404).json({ success: false, error: "Bank account not found" });
    return;
  }

  const reference = `kiosk-wd-${req.user!.userId}-${Date.now()}`;

  // Atomic deduction with an in-query balance guard — prevents two concurrent
  // withdrawals from both passing the balance check and minting a negative balance.
  // Deducts the amount + transfer fee (the fee is the vendor's cost).
  const deducted = await db.execute(sql`
    UPDATE users
    SET wallet_balance = wallet_balance - ${totalDebit}
    WHERE id = ${req.user!.userId} AND wallet_balance >= ${totalDebit}
    RETURNING wallet_balance
  `);
  const rows = Array.isArray(deducted) ? deducted : (deducted as any).rows;
  if (!rows || rows.length === 0) {
    res.status(400).json({ success: false, error: "Insufficient wallet balance" });
    return;
  }

  // Record the transaction
  const [txn] = await db
    .insert(walletTransactions)
    .values({
      userId: req.user!.userId,
      type: "withdrawal",
      amount: String(amount),
      description: `Withdrawal to ${bank.bankName} · ${bank.accountNumber} (${bank.accountName})${transferFee > 0 ? ` · ₦${formatNaira(transferFee)} transfer fee` : ""}`,
      status: "pending",
      reference,
    })
    .returning();

  // Initiate real Paystack transfer from platform owner's account to vendor's bank
  try {
    const recipientCode = await createTransferRecipient({
      accountName: bank.accountName,
      accountNumber: bank.accountNumber,
      bankCode: bank.bankCode,
    });

    const transfer = await initiateTransfer({
      amountKobo: Math.round(amount * 100),
      recipientCode,
      reference,
      reason: `Kiosk vendor withdrawal — ${bank.accountName}`,
    });

    await db
      .update(walletTransactions)
      .set({
        reference: transfer.transferCode,
        status: transfer.status === "success" ? "completed" : "pending",
      })
      .where(eq(walletTransactions.id, txn!.id));

    req.log.info({ txnId: txn!.id, transferCode: transfer.transferCode, amount }, "Paystack transfer initiated");
  } catch (err) {
    // Transfer failed — re-credit the wallet additively and mark the txn failed.
    // Additive (not `SET balance = <stale>`) so a concurrent deposit isn't clobbered.
    await db.execute(sql`
      UPDATE users
      SET wallet_balance = wallet_balance + ${totalDebit}
      WHERE id = ${req.user!.userId}
    `);
    await db.update(walletTransactions).set({ status: "failed" }).where(eq(walletTransactions.id, txn!.id));
    req.log.error({ err, amount }, "Paystack transfer failed — wallet restored");
    res.status(502).json({ success: false, error: "Bank transfer failed. Your balance has been restored. Try again." });
    return;
  }

  // Push notification to vendor
  getPushTokens(req.user!.userId).then((tokens) => {
    sendPushToMany(tokens, {
      title: "Withdrawal initiated",
      body:  `₦${amount.toLocaleString("en-NG")} is being sent to ${bank.bankName} · ${bank.accountNumber}`,
      data:  { type: "withdrawal", txnId: txn!.id },
    });
  }).catch(() => {});

  req.log.info({ txnId: txn!.id, amount, bank: bank.bankName }, "Withdrawal initiated");
  res.json({ success: true, data: txn });
});

// ─── GET /api/wallet/banks ────────────────────────────────────────────────────

router.get("/wallet/banks", async (req, res) => {
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.userId, req.user!.userId));

  res.json({ success: true, data: rows });
});

// ─── POST /api/wallet/banks ───────────────────────────────────────────────────

const addBankSchema = z.object({
  bankName: z.string().min(1),
  accountNumber: z.string().min(10).max(10),
  accountName: z.string().min(1),
  bankCode: z.string().optional(),
});

router.post("/wallet/banks", async (req, res) => {
  const parsed = addBankSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  // Check if this is the first bank account (make it primary)
  const existing = await db.select().from(bankAccounts).where(eq(bankAccounts.userId, req.user!.userId));
  const isPrimary = existing.length === 0;

  const [bank] = await db
    .insert(bankAccounts)
    .values({
      userId: req.user!.userId,
      bankCode: parsed.data.bankCode ?? "",
      bankName: parsed.data.bankName,
      accountNumber: parsed.data.accountNumber,
      accountName: parsed.data.accountName,
      isPrimary,
    })
    .returning();

  res.status(201).json({ success: true, data: bank });
});

// ─── DELETE /api/wallet/banks/:id ─────────────────────────────────────────────

router.delete("/wallet/banks/:id", async (req, res) => {
  const result = await db.delete(bankAccounts).where(
    and(eq(bankAccounts.id, req.params.id!), eq(bankAccounts.userId, req.user!.userId))
  ).returning();
  if (result.length === 0) {
    res.status(404).json({ success: false, error: "Bank account not found" });
    return;
  }
  res.json({ success: true, message: "Bank account removed" });
});

// ─── PATCH /api/wallet/banks/:id/primary ──────────────────────────────────────

router.patch("/wallet/banks/:id/primary", async (req, res) => {
  // Unset all primary first
  await db
    .update(bankAccounts)
    .set({ isPrimary: false })
    .where(eq(bankAccounts.userId, req.user!.userId));

  const [updated] = await db
    .update(bankAccounts)
    .set({ isPrimary: true })
    .where(and(eq(bankAccounts.id, req.params.id!), eq(bankAccounts.userId, req.user!.userId)))
    .returning();

  res.json({ success: true, data: updated });
});

export default router;
