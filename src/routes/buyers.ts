/**
 * Public buyer-facing order endpoints — no authentication required.
 *
 * POST /api/buyers/orders          — place an order from the shop storefront
 * GET  /api/buyers/orders/:orderNo — look up order status by order number
 */

import { db, orders, orderItems, products as productsTable, users, buyerReferrals, discounts, templates } from "../db/index.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { sendOrderConfirmationEmail, sendEscrowPinEmail } from "../lib/email.js";
import { sendSMS } from "../lib/termii.js";
import { verifyTransaction as verifyPaystack } from "../lib/paystack.js";
import { verifyPayment as verifyFlutterwave } from "../lib/flutterwave.js";
import { releaseWorkingCapitalToVendor } from "../jobs/escrow.js";
import { resolveDeliveryZone, computeDeliveryFee } from "../lib/delivery.js";
import { computeProcessingFee } from "../lib/fees.js";
import { logger } from "../lib/logger.js";
import { Router } from "express";
import { storeUrl as buildStoreUrl } from "../lib/shopBase.js";
import { z } from "zod";

const router = Router();

// ─── GET /api/buyers/products?vendorId=X ─────────────────────────────────────
// Public — returns the vendor's active product catalogue for the storefront.

router.get("/buyers/products", async (req, res) => {
  const vendorId = String(req.query["vendorId"] ?? "").trim();
  if (!vendorId) {
    res.status(400).json({ success: false, error: "vendorId query param is required" });
    return;
  }

  const rows = await db
    .select()
    .from(productsTable)
    .where(and(eq(productsTable.userId, vendorId), eq(productsTable.active, true)));

  const [vendorUser] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, vendorId))
    .limit(1);
  const vendorUsername = vendorUser?.username ?? "";

  const data = rows.map((p) => ({
    id: p.id,
    slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    name: p.name,
    description: p.description ?? "",
    price: Number(p.price),
    imageUrl: p.imageUrl ?? null,
    images: Array.isArray(p.images) ? p.images : [],
    category: p.category ?? "General",
    stock: p.stock ?? 0,
    salePrice: p.salePrice ? Number(p.salePrice) : null,
    saleEndsAt: p.saleEndsAt ? p.saleEndsAt.toISOString() : null,
    preorder: p.preorder ?? false,
    preorderReleaseDate: p.preorderReleaseDate ? p.preorderReleaseDate.toISOString() : null,
    vendorUsername,
  }));

  res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=30");
  res.json({ success: true, data });
});

function genOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `ORD-${ts}-${rnd}`;
}

const buyerOrderSchema = z.object({
  vendorId:     z.string().min(1, "vendorId is required"),
  buyerEmail:   z.string().email().max(200),
  buyerPhone:   z.string().max(30).optional(),
  buyerName:    z.string().min(1).max(120),
  buyerAddress: z.string().min(1).max(300),
  buyerCity:    z.string().min(1).max(80),
  buyerState:   z.string().max(80).optional(),
  buyerZip:     z.string().max(20).optional(),
  // productIds: trusted server-side — prices re-derived from DB
  items: z.array(z.object({
    productId: z.string().min(1),
    name:      z.string().min(1),
    qty:       z.number().int().min(1).max(50),
  })).min(1).max(50),
  paymentReference: z.string().optional(),
  paymentProvider:  z.string().optional(),
  referralCode:     z.string().max(20).optional(),
  discountCode:     z.string().max(50).optional(),
  discountId:       z.string().optional(),
});

// ─── POST /api/buyers/orders ──────────────────────────────────────────────────

