/**
 * Simple in-memory rate limiter — no external library needed.
 * Tracks requests per IP using a sliding window.
 * Resets automatically; entries are cleaned up to avoid memory leaks.
 */

import type { Request, Response, NextFunction } from "express";

interface Window {
  count: number;
  resetAt: number;
}

const store = new Map<string, Window>();

// Prune stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, win] of store) {
    if (win.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Creates a rate-limit middleware.
 * @param maxRequests  Max requests allowed per window
 * @param windowMs     Window size in milliseconds
 */
export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";
    const key = `${req.path}:${ip}`;
    const now = Date.now();

    let win = store.get(key);
    if (!win || win.resetAt < now) {
      win = { count: 1, resetAt: now + windowMs };
      store.set(key, win);
    } else {
      win.count++;
    }

    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - win.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(win.resetAt / 1000)));

    if (win.count > maxRequests) {
      res.status(429).json({ success: false, error: "Too many requests. Please wait and try again." });
      return;
    }
    next();
  };
}
