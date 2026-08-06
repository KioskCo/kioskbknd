# Database Migration Notes

The auth overhaul requires these schema changes on the `users` table and `otpSessions` table.
Run the following SQL against your database (Postgres):

```sql
-- Add email auth columns to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

-- The otpSessions.phone column is reused to store email addresses for signup OTPs.
-- No schema change needed for otpSessions — the `phone` column stores the email string.
-- Optionally rename it for clarity:
-- ALTER TABLE otp_sessions RENAME COLUMN phone TO identity;
```

> After migrating, existing phone-only users will need to reset their password via the signup flow.

---

## Per-vendor WhatsApp + soft-delete columns

These columns were added to support Meta Embedded Signup (per-vendor WhatsApp credentials) and soft account deletion:

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_access_token     TEXT,
  ADD COLUMN IF NOT EXISTS is_deleted   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;

-- Index for fast webhook routing (match inbound message to correct vendor)
CREATE INDEX IF NOT EXISTS idx_users_wa_phone_number_id ON users(whatsapp_phone_number_id);

-- Index so login/signup checks for deleted accounts are fast
CREATE INDEX IF NOT EXISTS idx_users_is_deleted ON users(is_deleted);

-- user_push_tokens table (auto-created at startup, but here for explicit migration)
CREATE TABLE IF NOT EXISTS user_push_tokens (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  token       TEXT NOT NULL,
  platform    TEXT DEFAULT 'unknown',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, token)
);
```

---

## Newsletter subscribers table

The customers router auto-creates this table on first startup (`CREATE TABLE IF NOT EXISTS`), but run this explicitly for a clean migration:

```sql
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  phone       TEXT,
  source      TEXT DEFAULT 'manual',
  subscribed  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_newsletter_user_id ON newsletter_subscribers(user_id);
```

---

## Buyer-facing order columns

Required for the shop storefront to place orders directly into the API server
(replacing the old Supabase-based checkout):

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_number TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS buyer_email  TEXT,
  ADD COLUMN IF NOT EXISTS buyer_city   TEXT,
  ADD COLUMN IF NOT EXISTS buyer_zip    TEXT;

-- Speed up order-number lookups (order status page, webhook matching)
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
```

---

## Split escrow / pre-order columns

For the 50%-working-capital pre-order flow (released at payment, remainder held until
delivery-confirmed, partial refund if not shipped by the deadline):

```sql
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS preorder             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS preorder_release_date TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_preorder            BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS expected_ship_date     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_expires_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS release_percent_at_pay DECIMAL(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_amount          DECIMAL(12,2),   -- held until delivery
  ADD COLUMN IF NOT EXISTS working_capital_amount DECIMAL(12,2),   -- released at payment
  ADD COLUMN IF NOT EXISTS commission             DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispute_status         TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS dispute_reason         TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at            TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_escrow_expires_at
  ON orders(escrow_expires_at) WHERE escrow_expires_at IS NOT NULL;

-- Dispute audit log — freezes escrow (escrow_status='disputed') while open
CREATE TABLE IF NOT EXISTS disputes (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id        TEXT NOT NULL,
  opened_by       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  description     TEXT,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT DEFAULT 'open',
  resolution      TEXT,
  resolved_by_id  TEXT,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Behaviors:
- `release_percent_at_pay = 0.5` (pre-orders) → 50% released to vendor wallet on payment confirmation.
- `escrow_amount` holds the remaining 50% and is what `release-escrow` credits on delivery.
- If the vendor has not shipped by `escrow_expires_at`, the auto-refund worker refunds **only
  `escrow_amount`** — the working-capital portion is a business loss for the vendor.

---

## Location-aware delivery charges

Shipping is now priced by zone — Lagos local delivery (₦1,500) vs inter-state (₦3,500), free
over ₦15,000. The zone is derived from the buyer's state at checkout:

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS buyer_state TEXT;
```

Vendors can override their own rates and free-delivery threshold from the kiosk (Settings →
Delivery & Fees). These are stored on `users`:

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS delivery_fee_lagos      DECIMAL(12,2) DEFAULT 1500,
  ADD COLUMN IF NOT EXISTS delivery_fee_other      DECIMAL(12,2) DEFAULT 3500,
  ADD COLUMN IF NOT EXISTS free_delivery_threshold DECIMAL(12,2) DEFAULT 15000;
```

The public store endpoint (`/api/store/:username`) now returns these as `deliveryFees`
so the shop checkout can display the correct charge.

## Payment processing + transfer fees (split deduction)

- **Checkout**: Paystack (1.5% + ₦100) or Flutterwave (1.4% + ₦100) processing fee is added
  to the buyer's total. The vendor keeps the full sale amount in escrow; the fee is recorded
  on the order as `commission` (existing column — no migration needed).
- **Withdrawal**: Paystack transfer fee (₦10 above ₦5,000, else free) is deducted from the
  vendor's wallet on top of the withdrawal amount.

No schema change required — `orders.commission` already exists.
