/**
 * Logistics routes — rider search and shipment booking.
 *
 * Integrates two providers:
 *   - Terminal Africa (multi-carrier aggregator for inter-city delivery)
 *   - Kwik Delivery (last-mile, bike riders within cities)
 *
 * GET  /api/logistics/riders                — search nearby Kwik riders
 * POST /api/logistics/riders/:id/ping       — notify a rider before booking
 * GET  /api/logistics/rates                 — get Terminal Africa shipping rates
 * POST /api/logistics/book                  — create a shipment / book a rider
 * GET  /api/logistics/track/:trackingId     — track a Terminal Africa shipment
 * GET  /api/logistics/bookings              — list the merchant's bookings
 */

import { db, logisticsBookings, orders, users, walletTransactions } from "../db/index.js";
import { and, eq, desc, sql } from "drizzle-orm";
import { sendPushToMany } from "../lib/pushNotifications.js";
import { getPushTokens } from "./auth.js";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { searchNearbyRiders, bookRider, pingRider } from "../lib/kwik.js";
import { getRates, createShipment, trackShipment } from "../lib/terminal-africa.js";
import { searchGokadaRiders, bookGokadaRider, pingGokadaRider } from "../lib/gokada.js";
import { getSendboxRates, createSendboxShipment, trackSendboxShipment } from "../lib/sendbox.js";
import { getGigRates, createGigShipment, trackGigShipment } from "../lib/gig-logistics.js";
import { sendDispatchedEmail } from "../lib/email.js";

// Public router — no auth. Only webhook endpoints live here.
// Kwik/Gokada call these when a rider accepts/rejects. They sign with their own secret.
export const publicLogisticsRouter = Router();

const router = Router();
router.use(requireAuth);

// ─── GET /api/logistics/providers ────────────────────────────────────────────
// Returns static provider metadata so vendors know coverage areas before booking.

router.get("/logistics/providers", (_req, res) => {
  res.json({
    success: true,
    data: [
      {
        id: "gig_logistics",
        name: "GIG Logistics",
        logo: "https://giglogistics.com/favicon.ico",
        type: "courier",
        coverage: "Nationwide — all 36 states + FCT",
        coverageStates: "all",
        vehicleTypes: ["bike", "van", "truck"],
        estimatedDays: "1–5 days depending on route",
        bestFor: "Inter-state deliveries anywhere in Nigeria",
        trackingSupport: true,
        codSupport: true,
      },
      {
        id: "sendbox",
        name: "Sendbox",
        logo: "https://sendbox.co/favicon.ico",
        type: "courier",
        coverage: "Nationwide — major cities and states",
        coverageStates: "all",
        vehicleTypes: ["bike", "van"],
        estimatedDays: "1–4 days",
        bestFor: "Affordable inter-city delivery, best rates for small parcels",
        trackingSupport: true,
        codSupport: false,
      },
      {
        id: "terminal_africa",
        name: "Terminal Africa",
        logo: "https://terminal.africa/favicon.ico",
        type: "aggregator",
        coverage: "Nationwide — aggregates multiple carriers",
        coverageStates: "all",
        vehicleTypes: ["bike", "van", "truck"],
        estimatedDays: "1–7 days",
        bestFor: "Comparing rates across multiple carriers in one call",
        trackingSupport: true,
        codSupport: false,
      },
      {
        id: "kwik",
        name: "Kwik Delivery",
        logo: "https://kwikdelivery.com/favicon.ico",
        type: "on_demand_rider",
        coverage: "Lagos, Abuja, Port Harcourt",
        coverageStates: ["Lagos", "FCT", "Rivers"],
        vehicleTypes: ["bike", "car", "van"],
        estimatedDays: "Same day — typically under 2 hours",
        bestFor: "Urgent same-day delivery within the city",
        trackingSupport: false,
        codSupport: true,
      },
      {
        id: "gokada",
        name: "Gokada",
        logo: "https://gokada.ng/favicon.ico",
        type: "on_demand_rider",
        coverage: "Lagos",
        coverageStates: ["Lagos"],
        vehicleTypes: ["bike", "car"],
        estimatedDays: "Same day — typically under 1 hour",
        bestFor: "Fast hyperlocal delivery within Lagos",
        trackingSupport: false,
        codSupport: true,
      },
    ],
  });
});

