/**
 * Root API router — mounts all route modules under /api.
 *
 * Route overview:
 *   /api/healthz                     — health check
 *   /api/auth/*                      — OTP login, profile
 *   /api/products                    — product catalogue
 *   /api/orders                      — orders + escrow (with stock restore on refund)
 *   /api/payments/*                  — Paystack + Flutterwave + webhooks
 *   /api/whatsapp/*                  — WhatsApp send + webhook
 *   /api/logistics/*                 — Kwik riders + Terminal Africa shipments
 *   /api/referrals/*                 — referral programme
 *   /api/ads/*                       — ad campaigns
 *   /api/templates/*                 — store/website builder
 *   /api/subscriptions/*             — merchant subscription plans
 *   /api/wallet/*                    — wallet balance + withdrawals + bank accounts
 *   /api/uploads/*                  — image upload config + presigned URLs
 *   /api/store/:username            — public: fetch active storefront template by vendor username
 *   /api/customers/*                — vendor customer list + newsletter subscribers
 *   /api/buyers/*                   — public: buyer-facing order placement + status lookup
 *   /api/analytics                  — sales / product / customer / inventory BI dashboard
 *   /api/reviews/*                  — product reviews (submit public, manage auth)
 *   /api/abandoned-carts/*          — track + recover abandoned carts, send recovery emails
 */

import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import configRouter from "./config.js";
import authRouter from "./auth.js";
import productsRouter from "./products.js";
import ordersRouter from "./orders.js";
import paymentsRouter from "./payments.js";
import whatsappRouter from "./whatsapp.js";
import logisticsRouter, { publicLogisticsRouter } from "./logistics.js";
import referralsRouter from "./referrals.js";
import adsRouter from "./ads.js";
import templatesRouter from "./templates.js";
import subscriptionsRouter from "./subscriptions.js";
import walletRouter from "./wallet.js";
import uploadsRouter from "./uploads.js";
import storeRouter from "./store.js";
import customersRouter from "./customers.js";
import buyersRouter from "./buyers.js";
import supportRouter from "./support.js";
import analyticsRouter from "./analytics.js";
import reviewsRouter from "./reviews.js";
import discountsRouter from "./discounts.js";
import waitlistRouter from "./waitlist.js";
import abandonedCartsRouter from "./abandoned-carts.js";
import adminRouter from "./admin.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(configRouter);
router.use(storeRouter);
router.use(customersRouter);
router.use(buyersRouter);
router.use(authRouter);
router.use(productsRouter);
router.use(ordersRouter);
router.use(paymentsRouter);
router.use(whatsappRouter);
router.use(publicLogisticsRouter);
router.use(logisticsRouter);
router.use(referralsRouter);
router.use(adsRouter);
router.use(templatesRouter);
router.use(subscriptionsRouter);
router.use(walletRouter);
router.use(uploadsRouter);
router.use(supportRouter);
router.use(analyticsRouter);
router.use(reviewsRouter);
router.use(discountsRouter);
router.use(waitlistRouter);
router.use(adminRouter);
router.use("/api/abandoned-carts", abandonedCartsRouter);

export default router;
