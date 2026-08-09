-- ============================================================
-- Kiosk — complete database setup script (v2)
-- Safe to run against both a fresh DB and an existing install.
-- Adds new tables and columns introduced since the first version.
--
-- Run in Supabase SQL Editor or psql:
--   psql "$DATABASE_URL" -f SUPABASE_SETUP.sql
-- ============================================================

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                      TEXT,
  email                     TEXT UNIQUE,
  phone                     TEXT,
  password_hash             TEXT,
  business_name             TEXT,
  whatsapp_number           TEXT,
  whatsapp_phone_number_id  TEXT,
  whatsapp_access_token     TEXT,
  username                  TEXT UNIQUE,
  custom_domain             TEXT UNIQUE,
  custom_domain_verified    BOOLEAN NOT NULL DEFAULT false,
  email_verified            BOOLEAN NOT NULL DEFAULT false,
  kyc_verified              BOOLEAN NOT NULL DEFAULT false,
  bot_enabled               BOOLEAN NOT NULL DEFAULT true,
  wallet_balance            DECIMAL(12,2) DEFAULT 0,
  business_address          TEXT,
  referral_code             TEXT UNIQUE,
  referred_by_id            TEXT,
  delivery_fee_lagos         DECIMAL(12,2) DEFAULT 1500,
  delivery_fee_other         DECIMAL(12,2) DEFAULT 3500,
  free_delivery_threshold    DECIMAL(12,2) DEFAULT 15000,
  is_deleted                BOOLEAN NOT NULL DEFAULT false,
  deleted_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill new columns if table already existed
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_domain             TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_domain_verified    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_order              INTEGER;

-- Backfill existing users in signup (created_at) order so early users count
-- toward the promotions. Rules enforced by the API:
--   • signup_order <= 100  → free beta access (until admin disables it)
--   • waitlist members     → 20% discount forever (already existing)
--   • signup_order <= 1000, NOT on waitlist → 20% off 6/12-month plans
--     for the first 3 months after signup (created_at + 3 months)
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS seq
  FROM users
  WHERE signup_order IS NULL
)
UPDATE users u
SET signup_order = numbered.seq
FROM numbered
WHERE u.id = numbered.id;