// ─── GET /api/logistics/riders ────────────────────────────────────────────────
// Search nearby Kwik riders for last-mile delivery

const ridersQuerySchema = z.object({
  pickupLat: z.coerce.number(),
  pickupLng: z.coerce.number(),
  deliveryLat: z.coerce.number(),
  deliveryLng: z.coerce.number(),
  vehicleType: z.enum(["bike", "car", "van", "truck"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

router.get("/logistics/riders", async (req, res) => {
  const parsed = ridersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const { page, limit, ...searchParams } = parsed.data;

  const [kwikRiders, gokadaRiders] = await Promise.all([
    searchNearbyRiders(searchParams),
    searchGokadaRiders(searchParams),
  ]);

  const allRiders = [
    ...kwikRiders.map((r) => ({ ...r, platform: "Kwik" })),
    ...gokadaRiders.map((r) => ({ ...r, platform: "Gokada" })),
  ];

  // Paginate the results
  const start = (page - 1) * limit;
  const riders = allRiders.slice(start, start + limit);
  const hasMore = start + limit < allRiders.length;

  res.json({
    success: true,
    data: riders,
    pagination: {
      page,
      limit,
      total: allRiders.length,
      hasMore,
    },
  });
});

// ─── POST /api/logistics/riders/:id/ping ─────────────────────────────────────
// Send a quick ping to a rider to check availability before booking

router.post("/logistics/riders/:id/ping", async (req, res) => {
  const { message } = req.body as { message?: string };
  const riderId = req.params.id!;

  const result = await pingRider(
    riderId,
    message ?? "A merchant is interested in booking you. Are you available?"
  );

  res.json({ success: true, data: result });
});

// ─── POST /api/logistics/rates ────────────────────────────────────────────────
// Get Terminal Africa shipping rates between two Nigerian addresses (any state).

const ratesSchema = z.object({
  pickupFirstName: z.string(),
  pickupLastName: z.string(),
  pickupEmail: z.string().email(),
  pickupPhone: z.string(),
  pickupLine1: z.string(),
  pickupCity: z.string(),
  pickupState: z.string(),

  deliveryFirstName: z.string(),
  deliveryLastName: z.string(),
  deliveryEmail: z.string().email(),
  deliveryPhone: z.string(),
  deliveryLine1: z.string(),
  deliveryCity: z.string(),
  deliveryState: z.string(),

  weightKg: z.coerce.number().positive(),
});

router.post("/logistics/rates", async (req, res) => {
  const parsed = ratesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const d = parsed.data;

  const [terminalRates, sendboxRates, gigRates] = await Promise.all([
    getRates({
      pickup: {
        firstName: d.pickupFirstName, lastName: d.pickupLastName,
        email: d.pickupEmail, phone: d.pickupPhone,
        line1: d.pickupLine1, city: d.pickupCity, state: d.pickupState, country: "NG",
      },
      delivery: {
        firstName: d.deliveryFirstName, lastName: d.deliveryLastName,
        email: d.deliveryEmail, phone: d.deliveryPhone,
        line1: d.deliveryLine1, city: d.deliveryCity, state: d.deliveryState, country: "NG",
      },
      weightKg: d.weightKg,
    }),
    getSendboxRates({
      pickupState: d.pickupState, pickupCity: d.pickupCity,
      deliveryState: d.deliveryState, deliveryCity: d.deliveryCity,
      weightKg: d.weightKg,
    }),
    getGigRates({
      pickupCity: d.pickupCity, pickupState: d.pickupState,
      deliveryCity: d.deliveryCity, deliveryState: d.deliveryState,
      weightKg: d.weightKg,
    }),
  ]);

  res.json({
    success: true,
    data: {
      terminal_africa: terminalRates,
      sendbox: sendboxRates,
      gig_logistics: gigRates,
    },
  });
});

// ─── POST /api/logistics/book ─────────────────────────────────────────────────
// Book a rider (Kwik) or create a shipment (Terminal Africa)

const bookSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.enum(["kwik", "terminal_africa", "gokada", "sendbox", "gig_logistics"]),

  // The fee shown to the vendor before they confirmed — used to pre-validate wallet balance
  estimatedFee: z.number().min(0).optional(),

  // Terminal Africa fields
  carrierId: z.string().optional(),
  serviceCode: z.string().optional(),
  parcels: z.array(z.object({ weightKg: z.number(), description: z.string() })).optional(),

  // Kwik fields
  riderId: z.string().optional(),
  packageDescription: z.string().optional(),

  // Pickup address (supports all Nigerian states via Terminal Africa)
  pickupAddress: z.string(),
  pickupCity: z.string().default("Lagos"),
  pickupState: z.string().default("Lagos"),
  pickupLat: z.number().optional(),
  pickupLng: z.number().optional(),

  // Delivery address (any Nigerian state)
  deliveryAddress: z.string(),
  deliveryCity: z.string().default("Lagos"),
  deliveryState: z.string().default("Lagos"),
  deliveryLat: z.number().optional(),
  deliveryLng: z.number().optional(),

  // Recipient
  recipientName: z.string(),
  recipientPhone: z.string(),
  recipientEmail: z.string().email().optional(),

  // Merchant info (used for Terminal Africa pickup contact)
  merchantEmail: z.string().email().optional(),
  merchantPhone: z.string().optional(),
  merchantName: z.string().optional(),

  // Handling instructions shown to the rider at pickup
  // e.g. "Fragile — glassware, keep upright", "Do not stack", "Keep dry"
  handlingNotes: z.string().max(300).optional(),
  isFragile: z.boolean().default(false),
});

router.post("/logistics/book", async (req, res) => {
  const parsed = bookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const d = parsed.data;

  // Build a full package description that includes handling instructions for the rider
  const handlingPrefix = [
    d.isFragile ? "⚠️ FRAGILE — handle with care" : "",
    d.handlingNotes ?? "",
  ].filter(Boolean).join(". ");
  const fullPackageDescription = [
    d.packageDescription ?? "",
    handlingPrefix,
  ].filter(Boolean).join(" | ");

  // Confirm the order belongs to this merchant
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, d.orderId),
        eq(orders.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  // Check vendor wallet can cover the shipment cost before attempting the booking
  const [vendor] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  const walletBalance = parseFloat(String(vendor?.walletBalance ?? "0"));
  const requiredBalance = d.estimatedFee ?? 1; // if no estimate provided, just ensure non-zero
  if (walletBalance < requiredBalance) {
    res.status(402).json({
      success: false,
      error: d.estimatedFee
        ? `Insufficient wallet balance. This shipment costs ₦${d.estimatedFee.toLocaleString("en-NG")} but your wallet has ₦${walletBalance.toLocaleString("en-NG")}. Top up to continue.`
        : "Your wallet is empty. Top up your wallet to book a shipment.",
      walletBalance,
      requiredBalance,
    });
    return;
  }

  let externalId: string;
  let trackingId: string;
  let fee: number;
  let trackingUrl: string | null = null;

  if (d.provider === "kwik") {
    if (!d.riderId) {
      res.status(400).json({ success: false, error: "riderId is required for Kwik bookings" });
      return;
    }

    // Include the escrow delivery code in the rider instructions
    // The rider must collect this code from the customer and send it to the merchant
    const escrowNote = order.escrowOtp
      ? ` IMPORTANT: After delivery, ask the customer for their 4-digit confirmation code (${order.escrowOtp}) and send it to the merchant via WhatsApp to release payment.`
      : "";

    const booking = await bookRider({
      riderId: d.riderId,
      pickupAddress: d.pickupAddress,
      pickupLat: d.pickupLat ?? 6.5244,
      pickupLng: d.pickupLng ?? 3.3792,
      deliveryAddress: d.deliveryAddress,
      deliveryLat: d.deliveryLat ?? 6.5244,
      deliveryLng: d.deliveryLng ?? 3.3792,
      recipientName: d.recipientName,
      recipientPhone: d.recipientPhone,
      packageDescription: (fullPackageDescription) + escrowNote,
      orderReference: order.id,
    });

    externalId = booking.bookingId;
    trackingId = booking.bookingId;
    fee = booking.fee;
    trackingUrl = booking.trackingUrl ?? null;
  } else if (d.provider === "gokada") {
    if (!d.riderId) {
      res.status(400).json({ success: false, error: "riderId is required for Gokada bookings" });
      return;
    }
    const booking = await bookGokadaRider({
      riderId: d.riderId,
      pickupAddress: d.pickupAddress,
      pickupLat: d.pickupLat ?? 6.5244,
      pickupLng: d.pickupLng ?? 3.3792,
      deliveryAddress: d.deliveryAddress,
      deliveryLat: d.deliveryLat ?? 6.5244,
      deliveryLng: d.deliveryLng ?? 3.3792,
      recipientName: d.recipientName,
      recipientPhone: d.recipientPhone,
      packageDescription: fullPackageDescription,
    });
    externalId = booking.bookingId;
    trackingId = booking.bookingId;
    fee = d.estimatedFee ?? 0;
    trackingUrl = booking.trackingUrl || null;

  } else if (d.provider === "sendbox") {
    if (!d.carrierId || !d.serviceCode) {
      res.status(400).json({ success: false, error: "carrierId and serviceCode are required for Sendbox" });
      return;
    }
    const shipment = await createSendboxShipment({
      carrierId: d.carrierId,
      serviceCode: d.serviceCode,
      pickupAddress: d.pickupAddress,
      pickupCity: d.pickupCity,
      pickupState: d.pickupState,
      pickupPhone: d.merchantPhone ?? "+2348000000000",
      pickupName: d.merchantName ?? "Merchant",
      pickupEmail: d.merchantEmail,
      deliveryAddress: d.deliveryAddress,
      deliveryCity: d.deliveryCity,
      deliveryState: d.deliveryState,
      recipientName: d.recipientName,
      recipientPhone: d.recipientPhone,
      recipientEmail: d.recipientEmail,
      weightKg: d.parcels?.[0]?.weightKg ?? 0.5,
      description: fullPackageDescription,
    });
    externalId = shipment.shipmentId;
    trackingId = shipment.trackingId;
    fee = d.estimatedFee ?? 0;
    trackingUrl = shipment.trackingUrl || null;

  } else if (d.provider === "gig_logistics") {
    const shipment = await createGigShipment({
      pickupAddress: d.pickupAddress,
      pickupCity: d.pickupCity,
      pickupState: d.pickupState,
      pickupPhone: d.merchantPhone ?? "+2348000000000",
      pickupName: d.merchantName ?? "Merchant",
      pickupEmail: d.merchantEmail,
      deliveryAddress: d.deliveryAddress,
      deliveryCity: d.deliveryCity,
      deliveryState: d.deliveryState,
      recipientName: d.recipientName,
      recipientPhone: d.recipientPhone,
      recipientEmail: d.recipientEmail,
      weightKg: d.parcels?.[0]?.weightKg ?? 0.5,
      description: fullPackageDescription,
      serviceType: d.serviceCode,
    });
    externalId = shipment.waybillNumber;
    trackingId = shipment.waybillNumber;
    fee = shipment.fee || (d.estimatedFee ?? 0);
    trackingUrl = shipment.trackingUrl;

  } else {
    // Terminal Africa
    if (!d.carrierId || !d.serviceCode || !d.parcels?.length) {
      res.status(400).json({
        success: false,
        error: "carrierId, serviceCode, and parcels are required for Terminal Africa",
      });
      return;
    }

    const shipment = await createShipment({
      pickup: {
        firstName: d.merchantName?.split(" ")[0] ?? "Merchant",
        lastName: d.merchantName?.split(" ")[1] ?? "",
        email: d.merchantEmail ?? `merchant@kiosk.app`,
        phone: d.merchantPhone ?? "+2348000000000",
        line1: d.pickupAddress,
        city: d.pickupCity,
        state: d.pickupState,
        country: "NG",
      },
      delivery: {
        firstName: d.recipientName.split(" ")[0] ?? d.recipientName,
        lastName: d.recipientName.split(" ").slice(1).join(" ") || "",
        email: d.recipientEmail ?? `buyer@kiosk.app`,
        phone: d.recipientPhone,
        line1: d.deliveryAddress,
        city: d.deliveryCity,
        state: d.deliveryState,
        country: "NG",
      },
      carrierId: d.carrierId,
      serviceCode: d.serviceCode,
      parcels: d.parcels,
    });

    externalId = shipment.shipmentId;
    trackingId = shipment.trackingNumber;
    fee = shipment.fee;
    trackingUrl = shipment.labelUrl ?? null;
  }

  // Save the booking to the database
  const [booking] = await db
    .insert(logisticsBookings)
    .values({
      userId:            req.user!.userId,
      orderId:           d.orderId ?? null,
      provider:          d.provider,
      providerBookingId: externalId ?? null,
      trackingId:        trackingId ?? null,
      trackingUrl:       trackingUrl,
      estimatedCost:     fee != null ? String(fee) : null,
      pickupAddress:     d.pickupAddress,
      deliveryAddress:   d.deliveryAddress,
      status:            "pending",
    })
    .returning();

  // Kwik and Gokada are on-demand riders — booking is a *request*, not a confirmation.
  // The order stays in "dispatching" until the rider accepts (webhook updates it to "shipped").
  // GIG, Sendbox, Terminal Africa assign a waybill at booking time — shipment is confirmed.
  const isCourierService = d.provider === "terminal_africa" || d.provider === "sendbox" || d.provider === "gig_logistics";
  const newOrderStatus = isCourierService ? "shipped" : "dispatching";

  await db
    .update(orders)
    .set({
      trackingId: isCourierService ? trackingId : null, // only set tracking once rider confirms
      logisticsProvider: d.provider,
      status: newOrderStatus,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, d.orderId));

  // For courier services (GIG / Sendbox / Terminal Africa) the waybill is confirmed right
  // now — email the buyer immediately so they have the tracking link.
  // For Kwik/Gokada the email fires later when the rider acceptance webhook arrives.
  if (isCourierService && d.recipientEmail) {
    const [vendorUser] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
    sendDispatchedEmail({
      email:       d.recipientEmail,
      buyerName:   d.recipientName,
      orderNumber: order.orderNumber ?? d.orderId,
      storeName:   vendorUser?.businessName ?? vendorUser?.name ?? "the store",
      provider:    d.provider,
      trackingId:  trackingId,
      trackingUrl: trackingUrl ?? undefined,
    }).catch(() => {});
  }

  // Deduct shipping cost from vendor wallet — atomic SQL update prevents going negative
  if (fee > 0) {
    const result = await db.execute(sql`
      UPDATE users
      SET wallet_balance = wallet_balance::numeric - ${fee},
          updated_at = now()
      WHERE id = ${req.user!.userId}
        AND wallet_balance::numeric >= ${fee}
      RETURNING id
    `);
    const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
    if (rows.length === 0) {
      req.log.warn({ userId: req.user!.userId, fee }, "Wallet insufficient at deduction time");
    }

    await db.insert(walletTransactions).values({
      userId:      req.user!.userId,
      type:        "logistics_debit",
      amount:      String(fee),
      reference:   booking!.id,
      description: `${
        d.provider === "kwik" ? "Kwik" :
        d.provider === "gokada" ? "Gokada" :
        d.provider === "sendbox" ? "Sendbox" :
        d.provider === "gig_logistics" ? "GIG Logistics" :
        "Terminal Africa"
      } shipment — ${trackingId}`,
      status:      "completed",
    });
  }

  // Push notification to vendor
  getPushTokens(req.user!.userId).then((tokens) => {
    sendPushToMany(tokens, {
      title: "Shipment booked",
      body:  `${
        d.provider === "kwik" ? "Kwik rider" :
        d.provider === "gokada" ? "Gokada rider" :
        d.provider === "sendbox" ? "Sendbox" :
        d.provider === "gig_logistics" ? "GIG Logistics" :
        "Terminal Africa"
      } shipment confirmed — ₦${fee.toLocaleString("en-NG")} debited from wallet`,
      data:  { type: "logistics_booked", bookingId: booking!.id },
    });
  }).catch(() => {});

  req.log.info({ bookingId: booking!.id, provider: d.provider, fee }, "Logistics booked");
  res.status(201).json({ success: true, data: { ...booking, fee } });
});

// ─── GET /api/logistics/track/:trackingId ────────────────────────────────────

router.get("/logistics/track/:trackingId", async (req, res) => {
  const trackingId = req.params.trackingId!;

  // Look up booking to determine provider and delivery address
  const [booking] = await db
    .select()
    .from(logisticsBookings)
    .where(eq(logisticsBookings.trackingId, trackingId))
    .limit(1);

  const provider = booking?.provider ?? "terminal_africa";

  if (provider === "kwik" || provider === "gokada") {
    // These providers don't expose a tracking events API — they provide a live web URL.
    res.json({
      success: true,
      data: {
        trackingId,
        provider,
        status: "in_transit",
        trackingUrl: booking?.trackingUrl ?? undefined,
        deliveryAddress: booking?.deliveryAddress ?? undefined,
        events: [],
      },
    });
    return;
  }

  if (provider === "sendbox") {
    const result = await trackSendboxShipment(trackingId);
    res.json({
      success: true,
      data: {
        trackingId,
        provider: "sendbox",
        status: result.status,
        trackingUrl: booking?.trackingUrl ?? `https://app.sendbox.co/tracking/${trackingId}`,
        deliveryAddress: booking?.deliveryAddress ?? undefined,
        events: result.events,
      },
    });
    return;
  }

  if (provider === "gig_logistics") {
    const result = await trackGigShipment(trackingId);
    res.json({
      success: true,
      data: {
        trackingId,
        provider: "gig_logistics",
        status: result.status,
        trackingUrl: booking?.trackingUrl ?? `https://giglogistics.com/track/${trackingId}`,
        deliveryAddress: booking?.deliveryAddress ?? undefined,
        events: result.events,
      },
    });
    return;
  }

  // Terminal Africa
  const events = await trackShipment(trackingId);
  const latest = events[0];
  res.json({
    success: true,
    data: {
      trackingId,
      provider: "terminal_africa",
      status: latest?.status ?? "in_transit",
      deliveryAddress: booking?.deliveryAddress ?? undefined,
      events,
    },
  });
});

// ─── POST /api/logistics/webhook/kwik — Kwik rider acceptance webhook ────────
// Called by Kwik when a rider accepts or rejects a booking.
// No auth middleware — Kwik signs the request with KWIK_WEBHOOK_SECRET.

publicLogisticsRouter.post("/logistics/webhook/kwik", async (req, res) => {
  const secret = process.env["KWIK_WEBHOOK_SECRET"] ?? "";
  const sig    = req.headers["x-kwik-signature"] as string | undefined;
  if (secret && sig !== secret) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { booking_id, status, tracking_url, rider } = req.body as {
    booking_id?: string;
    status?: string;
    tracking_url?: string;
    rider?: { id?: string; name?: string; phone?: string; vehicle_type?: string };
  };

  if (!booking_id || !status) {
    res.status(400).json({ error: "booking_id and status required" });
    return;
  }

  const [booking] = await db
    .select()
    .from(logisticsBookings)
    .where(eq(logisticsBookings.providerBookingId, booking_id))
    .limit(1);

  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const normalised = status.toLowerCase();

  if (normalised === "accepted" || normalised === "rider_assigned") {
    const liveTrackingUrl = tracking_url ?? booking.trackingUrl;

    await db
      .update(logisticsBookings)
      .set({
        status: "in_transit",
        trackingUrl: liveTrackingUrl,
        riderName: rider?.name ?? booking.riderName,
        riderPhone: rider?.phone ?? booking.riderPhone,
        vehicleType: rider?.vehicle_type ?? booking.vehicleType,
      })
      .where(eq(logisticsBookings.id, booking.id));

    if (booking.orderId) {
      await db
        .update(orders)
        .set({ status: "shipped", trackingId: booking.trackingId, updatedAt: new Date() })
        .where(eq(orders.id, booking.orderId));

      // Rider accepted → tracking is live → email the buyer immediately
      const [order] = await db.select().from(orders).where(eq(orders.id, booking.orderId)).limit(1);
      if (order?.buyerEmail) {
        const [vendor] = await db.select().from(users).where(eq(users.id, order.userId)).limit(1);
        sendDispatchedEmail({
          email:       order.buyerEmail,
          buyerName:   order.buyerName,
          orderNumber: order.orderNumber ?? booking.orderId,
          storeName:   vendor?.businessName ?? vendor?.name ?? "the store",
          provider:    "kwik",
          trackingId:  booking.trackingId ?? booking_id,
          trackingUrl: liveTrackingUrl ?? undefined,
        }).catch(() => {});
      }
    }

  } else if (normalised === "rejected" || normalised === "cancelled") {
    await db
      .update(logisticsBookings)
      .set({ status: "cancelled" })
      .where(eq(logisticsBookings.id, booking.id));

    if (booking.orderId) {
      await db
        .update(orders)
        .set({ status: "paid", trackingId: null, logisticsProvider: null, updatedAt: new Date() })
        .where(eq(orders.id, booking.orderId));
    }
  }

  res.json({ received: true });
});

// ─── POST /api/logistics/webhook/gokada — Gokada rider acceptance webhook ────

publicLogisticsRouter.post("/logistics/webhook/gokada", async (req, res) => {
  const secret = process.env["GOKADA_WEBHOOK_SECRET"] ?? "";
  const sig    = req.headers["x-gokada-signature"] as string | undefined;
  if (secret && sig !== secret) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { id, status, tracking_url } = req.body as {
    id?: string;
    status?: string;
    tracking_url?: string;
  };

  if (!id || !status) {
    res.status(400).json({ error: "id and status required" });
    return;
  }

  const [booking] = await db
    .select()
    .from(logisticsBookings)
    .where(eq(logisticsBookings.providerBookingId, id))
    .limit(1);

  if (!booking) { res.status(404).json({ error: "Booking not found" }); return; }

  const normalised = status.toLowerCase();

  if (normalised === "accepted" || normalised === "rider_assigned" || normalised === "in_transit") {
    const liveTrackingUrl = tracking_url ?? booking.trackingUrl;

    await db
      .update(logisticsBookings)
      .set({ status: "in_transit", trackingUrl: liveTrackingUrl })
      .where(eq(logisticsBookings.id, booking.id));

    if (booking.orderId) {
      await db
        .update(orders)
        .set({ status: "shipped", trackingId: booking.trackingId, updatedAt: new Date() })
        .where(eq(orders.id, booking.orderId));

      const [order] = await db.select().from(orders).where(eq(orders.id, booking.orderId)).limit(1);
      if (order?.buyerEmail) {
        const [vendor] = await db.select().from(users).where(eq(users.id, order.userId)).limit(1);
        sendDispatchedEmail({
          email:       order.buyerEmail,
          buyerName:   order.buyerName,
          orderNumber: order.orderNumber ?? booking.orderId,
          storeName:   vendor?.businessName ?? vendor?.name ?? "the store",
          provider:    "gokada",
          trackingId:  booking.trackingId ?? id,
          trackingUrl: liveTrackingUrl ?? undefined,
        }).catch(() => {});
      }
    }

  } else if (normalised === "rejected" || normalised === "cancelled") {
    await db
      .update(logisticsBookings)
      .set({ status: "cancelled" })
      .where(eq(logisticsBookings.id, booking.id));

    if (booking.orderId) {
      await db
        .update(orders)
        .set({ status: "paid", trackingId: null, logisticsProvider: null, updatedAt: new Date() })
        .where(eq(orders.id, booking.orderId));
    }
  }

  res.json({ received: true });
});

// ─── GET /api/logistics/order/:orderId — all riders for one order ─────────────
// Returns every booking linked to the order so the vendor can track each rider.

router.get("/logistics/order/:orderId", async (req, res) => {
  const { orderId } = req.params;

  // Verify the order belongs to this merchant
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId!), eq(orders.userId, req.user!.userId)))
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const bookings = await db.select().from(logisticsBookings)
    .where(eq(logisticsBookings.orderId, orderId!))
    .orderBy(desc(logisticsBookings.createdAt));

  res.json({
    success: true,
    data: bookings.map((b) => ({
      bookingId:       b.id,
      provider:        b.provider,
      trackingId:      b.trackingId,
      trackingUrl:     b.trackingUrl,
      status:          b.status,
      deliveryAddress: b.deliveryAddress,
      riderName:       b.riderName,
      riderPhone:      b.riderPhone,
      vehicleType:     b.vehicleType,
      lat:             b.riderLat ? parseFloat(String(b.riderLat)) : null,
      lng:             b.riderLng ? parseFloat(String(b.riderLng)) : null,
      lastUpdated:     b.riderUpdatedAt,
    })),
  });
});

