/**
 * Templates routes — store/website builder.
 *
 * GET    /api/templates                            — list the merchant's templates
 * POST   /api/templates                            — create a new template
 * GET    /api/templates/:id                        — get a template with pages, sections, components
 * PATCH  /api/templates/:id                        — update template settings
 * DELETE /api/templates/:id                        — delete a template
 * POST   /api/templates/:id/launch                 — publish template (set launched=true)
 * POST   /api/templates/:id/deactivate             — unpublish template
 *
 * Pages:
 * POST   /api/templates/:id/pages                  — add a page
 * PATCH  /api/templates/:id/pages/:pageId          — update a page
 * DELETE /api/templates/:id/pages/:pageId          — delete a page
 * PATCH  /api/templates/:id/pages/reorder          — reorder pages
 *
 * Sections:
 * POST   /api/templates/:id/pages/:pageId/sections         — add section to page
 * PATCH  /api/templates/:id/sections/:sectionId            — update section
 * DELETE /api/templates/:id/sections/:sectionId            — delete section
 * PATCH  /api/templates/:id/pages/:pageId/sections/reorder — reorder sections
 *
 * Components:
 * POST   /api/templates/:id/sections/:sectionId/components       — add component
 * PATCH  /api/templates/:id/components/:componentId              — update component
 * DELETE /api/templates/:id/components/:componentId              — delete component
 * PATCH  /api/templates/:id/sections/:sectionId/components/reorder — reorder components
 */

import {
  db, templates, templatePages, templateSections, templateComponents, users,
} from "../db/index.js";
import { eq, and, asc, inArray, ne } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();
router.use(requireAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the template if it belongs to userId, null otherwise. */
async function getOwnedTemplate(templateId: string, userId: string) {
  const [tmpl] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, templateId), eq(templates.userId, userId)))
    .limit(1);
  return tmpl ?? null;
}

/** Load the full template tree in three queries (not N+1). */
async function loadFullTemplate(templateId: string) {
  const [tmpl] = await db.select().from(templates).where(eq(templates.id, templateId)).limit(1);
  if (!tmpl) return null;

  const pages = await db
    .select()
    .from(templatePages)
    .where(eq(templatePages.templateId, templateId))
    .orderBy(asc(templatePages.order));

  const sections = await db
    .select()
    .from(templateSections)
    .where(eq(templateSections.templateId, templateId))
    .orderBy(asc(templateSections.order));

  // Load all components in ONE query using inArray, then group in memory.
  const sectionIds = sections.map((s) => s.id);
  const allComponents = sectionIds.length > 0
    ? await db
        .select()
        .from(templateComponents)
        .where(inArray(templateComponents.sectionId, sectionIds))
        .orderBy(asc(templateComponents.order))
    : [];

  const componentsBySection: Record<string, typeof allComponents> = {};
  for (const comp of allComponents) {
    (componentsBySection[comp.sectionId] ??= []).push(comp);
  }

  const sectionsWithComponents = sections.map((s) => ({
    ...s,
    components: componentsBySection[s.id] ?? [],
  }));

  const pagesWithSections = pages.map((p) => ({
    ...p,
    sections: sectionsWithComponents.filter((s) => s.pageId === p.id),
  }));

  return { ...tmpl, pages: pagesWithSections };
}

// ─── GET /api/templates ───────────────────────────────────────────────────────

router.get("/templates", async (req, res) => {
  const rows = await db
    .select()
    .from(templates)
    .where(eq(templates.userId, req.user!.userId));

  res.json({ success: true, data: rows });
});

// ─── POST /api/templates ──────────────────────────────────────────────────────

const createTemplateSchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  accentColor: z.string().optional(),
  bgColor: z.string().optional(),
  textColor: z.string().optional(),
  cardColor: z.string().optional(),
  paymentGateways: z.array(z.string()).optional(),
});

router.post("/templates", async (req, res) => {
  const parsed = createTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const [tmpl] = await db
    .insert(templates)
    .values({ userId: req.user!.userId, ...parsed.data })
    .returning();

  // Create a default Home page
  const [homePage] = await db
    .insert(templatePages)
    .values({ templateId: tmpl!.id, name: "Home", slug: "home", order: 0, isHome: true })
    .returning();

  req.log.info({ templateId: tmpl!.id }, "Template created");
  res.status(201).json({ success: true, data: { ...tmpl, pages: [{ ...homePage, sections: [] }] } });
});

// ─── GET /api/templates/:id ───────────────────────────────────────────────────

router.get("/templates/:id", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }

  const full = await loadFullTemplate(req.params.id!);
  res.json({ success: true, data: full });
});

// ─── PATCH /api/templates/:id ─────────────────────────────────────────────────

