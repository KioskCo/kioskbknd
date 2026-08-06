/**
 * BullMQ worker process entrypoint.
 *
 * Consumes the kiosk queues and registers repeatable schedulers. Run this as a
 * dedicated process (Railway "worker" service, or `npm run start:worker`).
 *
 * Separating the worker from the web process keeps heavy jobs (emails, refunds,
 * webhooks) from blocking API requests.
 */

import "./instrument.js";
import { Worker } from "bullmq";
import { redisEnabled } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { scheduleJobs } from "./lib/queue.js";
import { handlePaymentEvent, processEscrowDeadlines } from "./jobs/escrow.js";
import { processAbandonedCartRecovery } from "./jobs/abandonedCarts.js";

const connection = {
  url: process.env["REDIS_URL"] ?? "redis://localhost:6379",
  maxRetriesPerRequest: null,
};

const workers: Worker[] = [];

export function startWorkers(): void {
  if (!redisEnabled) {
    logger.warn("REDIS_URL not set — worker skipped. Redis is required for workers.");
    return;
  }

  const payment = new Worker(
    "kiosk-payments",
    async (job) => {
      await handlePaymentEvent(job.data);
    },
    { connection, concurrency: 5 },
  );
  workers.push(payment);

  const escrow = new Worker(
    "kiosk-escrow",
    async (job) => {
      if (job.name === "check-deadlines") {
        await processEscrowDeadlines();
      }
    },
    { connection, concurrency: 1 },
  );
  workers.push(escrow);

  const abandoned = new Worker(
    "kiosk-abandoned-cart",
    async (job) => {
      if (job.name === "recover") {
        await processAbandonedCartRecovery();
      }
    },
    { connection, concurrency: 1 },
  );
  workers.push(abandoned);

  for (const w of workers) {
    w.on("failed", (job, err) =>
      logger.error({ job: job?.name, jobId: job?.id, err: err.message }, "BullMQ job failed"));
    w.on("error", (err) => logger.warn({ err: err.message }, "BullMQ worker error"));
  }

  logger.info(`BullMQ workers started (${workers.length} queues)`);
}

export function stopWorkers(): Promise<void> {
  return Promise.all(workers.map((w) => w.close())).then(() => undefined);
}

// Entrypoint — only runs when this file is the main module.
if (import.meta.url === `file://${process.argv[1]}` || process.env["RUN_WORKER"] === "1") {
  startWorkers();
}

// Idle loop so the worker process stays alive in a plain `node`/pm2 run.
const keepAlive = () => setTimeout(keepAlive, 60_000);
if (import.meta.url === `file://${process.argv[1]}` || process.env["RUN_WORKER"] === "1") {
  scheduleJobs();
  keepAlive();
}