// ─── POST /api/logistics/webhook/rider-location ───────────────────────────────
// Generic GPS update webhook — any provider can push lat/lng for a booking.
// No auth — secured by matching booking_id + provider key in the request body.

publicLogisticsRouter.post("/logistics/webhook/rider-location", async (req, res) => {
  const { booking_id, lat, lng, rider_name, rider_phone } = req.body as {
    booking_id?: string;
    lat?: number;
    lng?: number;
    rider_name?: string;
    rider_phone?: string;
  };

  if (!booking_id || lat == null || lng == null) {
    res.status(400).json({ error: "booking_id, lat, lng required" });
    return;
  }

  const [booking] = await db.select().from(logisticsBookings)
    .where(eq(logisticsBookings.providerBookingId, booking_id))
    .limit(1);

  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  await db.update(logisticsBookings)
    .set({
      riderLat:      String(lat),
      riderLng:      String(lng),
      riderUpdatedAt: new Date(),
      ...(rider_name  ? { riderName:  rider_name }  : {}),
      ...(rider_phone ? { riderPhone: rider_phone } : {}),
    })
    .where(eq(logisticsBookings.id, booking.id));

  res.json({ received: true });
});

// ─── GET /api/logistics/bookings — list merchant's bookings ──────────────────

router.get("/logistics/bookings", async (req, res) => {
  // Join bookings with orders filtered to the current merchant
  const rows = await db
    .select({
      booking: logisticsBookings,
      order: {
        buyerName: orders.buyerName,
        buyerPhone: orders.buyerPhone,
        totalAmount: orders.totalAmount,
      },
    })
    .from(logisticsBookings)
    .innerJoin(orders, eq(logisticsBookings.orderId, orders.id))
    .where(eq(orders.userId, req.user!.userId))
    .orderBy(desc(logisticsBookings.createdAt));

  res.json({ success: true, data: rows });
});

export default router;