const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  kind: z.string().optional(),
  accentColor: z.string().optional(),
  bgColor: z.string().optional(),
  textColor: z.string().optional(),
  cardColor: z.string().optional(),
  paymentGateways: z.array(z.string()).optional(),
  thumbnail: z.string().optional(),
  whatsappLink: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
});

router.patch("/templates/:id", async (req, res) => {
  const parsed = updateTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message });
    return;
  }

  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }

  const [updated] = await db
    .update(templates)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(templates.id, req.params.id!))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── DELETE /api/templates/:id ────────────────────────────────────────────────

router.delete("/templates/:id", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }

  await db.delete(templates).where(eq(templates.id, req.params.id!));
  res.json({ success: true, message: "Template deleted" });
});

// ─── POST /api/templates/:id/launch ──────────────────────────────────────────

const SHOP_LAUNCH_BASE = process.env["SHOP_BASE_URL"] ?? "https://keeosk.store/@";

router.post("/templates/:id/launch", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  const rawUsername = (req.body as { username?: string }).username ?? user?.username ?? user?.name ?? req.user!.userId;
  const slug = rawUsername.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9_]/g, "");
  if (!slug) {
    res.status(400).json({ success: false, error: "A valid store username is required" });
    return;
  }

  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, slug), ne(users.id, req.user!.userId)))
    .limit(1);

  if (taken) {
    res.status(409).json({ success: false, error: "This store username is already taken" });
    return;
  }

  const launchUrl = `${SHOP_LAUNCH_BASE}${slug}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(launchUrl)}`;

  if (user?.username !== slug) {
    await db
      .update(users)
      .set({ username: slug, updatedAt: new Date() })
      .where(eq(users.id, req.user!.userId));
  }

  const [updated] = await db
    .update(templates)
    .set({ launched: true, launchUrl, storePaused: false, updatedAt: new Date() })
    .where(eq(templates.id, req.params.id!))
    .returning();

  res.json({ success: true, data: { ...updated, qrCodeUrl } });
});

// ─── POST /api/templates/:id/deactivate ──────────────────────────────────────
// Pauses the live store — keeps launchUrl so visitors see maintenance page.

router.post("/templates/:id/deactivate", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }

  const [updated] = await db
    .update(templates)
    .set({ storePaused: true, updatedAt: new Date() })
    .where(eq(templates.id, req.params.id!))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── POST /api/templates/:id/activate ────────────────────────────────────────
// Resumes a paused store without re-publishing it from scratch.

router.post("/templates/:id/activate", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }

  const [updated] = await db
    .update(templates)
    .set({ storePaused: false, updatedAt: new Date() })
    .where(eq(templates.id, req.params.id!))
    .returning();

  res.json({ success: true, data: updated });
});

// ─── PAGES ────────────────────────────────────────────────────────────────────

const pageSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  order: z.number().int().optional(),
});

router.post("/templates/:id/pages", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const parsed = pageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues[0]?.message }); return; }

  const [page] = await db
    .insert(templatePages)
    .values({ templateId: req.params.id!, ...parsed.data })
    .returning();

  res.status(201).json({ success: true, data: { ...page, sections: [] } });
});

router.patch("/templates/:id/pages/:pageId", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const parsed = z.object({ name: z.string().optional(), slug: z.string().optional(), order: z.number().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues[0]?.message }); return; }

  // Verify page belongs to this template
  const [page] = await db.select({ id: templatePages.id })
    .from(templatePages)
    .where(and(eq(templatePages.id, req.params.pageId!), eq(templatePages.templateId, req.params.id!)))
    .limit(1);
  if (!page) { res.status(404).json({ success: false, error: "Page not found" }); return; }

  const [updated] = await db
    .update(templatePages)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(templatePages.id, req.params.pageId!))
    .returning();

  res.json({ success: true, data: updated });
});

router.delete("/templates/:id/pages/:pageId", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  // Verify page belongs to this template
  const [page] = await db.select({ id: templatePages.id })
    .from(templatePages)
    .where(and(eq(templatePages.id, req.params.pageId!), eq(templatePages.templateId, req.params.id!)))
    .limit(1);
  if (!page) { res.status(404).json({ success: false, error: "Page not found" }); return; }

  await db.delete(templatePages).where(eq(templatePages.id, req.params.pageId!));
  res.json({ success: true, message: "Page deleted" });
});

// Reorder pages
router.patch("/templates/:id/pages/reorder", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const { order } = req.body as { order: Array<{ id: string; order: number }> };
  for (const item of order ?? []) {
    await db.update(templatePages).set({ order: item.order }).where(
      and(eq(templatePages.id, item.id), eq(templatePages.templateId, req.params.id!))
    );
  }
  res.json({ success: true });
});

// ─── SECTIONS ─────────────────────────────────────────────────────────────────

const sectionSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  order: z.number().int().optional(),
  bgColor: z.string().optional(),
  bgImage: z.string().optional(),
  visible: z.boolean().optional(),
});

