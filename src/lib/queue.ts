/**
 * BullMQ queues.
 *
 * Centralised queue definitions + helpers. Workers that consume these queues
 * live in src/workers.ts (run as a separate process via `npm run start:worker`).
 *
 * Every dispatcher falls back to running the job inline when Redis is not
 * configured, so the server keeps working in local dev without Redis.
 */

import { Queue } from "bullmq";
import { redisEnabled } from "./redis.js";
import { logger } from "./logger.js";
import { handlePaymentEvent, processEscrowDeadlines } from "../jobs/escrow.js";
import { processAbandonedCartRecovery } from "../jobs/abandonedCarts.js";

type Conn = string;

function connection(): Conn {
  return process.env["REDIS_URL"] ?? "redis://localhost:6379";
}

// Queues are only constructed when Redis is available.
export const paymentQueue: Queue | null = redisEnabled
  ? new Queue("kiosk-payments", { connection: { url: connection(), maxRetriesPerRequest: null } })
  : null;
export const escrowQueue: Queue | null = redisEnabled
  ? new Queue("kiosk-escrow", { connection: { url: connection(), maxRetriesPerRequest: null } })
  : null;
export const abandonedCartQueue: Queue | null = redisEnabled
  ? new Queue("kiosk-abandoned-cart", { connection: { url: connection(), maxRetriesPerRequest: null } })
  : null;

// ─── Dispatchers (queue when Redis on, inline when off) ───────────────────────

export async function enqueuePaymentEvent(evt: {
  provider: "paystack" | "flutterwave";
  reference: string;
  channel?: string;
  idempotencyKey: string;
}): Promise<void> {
  if (!paymentQueue) {
    await handlePaymentEvent(evt);
    return;
  }
  try {
    await paymentQueue.add("pay", evt, {
      jobId: evt.idempotencyKey, // same provider+reference dropped as duplicate
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  } catch (err) {
    logger.error({ err }, "Failed to enqueue payment event — processing inline");
    await handlePaymentEvent(evt);
  }
}

// ── Repeatable job schedulers (idempotent — safe to call on every boot) ────────

export async function scheduleJobs(): Promise<void> {
  if (!redisEnabled || !escrowQueue || !abandonedCartQueue) return;

  // Airbag repeatable job — never needs manual scheduling.
  await escrowQueue.upsertJobScheduler(
    "escrow-scan",
    { every: 15 * 60 * 1000 },
    { name: "check-deadlines" },
  );

  await abandonedCartQueue.upsertJobScheduler(
    "abandoned-cart-recovery",
    { every: 15 * 60 * 1000 },
    { name: "recover" },
  );

  logger.info("BullMQ repeatable jobs registered");
}

// The processors exported here are consumed by src/workers.ts.
export const processors = {
  payment: handlePaymentEvent,
  escrow: processEscrowDeadlines,
  abandonedCart: processAbandonedCartRecovery,
};