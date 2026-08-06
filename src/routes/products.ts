/**
 * Products routes — merchant product catalogue.
 *
 * All routes require authentication (merchant can only manage their own products).
 *
 * GET    /api/products           — list the merchant's products
 * POST   /api/products           — create a new product
 * PATCH  /api/products/:id       — update a product (name, price, stock, etc.)
 * DELETE /api/products/:id       — soft-delete (sets active = false)
 */

import { db, products, restockAlerts } from "../db/index.js";
import { sendSMS } from "../lib/termii.js";
import { and, eq, desc, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

// All product routes require a logged-in merchant
router.use(requireAuth);

// ─── GET /api/products ────────────────────────────────────────────────────────

router.get("/products", async (req, res) => {
  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.userId, req.user!.userId),
        eq(products.active, true)
      )
    )
    .orderBy(desc(products.createdAt));

  res.json({ success: true, data: rows });
});

// ─── POST /api/products ───────────────────────────────────────────────────────

const createProductSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  description: z.string().optional(),
  price: z.number().positive("Price must be greater than 0"),
  imageUrl: z.string().optional(),
  images: z.array(z.string()).max(4).optional(),
  category: z.string().optional(),
  stock: z.number().int().min(0).default(0),
  // Default = full escrow until delivery PIN. Preorder = split escrow (50% working capital).
  preorder: z.boolean().optional().default(false),
  preorderReleaseDate: z.coerce.date().nullable().optional(),
});

router.post("/products", async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  if (parsed.data.preorder && !parsed.data.preorderReleaseDate) {
    res.status(400).json({ success: false, error: "A release date is required for pre-orders" });
    return;
  }

  // Pre-check duplicates for a friendly message (the partial unique index
  // `uq_product_vendor_name_active` is the real guarantee).
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.userId, req.user!.userId),
        eq(products.active, true),
        sql`lower(${products.name}) = lower(${parsed.data.name})`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ success: false, error: "A product with this name already exists in your inventory" });
    return;
  }

  const [product] = await db
    .insert(products)
    .values({
      userId: req.user!.userId,
      ...parsed.data,
      price: String(parsed.data.price),  // Drizzle decimal fields take strings
    })
    .returning();

  req.log.info({ productId: product!.id }, "Product created");
  res.status(201).json({ success: true, data: product });
});

// ─── PATCH /api/products/:id ──────────────────────────────────────────────────

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  price: z.number().positive().optional(),
  imageUrl: z.string().optional(),
  images: z.array(z.string()).max(4).optional(),
  category: z.string().optional(),
  stock: z.number().int().min(0).optional(),
  preorder: z.boolean().optional(),
  preorderReleaseDate: z.coerce.date().nullable().optional(),
});

router.patch("/products/:id", async (req, res) => {
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  if (parsed.data.preorder === true && parsed.data.preorderReleaseDate == null) {
    res.status(400).json({ success: false, error: "A release date is required for pre-orders" });
    return;
  }

  // Only allow updating products that belong to the current merchant
  const [existing] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, req.params.id!),
        eq(products.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!existing) {
    res.status(404).json({ success: false, error: "Product not found" });
    return;
  }

  const updates: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  if (parsed.data.price !== undefined) {
    updates.price = String(parsed.data.price);
  }

  // Renaming to a name that collides with another active product → reject.
  if (parsed.data.name) {
    const clash = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.userId, req.user!.userId),
          eq(products.active, true),
          ne(products.id, req.params.id!),
          sql`lower(${products.name}) = lower(${parsed.data.name})`,
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      res.status(409).json({ success: false, error: "A product with this name already exists in your inventory" });
      return;
    }
  }

  const wasOutOfStock = (existing.stock ?? 0) === 0;
  const nowInStock = parsed.data.stock !== undefined && parsed.data.stock > 0;

  const [updated] = await db
    .update(products)
    .set(updates)
    .where(eq(products.id, req.params.id!))
    .returning();

  // Fire restock alerts when stock goes from 0 → positive
  if (wasOutOfStock && nowInStock) {
    db.select({ customerPhone: restockAlerts.customerPhone })
      .from(restockAlerts)
      .where(eq(restockAlerts.productId, existing.id))
      .then(async (subscribers) => {
        for (const { customerPhone } of subscribers) {
          await sendSMS(customerPhone, `Good news! "${existing.name}" is back in stock. Order now before it sells out again.`).catch(() => null);
        }
        if (subscribers.length > 0) {
          await db.delete(restockAlerts).where(eq(restockAlerts.productId, existing.id));
        }
      }).catch(() => null);
  }

  res.json({ success: true, data: updated });
});

// ─── PATCH /api/products/:id/flash-sale — set or update a flash sale ─────────

router.patch("/products/:id/flash-sale", async (req, res) => {
  const { salePrice, saleEndsAt } = req.body as { salePrice?: number; saleEndsAt?: string };
  if (!salePrice || salePrice <= 0 || !saleEndsAt) {
    res.status(400).json({ success: false, error: "salePrice and saleEndsAt are required" });
    return;
  }

  const [existing] = await db.select({ id: products.id, price: products.price })
    .from(products)
    .where(and(eq(products.id, req.params.id!), eq(products.userId, req.user!.userId)))
    .limit(1);

  if (!existing) { res.status(404).json({ success: false, error: "Product not found" }); return; }

  const [updated] = await db.update(products)
    .set({ salePrice: String(salePrice), saleEndsAt: new Date(saleEndsAt), updatedAt: new Date() })
    .where(eq(products.id, req.params.id!))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── DELETE /api/products/:id/flash-sale — end a flash sale ──────────────────

router.delete("/products/:id/flash-sale", async (req, res) => {
  const [existing] = await db.select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, req.params.id!), eq(products.userId, req.user!.userId)))
    .limit(1);

  if (!existing) { res.status(404).json({ success: false, error: "Product not found" }); return; }

  const [updated] = await db.update(products)
    .set({ salePrice: null, saleEndsAt: null, updatedAt: new Date() })
    .where(eq(products.id, req.params.id!))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── POST /api/store/:username/products/:productId/restock-alert (public) ─────

router.post("/store/:username/products/:productId/restock-alert", async (req, res) => {
  const { customerPhone } = req.body as { customerPhone?: string };
  const { productId } = req.params as { productId: string; username: string };

  if (!customerPhone || customerPhone.length < 10) {
    res.status(400).json({ success: false, error: "A valid phone number is required" });
    return;
  }

  const [prod] = await db.select({ userId: products.userId })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!prod) { res.status(404).json({ success: false, error: "Product not found" }); return; }

  try {
    await db.insert(restockAlerts).values({
      productId,
      vendorId: prod.userId,
      customerPhone,
    });
  } catch {
    // unique constraint = already subscribed
  }

  res.json({ success: true, message: "You will be notified when this product is back in stock." });
});

// ─── DELETE /api/products/:id — soft delete ───────────────────────────────────

router.delete("/products/:id", async (req, res) => {
  const [existing] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, req.params.id!),
        eq(products.userId, req.user!.userId)
      )
    )
    .limit(1);

  if (!existing) {
    res.status(404).json({ success: false, error: "Product not found" });
    return;
  }

  // Soft delete: keep the record for historical order references
  await db
    .update(products)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(products.id, req.params.id!));

  res.json({ success: true, message: "Product deleted" });
});

export default router;