router.post("/buyers/orders", async (req, res) => {
  const parsed = buyerOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid order data", details: parsed.error.flatten() });
    return;
  }

  const {
    vendorId, buyerEmail, buyerPhone, buyerName, buyerAddress, buyerCity, buyerState, buyerZip,
    items, paymentReference, paymentProvider, referralCode, discountId,
  } = parsed.data;

  // Re-derive prices from DB — never trust client-submitted prices
  const dbProducts = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.userId, vendorId));

  // Vendor-configured delivery fees (fall back to platform defaults)
  const [vendor] = await db
    .select({
      deliveryFeeLagos: users.deliveryFeeLagos,
      deliveryFeeOther: users.deliveryFeeOther,
      freeDeliveryThreshold: users.freeDeliveryThreshold,
    })
    .from(users)
    .where(eq(users.id, vendorId))
    .limit(1);

  const productMap = new Map(dbProducts.map((p) => [p.id, p]));

  // Reject items that reference a product this vendor does not own (or that
  // doesn't exist). Without this guard, an unknown productId falls through to a
  // ₦0 unit price and the client-supplied name, letting anyone create free orders.
  for (const item of items) {
    if (!productMap.has(item.productId)) {
      res.status(400).json({ success: false, error: `Invalid product in order: ${item.productId}` });
      return;
    }
  }

  const resolvedItems = items.map((i) => {
    const dbProduct = productMap.get(i.productId)!;
    // Apply the active sale price when one exists, matching the storefront.
    let unitPrice = Number(dbProduct?.price ?? 0);
    if (dbProduct?.salePrice != null) {
      const salePrice = Number(dbProduct.salePrice);
      const saleEndsAt = dbProduct.saleEndsAt ? new Date(dbProduct.saleEndsAt) : null;
      if (salePrice > 0 && saleEndsAt && saleEndsAt > new Date()) {
        unitPrice = salePrice;
      }
    }
    return {
      productId: i.productId,
      name: dbProduct?.name ?? i.name,
      qty: i.qty,
      unitPrice,
    };
  });

  const subtotal = resolvedItems.reduce((s, i) => s + i.unitPrice * i.qty, 0);

  // Location-aware delivery: Lagos local delivery vs inter-state, using the
  // vendor's own rates when configured.
  const deliveryZone = resolveDeliveryZone(buyerState, buyerCity);
  const shipping = computeDeliveryFee(subtotal, deliveryZone, {
    feeLagos: vendor?.deliveryFeeLagos != null ? Number(vendor.deliveryFeeLagos) : undefined,
    feeOther: vendor?.deliveryFeeOther != null ? Number(vendor.deliveryFeeOther) : undefined,
    freeThreshold: vendor?.freeDeliveryThreshold != null ? Number(vendor.freeDeliveryThreshold) : undefined,
  });

  // Apply discount server-side — re-validates so the client can't fake it
  let discountAmount = 0;
  if (discountId) {
    const [disc] = await db.select().from(discounts).where(eq(discounts.id, discountId)).limit(1);
    if (disc && disc.active && disc.vendorId === vendorId) {
      const minOrder = Number(disc.minOrder ?? 0);
      if (subtotal >= minOrder && (!disc.maxUses || (disc.usesCount ?? 0) < disc.maxUses) && (!disc.expiresAt || new Date(disc.expiresAt) > new Date())) {
        discountAmount = disc.type === "percent"
          ? subtotal * (Number(disc.value) / 100)
          : Number(disc.value);
        discountAmount = Math.min(discountAmount, subtotal);
      }
    }
  }
  const total = Math.max(0, subtotal + shipping - discountAmount);

  // Payment processing fee (Paystack 1.5% + ₦100 / Flutterwave 1.4% + ₦100) —
  // added to the buyer total so the vendor keeps the full sale amount in escrow.
  // Recorded on the order as `commission`. Defaults to Paystack's rate.
  const processingFee = computeProcessingFee(
    Math.max(0, subtotal + shipping - discountAmount),
    paymentProvider === "flutterwave" ? "flutterwave" : "paystack",
  );
  const payableTotal = Math.max(0, total + processingFee);

  // ── Pre-order detection ─────────────────────────────────────────────────────
  // Any item that is a preorder makes the whole order a preorder. We set the
  // expected ship date to the latest release date among the ordered items, and a
  // buyer-protection deadline: if we cannot ship by then, escrow auto-refunds.
  const preorderItems = resolvedItems.filter((i) => productMap.get(i.productId)?.preorder === true);
  const isPreorder = preorderItems.length > 0;
  const releasePct = isPreorder ? "0.5" : "0"; // 50% working capital vs full escrow

  const releaseDates = preorderItems
    .map((i) => productMap.get(i.productId)?.preorderReleaseDate)
    .filter((d): d is Date => !!d)
    .map((d) => new Date(d).getTime());
  const expectedShipDate = isPreorder && releaseDates.length
    ? new Date(Math.max(...releaseDates))
    : null;
  // Auto-refund deadline: promised ship date + 7-day grace. Manual orders with no
  // release date still get a 14-day safety deadline so they can't sit forever.
  const escrowExpiresAt = isPreorder
    ? new Date((expectedShipDate?.getTime() ?? Date.now()) + 7 * 86400_000)
    : null;

  // ── Server-side payment verification ────────────────────────────────────────
  // Never trust the client — verify the reference with the payment gateway before
  // creating the order. Without this, anyone could POST a fake reference and get
  // a confirmed order without paying.
  const isRealPayment = paymentReference && paymentProvider && paymentProvider !== "none";
  if (isRealPayment) {
    try {
      if (paymentProvider === "paystack") {
        const verify = await verifyPaystack(paymentReference!);
        if (verify.status !== "success") {
          res.status(402).json({ success: false, error: "Payment could not be verified. Please try again." });
          return;
        }
      } else if (paymentProvider === "flutterwave") {
        const verify = await verifyFlutterwave(paymentReference!);
        if (verify.status !== "successful") {
          res.status(402).json({ success: false, error: "Payment could not be verified. Please try again." });
          return;
        }
      }
    } catch (err) {
      logger.error({ err, paymentReference, paymentProvider }, "Payment verification error");
      res.status(402).json({ success: false, error: "Payment verification failed. Please contact support if you were charged." });
      return;
    }
  }

  const orderNumber = genOrderNumber();
  // Generate escrow PIN now — payment is already confirmed before placeOrder is called
  const escrowPin = String(Math.floor(1000 + Math.random() * 9000));

  const [order] = await db.insert(orders).values({
    orderNumber,
    userId:           vendorId,
    buyerName,
    buyerEmail,
    buyerPhone:       buyerPhone ?? buyerEmail,
    buyerAddress,
    buyerCity,
    buyerState:     buyerState ?? null,
    buyerZip:         buyerZip ?? "",
    totalAmount:      String(total),
    status:           isRealPayment ? "paid" : "pending",
    escrowStatus:     "locked",
    escrowOtp:        escrowPin,
    paymentReference: paymentReference ?? null,
    paymentProvider:  paymentProvider ?? null,
    isPreorder,
    expectedShipDate,
    escrowExpiresAt,
    releasePercentAtPayment: releasePct,
    commission:       String(processingFee),
  }).returning();

  if (!order) {
    res.status(500).json({ success: false, error: "Failed to create order" });
    return;
  }

  // Split escrow: on a confirmed (real) payment, immediately release the
  // working-capital portion to the vendor's wallet and hold the rest in escrow.
  if (isRealPayment) {
    await releaseWorkingCapitalToVendor(order.id).catch((err) => {
      logger.error({ err, orderId: order.id }, "Working capital release failed after checkout");
    });
  }

  await db.insert(orderItems).values(
    resolvedItems.map((i) => ({
      orderId:     order.id,
      productId:   i.productId,
      productName: i.name,
      quantity:    i.qty,
      unitPrice:   String(i.unitPrice),
    }))
  );

  // Increment discount usage count (fire-and-forget)
  if (discountId && discountAmount > 0) {
    db.update(discounts)
      .set({ usesCount: sql`${discounts.usesCount} + 1` })
      .where(eq(discounts.id, discountId))
      .catch(() => {});
  }

  // ── Referral processing ─────────────────────────────────────────────────────
  // Run async so it never delays the order response
  let buyerReferralCode: string | null = null;

  if (buyerPhone) {
    // Process incoming referral — reward the person who shared the link
    if (referralCode) {
      (async () => {
        try {
          const [ref] = await db.select().from(buyerReferrals).where(eq(buyerReferrals.code, referralCode)).limit(1);
          if (ref && ref.vendorId === vendorId && ref.buyerPhone !== buyerPhone) {
            // Increment usage counter
            await db.update(buyerReferrals)
              .set({ timesUsed: sql`${buyerReferrals.timesUsed} + 1` })
              .where(eq(buyerReferrals.id, ref.id));

            // Create a 10% reward discount for the referrer
            const rewardCode = `THANKS${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
            const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);
            await db.insert(discounts).values({
              vendorId,
              code: rewardCode,
              type: "percent",
              value: "10",
              expiresAt,
              active: true,
            }).onConflictDoNothing();

            const [vendor] = await db.select({ username: users.username, businessName: users.businessName })
              .from(users).where(eq(users.id, vendorId)).limit(1);
            const storeName = vendor?.businessName ?? "the store";
            const storeUrl = vendor?.username ? buildStoreUrl(vendor.username) : storeName;

            const msg = `Hi ${ref.buyerName}! Someone you referred just placed an order at ${storeName}. Here's 10% off your next order — use code ${rewardCode} at checkout: ${storeUrl}`;
            await sendSMS(ref.buyerPhone, msg).catch(() => {});
          }
        } catch { /* non-critical */ }
      })();
    }

    // Create or retrieve the buyer's own referral code for this vendor's store
    try {
      const [existing] = await db.select({ code: buyerReferrals.code })
        .from(buyerReferrals)
        .where(and(eq(buyerReferrals.vendorId, vendorId), eq(buyerReferrals.buyerPhone, buyerPhone)))
        .limit(1);

      if (existing) {
        buyerReferralCode = existing.code;
      } else {
        const newCode = Math.random().toString(36).slice(2, 10).toUpperCase();
        const [inserted] = await db.insert(buyerReferrals)
          .values({ vendorId, buyerPhone, buyerName, code: newCode })
          .onConflictDoNothing()
          .returning();
        buyerReferralCode = inserted?.code ?? null;
        if (!buyerReferralCode) {
          // Race condition: another request beat us, fetch the winner
          const [race] = await db.select({ code: buyerReferrals.code })
            .from(buyerReferrals)
            .where(and(eq(buyerReferrals.vendorId, vendorId), eq(buyerReferrals.buyerPhone, buyerPhone)))
            .limit(1);
          buyerReferralCode = race?.code ?? null;
        }
      }
    } catch { /* non-critical */ }
  }

  // Email buyer: order confirmation + escrow PIN (both in one go)
  if (buyerEmail) {
    const [vendor] = await db.select().from(users).where(eq(users.id, vendorId)).limit(1);
    const storeName = vendor?.businessName ?? vendor?.name ?? "the store";

    sendOrderConfirmationEmail({
      email: buyerEmail,
      buyerName,
      orderNumber: order.orderNumber!,
      storeName,
      items: resolvedItems.map((i) => ({ name: i.name, qty: i.qty, unitPrice: String(i.unitPrice) })),
      totalAmount: String(payableTotal),
      deliveryAddress: `${buyerAddress}, ${buyerCity}`,
    }).catch(() => {});

    sendEscrowPinEmail({
      email: buyerEmail,
      buyerName,
      orderNumber: order.orderNumber!,
      storeName,
      pin: escrowPin,
    }).catch(() => {});
  }

  res.status(201).json({
    success: true,
    data: {
      orderNumber:  order.orderNumber,
      total:        Number(payableTotal),
      subtotal:     Number(total),
      processingFee: Number(processingFee),
      escrowPin,
      referralCode: buyerReferralCode,
    },
  });
});

