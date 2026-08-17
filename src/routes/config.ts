import { Router } from "express";

const router = Router();

const SHOP_BASE_URL = process.env["SHOP_BASE_URL"] ?? "https://keeosk.store/@";

// ─── GET /api/config ──────────────────────────────────────────────────────────
// Public runtime config for the vendor app. Clients read the current storefront
// base URL here so the app picks up SHOP_BASE_URL changes (e.g. pointing at a
// Cloudflare Workers deployment) without rebuilding the APK.

router.get("/config", (_req, res) => {
  res.json({
    success: true,
    data: {
      shopBaseUrl: SHOP_BASE_URL,
    },
  });
});

export default router;