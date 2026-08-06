/**
 * Redis client — used by BullMQ queues AND for direct use (cache, rate
 * limiting, distributed locks, OTP brute-force protection).
 *
 * BullMQ requires Redis >= 6.2. On Railway, add the Redis plugin and it
 * exposes REDIS_URL automatically. In local dev, set REDIS_URL in .env.
 */

import { Redis } from "ioredis";
import { logger } from "./logger.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "";

export const redisEnabled = Boolean(process.env["REDIS_URL"]);

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times) {
    // Back off from 1s to 30s so we don't hammer an unavailable Redis.
    return Math.min(times * 1000, 30000);
  },
});

if (redisEnabled) {
  redis.on("ready", () => logger.info("Redis ready"));
  redis.on("error", (err) => logger.warn({ err: err.message }, "Redis error"));
} else {
  logger.warn("REDIS_URL not set — Redis features disabled (queues/rate-limit/locks)");
}

/**
 * Acquire a distributed lock. Returns false if the key is already held.
 * Use `SET key val NX PX ttl` so it is atomic — no TOCTOU race.
 */
export async function acquireLock(
  key: string,
  ttlMs = 30_000,
): Promise<boolean> {
  if (!redisEnabled) return true; // single-instance dev: no lock needed
  try {
    const res = await redis.set(`lock:${key}`, "1", "PX", ttlMs, "NX");
    return res === "OK";
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, "acquireLock failed");
    return true; // fail open on redis errors so core flows aren't blocked
  }
}

export async function releaseLock(key: string): Promise<void> {
  if (!redisEnabled) return;
  try {
    await redis.del(`lock:${key}`);
  } catch {
    /* the TTL will clear it anyway */
  }
}

/**
 * Simple windowed rate limiter. Returns the count of calls in the window; the
 * caller decides whether to reject. Falls back to "always allow" when Redis is
 * down (dev), so rate limiting never bricks the API.
 */
export async function rateLimitHit(
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  if (!redisEnabled) return false;
  try {
    const n = await redis.incr(`rl:${key}`);
    if (n === 1) await redis.pexpire(`rl:${key}`, windowMs);
    return n > max;
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, "rateLimitHit failed");
    return false;
  }
}