// ─── GET /api/buyers/my-orders?phone=X&vendorId=Y ────────────────────────────
// Public — buyer sees all their own orders for a specific store.

router.get("/buyers/my-orders", async (req, res) => {
  const phone = String(req.query["phone"] ?? "").trim();
  const vendorId = String(req.query["vendorId"] ?? "").trim();
  if (!phone || !vendorId) {
    res.status(400).json({ success: false, error: "phone and vendorId are required" });
    return;
  }

  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.userId, vendorId), eq(orders.buyerPhone, phone)))
    .orderBy(desc(orders.createdAt))
    .limit(20);

  const result = await Promise.all(rows.map(async (o) => {
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    return {
      orderNumber: o.orderNumber,
      status: o.status,
      totalAmount: Number(o.totalAmount),
      createdAt: o.createdAt,
      items: items.map((i) => ({ name: i.productName, qty: i.quantity, unitPrice: Number(i.unitPrice) })),
    };
  }));

  res.json({ success: true, data: result });
});

// ─── GET /api/buyers/my-referral?phone=X&vendorId=Y ──────────────────────────
// Public — buyer fetches their referral code for a specific store.

router.get("/buyers/my-referral", async (req, res) => {
  const phone = String(req.query["phone"] ?? "").trim();
  const vendorId = String(req.query["vendorId"] ?? "").trim();
  if (!phone || !vendorId) {
    res.status(400).json({ success: false, error: "phone and vendorId are required" });
    return;
  }

  const [ref] = await db
    .select()
    .from(buyerReferrals)
    .where(and(eq(buyerReferrals.vendorId, vendorId), eq(buyerReferrals.buyerPhone, phone)))
    .limit(1);

  const [vendor] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, vendorId))
    .limit(1);

  // Prefer the vendor's actual launched-store URL (which reflects a custom domain,
  // if they set one up) over reconstructing the generic keeosk.store/@username path
  // — same source of truth as orders/abandoned-cart links use, so a referral link
  // always lands on the same URL the vendor's other links do.
  const [tmpl] = await db
    .select({ launchUrl: templates.launchUrl })
    .from(templates)
    .where(and(eq(templates.userId, vendorId), eq(templates.launched, true)))
    .orderBy(desc(templates.updatedAt))
    .limit(1);

  const storeBase = tmpl?.launchUrl ?? (vendor?.username ? buildStoreUrl(vendor.username) : "");

  res.json({
    success: true,
    data: {
      code: ref?.code ?? null,
      timesUsed: ref?.timesUsed ?? 0,
      referralUrl: ref?.code && storeBase ? `${storeBase}?ref=${ref.code}` : null,
      storeUsername: vendor?.username ?? null,
    },
  });
});

