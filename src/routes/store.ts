/**
 * Public store routes — no auth required.
 *
 * GET /api/store/:username — fetch a vendor's active (launched) template JSON
 *   Returns: { success: true, templateJson: string, storeName: string }
 */

import { db, templates, users, products, contactMessages } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { Router } from "express";
import { sendContactNotificationEmail } from "../lib/email.js";
import { injectWhatsAppNumber } from "../lib/storeTemplate.js";

const router = Router();

// GET /api/store/sitemap — all launched store URLs (used for sitemap.xml)
router.get("/store/sitemap", async (_req, res) => {
  const rows = await db
    .select({ username: users.username, launchUrl: templates.launchUrl, updatedAt: templates.updatedAt })
    .from(templates)
    .innerJoin(users, eq(templates.userId, users.id))
    .where(eq(templates.launched, true));

  res.json({ success: true, stores: rows.map((r) => ({ username: r.username, url: r.launchUrl, updatedAt: r.updatedAt })) });
});

// GET /api/store/:username/feed.xml — Google Merchant Center / Shopping feed
router.get("/store/:username/feed.xml", async (req, res) => {
  const { username } = req.params as { username: string };

  const [user] = await db
    .select({ id: users.id, name: users.name, businessName: users.businessName })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user) { res.status(404).end(); return; }

  const [tmpl] = await db
    .select({ launchUrl: templates.launchUrl })
    .from(templates)
    .where(and(eq(templates.userId, user.id), eq(templates.launched, true)))
    .limit(1);

  const prods = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      price: products.price,
      imageUrl: products.imageUrl,
      category: products.category,
      stock: products.stock,
    })
    .from(products)
    .where(and(eq(products.userId, user.id), eq(products.active, true)))
    .limit(200);

  const storeUrl = tmpl?.launchUrl ?? `https://keeosk.store/@${username}`;
  const storeName = user.businessName ?? user.name ?? username;
  const now = new Date().toUTCString();

  function esc(str: string) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const items = prods.map((p) => {
    const productUrl = `${storeUrl}/product/${p.id}`;
    const price = parseFloat(String(p.price)).toFixed(2);
    const avail = (p.stock ?? 1) > 0 ? "in stock" : "out of stock";
    return `
    <item>
      <g:id>${p.id}</g:id>
      <title>${esc(p.name)}</title>
      <description>${esc(p.description ?? p.name)}</description>
      <link>${productUrl}</link>
      <g:price>${price} NGN</g:price>
      <g:availability>${avail}</g:availability>
      <g:condition>new</g:condition>
      ${p.imageUrl ? `<g:image_link>${esc(p.imageUrl)}</g:image_link>` : ""}
      ${p.category ? `<g:product_type>${esc(p.category)}</g:product_type>` : ""}
      <g:brand>${esc(storeName)}</g:brand>
    </item>`;
  }).join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${esc(storeName)}</title>
    <link>${storeUrl}</link>
    <description>Products from ${esc(storeName)}</description>
    <lastBuildDate>${now}</lastBuildDate>
    ${items}
  </channel>
</rss>`;

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.send(xml);
});

// GET /api/store/by-domain?domain=shop.mybrand.com — look up a vendor store by custom domain
router.get("/store/by-domain", async (req, res) => {
  const domain = ((req.query as Record<string, string>)["domain"] ?? "").trim().toLowerCase();
  if (!domain) {
    res.status(400).json({ success: false, error: "domain query param required" });
    return;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.customDomain, domain))
    .limit(1);

  if (!user) {
    res.status(404).json({ success: false, error: "No store found for this domain" });
    return;
  }

  const [tmpl] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.userId, user.id), eq(templates.launched, true)))
    .limit(1);

  if (!tmpl) {
    res.status(404).json({ success: false, error: "This store has no active storefront" });
    return;
  }

  const settings = (tmpl.settings ?? {}) as Record<string, unknown>;
  const templateJson = settings["templateJson"] as string | undefined;

  if (!templateJson) {
    res.status(404).json({ success: false, error: "Storefront not published yet" });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.json({
    success: true,
    templateJson: injectWhatsAppNumber(templateJson, user.whatsappNumber ?? ""),
    storeName: user.businessName ?? user.name ?? domain,
    launchUrl: tmpl.launchUrl ?? `https://${domain}`,
    vendorId: user.id,
    deliveryFees: {
      lagos: user.deliveryFeeLagos != null ? Number(user.deliveryFeeLagos) : 1500,
      other: user.deliveryFeeOther != null ? Number(user.deliveryFeeOther) : 3500,
      freeThreshold: user.freeDeliveryThreshold != null ? Number(user.freeDeliveryThreshold) : 15000,
    },
  });
});

router.get("/store/:username", async (req, res) => {
  const { username } = req.params as { username: string };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user) {
    res.status(404).json({ success: false, error: "Store not found" });
    return;
  }

  const [tmpl] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.userId, user.id), eq(templates.launched, true)))
    .limit(1);

  if (!tmpl) {
    res.status(404).json({ success: false, error: "This store has no active storefront" });
    return;
  }

  // Store is live but owner has temporarily paused it — signal maintenance page
  if (tmpl.storePaused) {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      success: true,
      paused: true,
      storeName: user.businessName ?? user.name ?? username,
      launchUrl: tmpl.launchUrl,
    });
    return;
  }

  const settings = (tmpl.settings ?? {}) as Record<string, unknown>;
  const templateJson = settings["templateJson"] as string | undefined;

  if (!templateJson) {
    res.status(404).json({ success: false, error: "Storefront not published yet" });
    return;
  }

  // Cache template at edge/browser for 5 min — reduces round-trips on repeat visits
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.json({
    success: true,
    templateJson: injectWhatsAppNumber(templateJson, user.whatsappNumber ?? ""),
    storeName: user.businessName ?? user.name ?? username,
    launchUrl: tmpl.launchUrl,
    vendorId: user.id,
    deliveryFees: {
      lagos: user.deliveryFeeLagos != null ? Number(user.deliveryFeeLagos) : 1500,
      other: user.deliveryFeeOther != null ? Number(user.deliveryFeeOther) : 3500,
      freeThreshold: user.freeDeliveryThreshold != null ? Number(user.freeDeliveryThreshold) : 15000,
    },
  });
});

// POST /api/store/:username/contact — submit a contact form message to a vendor's store
router.post("/store/:username/contact", async (req, res) => {
  const { username } = req.params as { username: string };
  const { name, email, subject, message } = (req.body ?? {}) as Record<string, string>;

  if (!name?.trim() || !message?.trim()) {
    res.status(400).json({ success: false, error: "Name and message are required" });
    return;
  }

  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name, businessName: users.businessName })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user) {
    res.status(404).json({ success: false, error: "Store not found" });
    return;
  }

  await db.insert(contactMessages).values({
    userId:      user.id,
    senderName:  name.trim(),
    senderEmail: email?.trim() || null,
    subject:     subject?.trim() || null,
    message:     message.trim(),
  });

  if (user.email) {
    await sendContactNotificationEmail({
      vendorEmail:  user.email,
      vendorName:   user.businessName ?? user.name ?? username,
      senderName:   name.trim(),
      senderEmail:  email?.trim() || undefined,
      subject:      subject?.trim() || undefined,
      message:      message.trim(),
    }).catch(() => { /* email failure shouldn't break the response */ });
  }

  res.json({ success: true });
});

export default router;