router.post("/templates/:id/pages/:pageId/sections", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const parsed = sectionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues[0]?.message }); return; }

  const [section] = await db
    .insert(templateSections)
    .values({ pageId: req.params.pageId!, templateId: req.params.id!, ...parsed.data })
    .returning();

  res.status(201).json({ success: true, data: { ...section, components: [] } });
});

router.patch("/templates/:id/sections/:sectionId", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const parsed = sectionSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues[0]?.message }); return; }

  // Verify section belongs to this template
  const [section] = await db.select({ id: templateSections.id })
    .from(templateSections)
    .where(and(eq(templateSections.id, req.params.sectionId!), eq(templateSections.templateId, req.params.id!)))
    .limit(1);
  if (!section) { res.status(404).json({ success: false, error: "Section not found" }); return; }

  const [updated] = await db
    .update(templateSections)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(templateSections.id, req.params.sectionId!))
    .returning();

  res.json({ success: true, data: updated });
});

router.delete("/templates/:id/sections/:sectionId", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  // Verify section belongs to this template
  const [section] = await db.select({ id: templateSections.id })
    .from(templateSections)
    .where(and(eq(templateSections.id, req.params.sectionId!), eq(templateSections.templateId, req.params.id!)))
    .limit(1);
  if (!section) { res.status(404).json({ success: false, error: "Section not found" }); return; }

  await db.delete(templateSections).where(eq(templateSections.id, req.params.sectionId!));
  res.json({ success: true, message: "Section deleted" });
});

router.patch("/templates/:id/pages/:pageId/sections/reorder", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const { order } = req.body as { order: Array<{ id: string; order: number }> };
  for (const item of order ?? []) {
    await db.update(templateSections).set({ order: item.order }).where(
      and(eq(templateSections.id, item.id), eq(templateSections.templateId, req.params.id!))
    );
  }
  res.json({ success: true });
});

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const componentSchema = z.object({
  type: z.string().min(1),
  content: z.string().optional(),
  props: z.record(z.unknown()).optional(),
  styles: z.record(z.unknown()).optional(),
  behavior: z.record(z.unknown()).optional(),
  order: z.number().int().optional(),
});

router.post("/templates/:id/sections/:sectionId/components", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const parsed = componentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues[0]?.message }); return; }

  // Verify section belongs to this template
  const [section] = await db.select({ id: templateSections.id })
    .from(templateSections)
    .where(and(eq(templateSections.id, req.params.sectionId!), eq(templateSections.templateId, req.params.id!)))
    .limit(1);
  if (!section) { res.status(404).json({ success: false, error: "Section not found" }); return; }

  const [comp] = await db
    .insert(templateComponents)
    .values({ sectionId: req.params.sectionId!, ...parsed.data })
    .returning();

  res.status(201).json({ success: true, data: comp });
});

router.patch("/templates/:id/components/:componentId", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const parsed = componentSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues[0]?.message }); return; }

  // Verify component belongs to a section of this template via join
  const [existing] = await db
    .select({ id: templateComponents.id })
    .from(templateComponents)
    .innerJoin(templateSections, eq(templateComponents.sectionId, templateSections.id))
    .where(
      and(
        eq(templateComponents.id, req.params.componentId!),
        eq(templateSections.templateId, req.params.id!)
      )
    )
    .limit(1);
  if (!existing) { res.status(404).json({ success: false, error: "Component not found" }); return; }

  const [updated] = await db
    .update(templateComponents)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(templateComponents.id, req.params.componentId!))
    .returning();

  res.json({ success: true, data: updated });
});

router.delete("/templates/:id/components/:componentId", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  // Verify component belongs to a section of this template via join
  const [existing] = await db
    .select({ id: templateComponents.id })
    .from(templateComponents)
    .innerJoin(templateSections, eq(templateComponents.sectionId, templateSections.id))
    .where(
      and(
        eq(templateComponents.id, req.params.componentId!),
        eq(templateSections.templateId, req.params.id!)
      )
    )
    .limit(1);
  if (!existing) { res.status(404).json({ success: false, error: "Component not found" }); return; }

  await db.delete(templateComponents).where(eq(templateComponents.id, req.params.componentId!));
  res.json({ success: true, message: "Component deleted" });
});

router.patch("/templates/:id/sections/:sectionId/components/reorder", async (req, res) => {
  const owned = await getOwnedTemplate(req.params.id!, req.user!.userId);
  if (!owned) { res.status(404).json({ success: false, error: "Template not found" }); return; }

  const { order } = req.body as { order: Array<{ id: string; order: number }> };
  for (const item of order ?? []) {
    await db.update(templateComponents).set({ order: item.order }).where(eq(templateComponents.id, item.id));
  }
  res.json({ success: true });
});

export default router;
