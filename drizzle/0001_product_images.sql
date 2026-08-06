-- ─── Kiosk schema migrations ──────────────────────────────────────────────────
-- Run this once against your Supabase / Postgres DB.
-- You can paste it directly into the Supabase SQL editor.
--
-- How to run via Supabase:
--   1. Open your Supabase project → SQL Editor
--   2. Paste this entire file and click "Run"
-- How to run via psql:
--   psql $DATABASE_URL -f drizzle/0001_product_images.sql
-- ──────────────────────────────────────────────────────────────────────────────

-- 0001: Add extra product images array to the products table.
-- Stores up to 4 additional image URLs uploaded from the kiosk inventory page.

