/**
 * JWT utility — sign and verify merchant auth tokens.
 *
 * Tokens carry { userId, email } and expire after 30 days.
 * Set JWT_SECRET in environment variables (min 32 chars recommended).
 */

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env["JWT_SECRET"];
if (!JWT_SECRET) {
  // Fail closed in production — a forgeable token means anyone can be any vendor.
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    throw new Error("[SECURITY] JWT_SECRET is required in production.");
  }
  console.warn("[SECURITY] JWT_SECRET is not set — using insecure default in dev. Set it in production.");
}
const resolvedSecret = JWT_SECRET ?? "kiosk-dev-secret-only-for-local-development";
const JWT_EXPIRES_IN = "30d";

export interface JwtPayload {
  userId: string;
  email: string;
}

/** Create a signed JWT token for a merchant. */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, resolvedSecret, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify a JWT token and return the payload.
 * Throws JsonWebTokenError if the token is invalid or expired.
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, resolvedSecret) as JwtPayload;
}
