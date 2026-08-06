/**
 * Analytics routes — business intelligence for the merchant dashboard.
 *
 * GET /api/analytics          — full dashboard snapshot
 * GET /api/analytics/revenue  — revenue breakdown by period
 * GET /api/analytics/products — product performance (best/worst sellers)
 * GET /api/analytics/customers — customer segmentation summary
 */

import { Router } from "express";
import { db, orders, orderItems, products } from "../db/index.js";
import { eq, sql, and, gte, lt, ne } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();
router.use(requireAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOf(unit: "day" | "week" | "month" | "year"): Date {
  const now = new Date();
  if (unit === "day") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (unit === "week") {
    const day = now.getDay(); // 0=Sun
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
    return new Date(now.getFullYear(), now.getMonth(), diff);
  }
  if (unit === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return new Date(now.getFullYear(), 0, 1);
}

function prevPeriodStart(unit: "day" | "week" | "month" | "year"): Date {
  const s = startOf(unit);
  if (unit === "day") return new Date(s.getTime() - 86400000);
  if (unit === "week") return new Date(s.getTime() - 7 * 86400000);
  if (unit === "month") return new Date(s.getFullYear(), s.getMonth() - 1, 1);
  return new Date(s.getFullYear() - 1, 0, 1);
}

function pct(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100 * 10) / 10;
}

// ─── GET /api/analytics ───────────────────────────────────────────────────────

router.get("/analytics", async (req, res) => {
  const userId = req.user!.userId;

  // ── Revenue per period ────────────────────────────────────────────────────
  const revenueByPeriod = async (from: Date, to?: Date) => {
    const conditions = [
      eq(orders.userId, userId),
      ne(orders.status, "cancelled"),
      gte(orders.createdAt, from),
    ];
    if (to) conditions.push(lt(orders.createdAt, to));
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${orders.totalAmount}::numeric), 0)::text` })
      .from(orders)
      .where(and(...conditions));
    return parseFloat(rows[0]?.total ?? "0");
  };

  const [todayRev, yestRev, weekRev, prevWeekRev, monthRev, prevMonthRev, yearRev, prevYearRev] =
    await Promise.all([
      revenueByPeriod(startOf("day")),
      revenueByPeriod(prevPeriodStart("day"), startOf("day")),
      revenueByPeriod(startOf("week")),
      revenueByPeriod(prevPeriodStart("week"), startOf("week")),
      revenueByPeriod(startOf("month")),
      revenueByPeriod(prevPeriodStart("month"), startOf("month")),
      revenueByPeriod(startOf("year")),
      revenueByPeriod(prevPeriodStart("year"), startOf("year")),
    ]);

  // ── Order status counts ───────────────────────────────────────────────────
  const statusRows = await db
    .select({
      status: orders.status,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .groupBy(orders.status);

  const statusMap: Record<string, number> = {};
  for (const r of statusRows) statusMap[r.status ?? "pending"] = r.count;

  const totalOrders = Object.values(statusMap).reduce((a, b) => a + b, 0);

  // ── Average order value ───────────────────────────────────────────────────
  const avgRow = await db
    .select({ avg: sql<string>`coalesce(avg(${orders.totalAmount}::numeric), 0)::text` })
    .from(orders)
    .where(and(eq(orders.userId, userId), ne(orders.status, "cancelled")));
  const avgOrderValue = Math.round(parseFloat(avgRow[0]?.avg ?? "0"));

  // ── Product performance ───────────────────────────────────────────────────
  const productPerf = await db
    .select({
      productId:   orderItems.productId,
      productName: orderItems.productName,
      unitsSold:   sql<number>`sum(${orderItems.quantity})::int`,
      revenue:     sql<string>`sum(${orderItems.quantity} * ${orderItems.unitPrice}::numeric)::text`,
      orderCount:  sql<number>`count(distinct ${orderItems.orderId})::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(eq(orders.userId, userId), ne(orders.status, "cancelled")))
    .groupBy(orderItems.productId, orderItems.productName)
    .orderBy(sql`sum(${orderItems.quantity}) desc`);

  const bestSellers = productPerf.slice(0, 5).map((p) => ({
    productId: p.productId,
    name: p.productName,
    unitsSold: p.unitsSold,
    revenue: Math.round(parseFloat(p.revenue)),
    orderCount: p.orderCount,
  }));
  const worstPerformers = [...productPerf].reverse().slice(0, 5).map((p) => ({
    productId: p.productId,
    name: p.productName,
    unitsSold: p.unitsSold,
    revenue: Math.round(parseFloat(p.revenue)),
    orderCount: p.orderCount,
  }));

  // ── Inventory health ──────────────────────────────────────────────────────
  const allProducts = await db
    .select({ id: products.id, name: products.name, stock: products.stock, category: products.category, active: products.active })
    .from(products)
    .where(eq(products.userId, userId));

  const LOW_STOCK_THRESHOLD = 5;
  const lowStock = allProducts
    .filter((p) => p.active && p.stock !== null && p.stock > 0 && p.stock <= LOW_STOCK_THRESHOLD)
    .map((p) => ({ id: p.id, name: p.name, stock: p.stock, category: p.category }));
  const outOfStock = allProducts
    .filter((p) => p.active && (p.stock === null || p.stock === 0))
    .map((p) => ({ id: p.id, name: p.name, category: p.category }));

  // Days until depletion — uses 30-day sales velocity
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
  const velocity = await db
    .select({
      productId: orderItems.productId,
      unitsSold: sql<number>`sum(${orderItems.quantity})::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(eq(orders.userId, userId), gte(orders.createdAt, thirtyDaysAgo), ne(orders.status, "cancelled")))
    .groupBy(orderItems.productId);

  const velocityMap: Record<string, number> = {};
  for (const v of velocity) {
    if (v.productId) velocityMap[v.productId] = v.unitsSold;
  }

  const fastMoving = allProducts
    .filter((p) => p.active && p.stock && p.stock > 0 && velocityMap[p.id] && velocityMap[p.id] >= 5)
    .map((p) => {
      const dailyRate = (velocityMap[p.id] ?? 0) / 30;
      const daysLeft = dailyRate > 0 ? Math.round((p.stock ?? 0) / dailyRate) : null;
      return { id: p.id, name: p.name, stock: p.stock, unitsSold30d: velocityMap[p.id] ?? 0, daysUntilDepletion: daysLeft };
    })
    .sort((a, b) => (a.daysUntilDepletion ?? 999) - (b.daysUntilDepletion ?? 999))
    .slice(0, 5);

  const slowMoving = allProducts
    .filter((p) => p.active && p.stock && p.stock > 0 && (velocityMap[p.id] ?? 0) === 0)
    .map((p) => ({ id: p.id, name: p.name, stock: p.stock, unitsSold30d: 0 }))
    .slice(0, 5);

  // ── Customer segmentation ─────────────────────────────────────────────────
  const customerRows = await db
    .select({
      buyerPhone:  orders.buyerPhone,
      buyerName:   orders.buyerName,
      totalOrders: sql<number>`count(*)::int`,
      totalSpent:  sql<string>`sum(${orders.totalAmount}::numeric)::text`,
      firstOrder:  sql<string>`min(${orders.createdAt})::text`,
      lastOrder:   sql<string>`max(${orders.createdAt})::text`,
    })
    .from(orders)
    .where(and(eq(orders.userId, userId), ne(orders.status, "cancelled")))
    .groupBy(orders.buyerPhone, orders.buyerName);

  const VIP_THRESHOLD = 50000;
  const INACTIVE_DAYS = 60;
  const now = Date.now();

  const segmented = customerRows.map((c) => {
    const spent = parseFloat(c.totalSpent ?? "0");
    const lastMs = c.lastOrder ? new Date(c.lastOrder).getTime() : 0;
    const daysSinceLast = (now - lastMs) / 86400000;
    let segment: "new" | "returning" | "vip" | "inactive" = "new";
    if (c.totalOrders >= 2 && spent >= VIP_THRESHOLD) segment = "vip";
    else if (daysSinceLast > INACTIVE_DAYS) segment = "inactive";
    else if (c.totalOrders >= 2) segment = "returning";
    return { ...c, spent, segment, daysSinceLast: Math.round(daysSinceLast) };
  });

  const segmentCounts = { new: 0, returning: 0, vip: 0, inactive: 0 };
  for (const c of segmented) segmentCounts[c.segment]++;

  const topBySpend = [...segmented]
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 5)
    .map((c) => ({ name: c.buyerName, phone: c.buyerPhone, spent: Math.round(c.spent), orders: c.totalOrders, segment: c.segment }));

  const topByOrders = [...segmented]
    .sort((a, b) => b.totalOrders - a.totalOrders)
    .slice(0, 5)
    .map((c) => ({ name: c.buyerName, phone: c.buyerPhone, orders: c.totalOrders, spent: Math.round(c.spent), segment: c.segment }));

  res.json({
    success: true,
    data: {
      revenue: {
        today: Math.round(todayRev),
        week: Math.round(weekRev),
        month: Math.round(monthRev),
        year: Math.round(yearRev),
        todayChange: pct(todayRev, yestRev),
        weekChange: pct(weekRev, prevWeekRev),
        monthChange: pct(monthRev, prevMonthRev),
        yearChange: pct(yearRev, prevYearRev),
      },
      orders: {
        total: totalOrders,
        paid: statusMap["paid"] ?? 0,
        pending: statusMap["pending"] ?? 0,
        shipped: statusMap["shipped"] ?? 0,
        delivered: statusMap["delivered"] ?? 0,
        cancelled: statusMap["cancelled"] ?? 0,
        avgOrderValue,
      },
      products: {
        bestSellers,
        worstPerformers,
        fastMoving,
        slowMoving,
      },
      inventory: {
        total: allProducts.length,
        lowStock,
        outOfStock,
        lowStockCount: lowStock.length,
        outOfStockCount: outOfStock.length,
      },
      customers: {
        total: segmented.length,
        ...segmentCounts,
        topBySpend,
        topByOrders,
      },
    },
  });
});

export default router;
