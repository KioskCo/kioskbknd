/**
 * Admin routes — platform settings.
 *
 * These endpoints require a JWT whose email is in the ADMIN_EMAILS env var.
 *
 *   GET  /api/admin/settings    — current platform settings (e.g. beta program)
 *   PATCH /api/admin/settings   — toggle a setting ({ beta_testing_enabled: true })
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { db, appSettings } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  BETA_SETTING_KEY,
  BETA_TESTER_LIMIT,
  EARLY_ADOPTER_LIMIT,
  betaTestingEnabled,
  ensureBetaSetting,
  isAdminEmail,
} from "../lib/settings.js";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminEmail(req.user?.email)) {
    res.status(403).json({ success: false, error: "Admins only" });
    return;
  }
  next();
}

router.use(requireAuth, requireAdmin);

// ─── GET /api/admin/settings ──────────────────────────────────────────────────

router.get("/admin/settings", async (req, res) => {
  await ensureBetaSetting();
  const enabled = await betaTestingEnabled();
  res.json({
    success: true,
    data: {
      beta_testing_enabled: enabled,
      beta_tester_limit: BETA_TESTER_LIMIT,
      early_adopter_limit: EARLY_ADOPTER_LIMIT,
    },
  });
});

// ─── PATCH /api/admin/settings ────────────────────────────────────────────────

const patchSchema = z.object({
  beta_testing_enabled: z.boolean().optional(),
});

router.patch("/admin/settings", async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid settings payload" });
    return;
  }

  if (parsed.data.beta_testing_enabled !== undefined) {
    await db
      .insert(appSettings)
      .values({ key: BETA_SETTING_KEY, value: String(parsed.data.beta_testing_enabled) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: String(parsed.data.beta_testing_enabled) } });
    req.log.info({ value: parsed.data.beta_testing_enabled }, "Beta testing toggle updated by admin");
  }

  res.json({ success: true, data: { beta_testing_enabled: await betaTestingEnabled() } });
});

export default router;