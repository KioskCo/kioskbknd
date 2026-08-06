/**
 * JWT authentication middleware.
 *
 * Attach this to any route that requires a logged-in merchant.
 * On success it adds `req.user` ({ userId, phone }) to the request object.
 * On failure it returns 401 with a clear error message.
 *
 * Usage:
 *   router.get("/products", requireAuth, productsHandler);
 */

import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/jwt.js";

// Extend Express's Request type so TypeScript knows about req.user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload; // { userId, email }
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: "Authorization header missing or malformed. Expected: Bearer <token>",
    });
    return;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: "Token is invalid or expired. Please log in again.",
    });
  }
}