-- ── otp_sessions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_sessions (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone      TEXT NOT NULL,
  otp        TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── products ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  price        DECIMAL(12,2) NOT NULL DEFAULT 0,
  image_url    TEXT,
  category     TEXT,
  stock        INTEGER DEFAULT 0,
  active       BOOLEAN DEFAULT true,
  sale_price   DECIMAL(12,2),
  sale_ends_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price   DECIMAL(12,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_ends_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS preorder             BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS preorder_release_date TIMESTAMPTZ;

-- ── orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_number       TEXT UNIQUE,
  user_id            TEXT NOT NULL,
  buyer_name         TEXT NOT NULL,
  buyer_email        TEXT,
  buyer_phone        TEXT NOT NULL,
  buyer_address      TEXT,
  buyer_city         TEXT,
  buyer_state        TEXT,
  buyer_zip          TEXT,
  notes              TEXT,
  status             TEXT DEFAULT 'pending',
  escrow_status      TEXT DEFAULT 'locked',
  escrow_otp         TEXT,
  total_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_reference  TEXT,
  payment_provider   TEXT,
  payment_channel    TEXT,
  tracking_id        TEXT,
  logistics_provider TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Pre-order / split-escrow columns (working capital + held escrow) ─────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_preorder            BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS expected_ship_date     TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS escrow_expires_at      TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS release_percent_at_pay DECIMAL(5,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS escrow_amount          DECIMAL(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS working_capital_amount DECIMAL(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission             DECIMAL(12,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_status         TEXT DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispute_reason         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at            TIMESTAMPTZ;

-- ── order_items ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id     TEXT NOT NULL,
  product_id   TEXT,
  product_name TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1,
  unit_price   DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── templates ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS templates (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id          TEXT NOT NULL,
  name             TEXT NOT NULL,
  kind             TEXT DEFAULT 'storefront',
  accent_color     TEXT,
  bg_color         TEXT,
  text_color       TEXT,
  card_color       TEXT,
  launched         BOOLEAN DEFAULT false,
  launch_url       TEXT,
  store_paused     BOOLEAN DEFAULT false,
  payment_gateways JSONB,
  thumbnail        TEXT,
  whatsapp_link    TEXT,
  settings         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE templates ADD COLUMN IF NOT EXISTS store_paused BOOLEAN DEFAULT false;

-- ── template_pages ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS template_pages (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  "order"     INTEGER DEFAULT 0,
  is_home     BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── template_sections ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS template_sections (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_id TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT,
  "order"     INTEGER DEFAULT 0,
  bg_color    TEXT,
  bg_image    TEXT,
  visible     BOOLEAN DEFAULT true,
  config      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── template_components ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS template_components (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  section_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  content    TEXT,
  props      JSONB,
  styles     JSONB,
  behavior   JSONB,
  "order"    INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── subscriptions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL,
  plan              TEXT NOT NULL,
  status            TEXT DEFAULT 'pending',
  start_date        TIMESTAMPTZ,
  end_date          TIMESTAMPTZ,
  payment_provider  TEXT,
  payment_reference TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── referrals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL,
  status      TEXT DEFAULT 'pending',
  reward      DECIMAL(12,2) DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── wallet_transactions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  reference   TEXT,
  description TEXT,
  status      TEXT DEFAULT 'completed',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── bank_accounts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL,
  bank_code      TEXT NOT NULL,
  bank_name      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  is_primary     BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── ads ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  platforms         JSONB DEFAULT '[]'::jsonb,
  target_audience   TEXT,
  budget            DECIMAL(12,2) DEFAULT 0,
  spent             DECIMAL(12,2) DEFAULT 0,
  status            TEXT DEFAULT 'draft',
  impressions       INTEGER DEFAULT 0,
  clicks            INTEGER DEFAULT 0,
  leads             INTEGER DEFAULT 0,
  image_url         TEXT,
  video_url         TEXT,
  payment_reference TEXT,
  payment_provider  TEXT,
  start_date        TIMESTAMPTZ,
  end_date          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── whatsapp_messages ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id             TEXT NOT NULL,
  customer_phone      TEXT NOT NULL,
  direction           TEXT NOT NULL,
  message             TEXT NOT NULL,
  whatsapp_message_id TEXT,
  status              TEXT DEFAULT 'sent',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── logistics_bookings ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS logistics_bookings (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id              TEXT NOT NULL,
  order_id             TEXT,
  provider             TEXT NOT NULL,
  tracking_id          TEXT,
  tracking_url         TEXT,
  provider_booking_id  TEXT,
  package_description  TEXT,
  status               TEXT DEFAULT 'pending',
  pickup_address       TEXT,
  delivery_address     TEXT,
  estimated_cost       DECIMAL(12,2),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE logistics_bookings
  ADD COLUMN IF NOT EXISTS rider_name       TEXT,
  ADD COLUMN IF NOT EXISTS rider_phone      TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_type     TEXT,
  ADD COLUMN IF NOT EXISTS rider_lat        DECIMAL(10, 7),
  ADD COLUMN IF NOT EXISTS rider_lng        DECIMAL(10, 7),
  ADD COLUMN IF NOT EXISTS rider_updated_at TIMESTAMPTZ;

-- ── user_push_tokens ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_push_tokens (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL,
  token      TEXT NOT NULL,
  platform   TEXT DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, token)
);

-- ── newsletter_subscribers ───────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT,
  phone      TEXT,
  source     TEXT DEFAULT 'manual',
  subscribed BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, email)
);

-- ── support_messages ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_messages (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL,
  subject    TEXT,
  message    TEXT NOT NULL,
  status     TEXT DEFAULT 'open',
  reply      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════
-- NEW TABLES (added in v2)
-- ══════════════════════════════════════════════════════════════

-- ── customer_notes ───────────────────────────────────────────
-- Vendor-private notes attached to a customer (by phone number).
-- tag values: wholesale | vip | follow-up | loyal | high-value

CREATE TABLE IF NOT EXISTS customer_notes (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  note           TEXT NOT NULL,
  tag            TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── product_reviews ──────────────────────────────────────────
-- Buyer reviews submitted from the web storefront after purchase.
-- status: pending | approved | hidden

CREATE TABLE IF NOT EXISTS product_reviews (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vendor_id    TEXT NOT NULL,
  product_id   TEXT,
  product_name TEXT NOT NULL,
  order_id     TEXT,
  buyer_email  TEXT,
  buyer_name   TEXT NOT NULL,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         TEXT,
  photo_urls   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending',
  reply        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── discounts ────────────────────────────────────────────────
-- Vendor promo codes applied at checkout.
-- type: percent | fixed

CREATE TABLE IF NOT EXISTS discounts (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vendor_id   TEXT NOT NULL,
  code        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'percent',
  value       DECIMAL(12,2) NOT NULL,
  min_order   DECIMAL(12,2) DEFAULT 0,
  max_uses    INTEGER,
  uses_count  INTEGER DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(vendor_id, code)
);

-- ── restock_alerts ───────────────────────────────────────────
-- Customer subscribes to be notified when an OOS product is restocked.

CREATE TABLE IF NOT EXISTS restock_alerts (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_id     TEXT NOT NULL,
  vendor_id      TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(product_id, customer_phone)
);

-- ── buyer_referrals ──────────────────────────────────────────
-- Each buyer who orders gets a unique referral code for that vendor's store.
-- When someone else orders using their code, the original buyer earns a reward.

CREATE TABLE IF NOT EXISTS buyer_referrals (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vendor_id   TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  buyer_name  TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  times_used  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(vendor_id, buyer_phone)
);

-- ── contact_messages ─────────────────────────────────────────
-- Messages submitted through a vendor's storefront contact form.

CREATE TABLE IF NOT EXISTS contact_messages (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  sender_name  TEXT NOT NULL,
  sender_email TEXT,
  subject      TEXT,
  message      TEXT NOT NULL,
  read         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── waitlist ─────────────────────────────────────────────────
-- Early-access signups who receive 20% off their first subscription.

CREATE TABLE IF NOT EXISTS waitlist (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email      TEXT NOT NULL UNIQUE,
  phone      TEXT,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill if table already existed without phone/name
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS name  TEXT;

-- ══════════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════════

-- Core tables
CREATE INDEX IF NOT EXISTS idx_products_user_id          ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id            ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_number       ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_payment_reference  ON orders(payment_reference);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id      ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_templates_user_id         ON templates(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id     ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_id         ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_user_id       ON whatsapp_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone         ON whatsapp_messages(customer_phone);
CREATE INDEX IF NOT EXISTS idx_users_wa_phone_number_id  ON users(whatsapp_phone_number_id);
CREATE INDEX IF NOT EXISTS idx_users_is_deleted          ON users(is_deleted);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id       ON user_push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_user_id        ON newsletter_subscribers(user_id);
CREATE INDEX IF NOT EXISTS idx_support_user_id           ON support_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_logistics_user_id         ON logistics_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_logistics_order_id        ON logistics_bookings(order_id);
CREATE INDEX IF NOT EXISTS idx_ads_user_id               ON ads(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user_id     ON bank_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_escrow_expires_at  ON orders(escrow_expires_at) WHERE escrow_expires_at IS NOT NULL;

-- New tables (v2)
CREATE INDEX IF NOT EXISTS idx_customer_notes_user_id    ON customer_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_customer_notes_phone      ON customer_notes(customer_phone);
CREATE INDEX IF NOT EXISTS idx_reviews_vendor_id         ON product_reviews(vendor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id        ON product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_order_id          ON product_reviews(order_id);
CREATE INDEX IF NOT EXISTS idx_discounts_vendor_id       ON discounts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_restock_vendor_id         ON restock_alerts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_restock_product_id        ON restock_alerts(product_id);
CREATE INDEX IF NOT EXISTS idx_buyer_refs_vendor_id      ON buyer_referrals(vendor_id);
CREATE INDEX IF NOT EXISTS idx_contact_messages_user_id  ON contact_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_buyer_refs_code           ON buyer_referrals(code);
CREATE INDEX IF NOT EXISTS idx_waitlist_email            ON waitlist(email);

-- ── disputes ─────────────────────────────────────────────────────────────────
-- Buyer↔vendor dispute audit log. While a row is `open`, the order's escrow is
-- frozen (escrow_status='disputed') so money cannot move. Admin resolves it.
-- resolution: release_to_merchant | refund_buyer

CREATE TABLE IF NOT EXISTS disputes (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id        TEXT NOT NULL,
  opened_by       TEXT NOT NULL,              -- buyer_phone | vendor
  reason          TEXT NOT NULL,              -- not_received | wrong_item | damaged | other
  description     TEXT,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT DEFAULT 'open',        -- open | resolved | escalated
  resolution      TEXT,                       -- release_to_merchant | refund_buyer
  resolved_by_id  TEXT,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_disputes_order_id  ON disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status    ON disputes(status);

-- ── app_settings ─────────────────────────────────────────────────────────
-- Platform-level key/value settings (admin managed). Holds the beta program toggle.
-- See also: users.signup_order (early-adopter 20% discount + free beta).

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the beta toggle (ON by default).
INSERT INTO app_settings (key, value)
VALUES ('beta_testing_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_users_signup_order ON users(signup_order);

-- ── abandoned_carts ─────────────────────────────────────────────────────────
-- Tracks storefront carts that were not checked out.
-- A cron job (or the POST /api/abandoned-carts/send-recovery endpoint) finds
-- carts idle > 1 hour with a buyer email and sends one recovery email.

CREATE TABLE IF NOT EXISTS abandoned_carts (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id          TEXT NOT NULL,                  -- vendor whose store this cart belongs to
  session_token    TEXT NOT NULL,                  -- anonymous session ID from the storefront
  recovery_token   TEXT DEFAULT gen_random_uuid()::text,
  buyer_email      TEXT,
  buyer_name       TEXT,
  items            JSONB NOT NULL DEFAULT '[]',    -- Array<{id, name, price, imageUrl?}>
  email_sent_at    TIMESTAMPTZ,
  recovered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovery_token TEXT DEFAULT gen_random_uuid()::text;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS email_sent_at  TIMESTAMPTZ;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovered_at   TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_abandoned_session_vendor
  ON abandoned_carts(session_token, user_id);
CREATE INDEX IF NOT EXISTS idx_abandoned_vendor_id    ON abandoned_carts(user_id);
CREATE INDEX IF NOT EXISTS idx_abandoned_buyer_email  ON abandoned_carts(buyer_email);
CREATE INDEX IF NOT EXISTS idx_abandoned_updated_at   ON abandoned_carts(updated_at);

-- Optional: schedule a Supabase pg_cron job to call the recovery endpoint every 15 min
-- (requires pg_cron extension enabled in your Supabase project)
--
-- SELECT cron.schedule(
--   'send-abandoned-cart-emails',
--   '*/15 * * * *',
--   $$
--     SELECT net.http_post(
--       url := 'https://YOUR_API_SERVER_URL/api/abandoned-carts/send-recovery',
--       headers := '{"x-cron-secret": "YOUR_CRON_SECRET"}'::jsonb
--     );
--   $$
-- );