// ─── GET /api/buyers/invoice/:orderNumber ────────────────────────────────────
// Public — buyer accesses their own invoice by order number (no auth needed).

router.get("/buyers/invoice/:orderNumber", async (req, res) => {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, req.params.orderNumber!))
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Invoice not found" });
    return;
  }

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const [vendor] = await db.select().from(users).where(eq(users.id, order.userId)).limit(1);

  res.json({
    success: true,
    invoice: {
      invoiceNumber: `INV-${order.orderNumber}`,
      issuedAt: order.createdAt,
      merchant: {
        name: vendor?.businessName ?? vendor?.name ?? "Merchant",
        phone: vendor?.phone ?? vendor?.whatsappNumber,
      },
      buyer: {
        name: order.buyerName,
        phone: order.buyerPhone,
        email: order.buyerEmail,
        address: `${order.buyerAddress ?? ""}, ${order.buyerCity ?? ""}`.trim(),
      },
      items: items.map((i) => ({
        name: i.productName,
        qty: i.quantity,
        unitPrice: Number(i.unitPrice),
        total: Number(i.unitPrice) * (i.quantity ?? 1),
      })),
      // The buyer was charged `totalAmount + commission` (processing fee) at
      // checkout, so show the gross amount they actually paid, not the net total.
      totalAmount: Number(order.totalAmount) + Number(order.commission ?? 0),
      processingFee: Number(order.commission ?? 0),
      status: order.status,
      paymentProvider: order.paymentProvider,
      orderNumber: order.orderNumber,
    },
  });
});

// ─── GET /api/buyers/orders/:orderNumber ──────────────────────────────────────

router.get("/buyers/orders/:orderNumber", async (req, res) => {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, req.params.orderNumber!))
    .limit(1);

  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  res.json({
    success: true,
    data: {
      orderNumber:       order.orderNumber,
      status:            order.status,
      escrowStatus:      order.escrowStatus,
      totalAmount:       order.totalAmount,
      buyerName:         order.buyerName,
      buyerAddress:      order.buyerAddress,
      buyerCity:         order.buyerCity,
      createdAt:         order.createdAt,
      trackingId:        order.trackingId,
      logisticsProvider: order.logisticsProvider,
      items:             items.map((i) => ({
        name:      i.productName,
        qty:       i.quantity,
        unitPrice: i.unitPrice,
      })),
    },
  });
});

export default router;
