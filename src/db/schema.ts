/**
 * Drizzle ORM schema — single source of truth for all database tables.
 * Uses PostgreSQL (Supabase) via the postgres.js driver.
 */

import {
  pgTable, text, integer, boolean, timestamp, decimal, jsonb, unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Shared helpers ───────────────────────────────────────────────────────────

const uid = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`)
    .notNull();

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

// ─── users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:              uid(),
  name:            text("name"),
  email:           text("email").unique(),
  phone:           text("phone"),
  passwordHash:    text("password_hash"),
  businessName:    text("business_name"),
  whatsappNumber:       text("whatsapp_number"),
  whatsappPhoneNumberId: text("whatsapp_phone_number_id"),  // Meta phone_number_id from WABA
  whatsappAccessToken:   text("whatsapp_access_token"),     // Per-vendor OAuth token from Meta
  username:              text("username").unique(),
  customDomain:          text("custom_domain").unique(),
  customDomainVerified:  boolean("custom_domain_verified").default(false),
  emailVerified:         boolean("email_verified").default(false),
  kycVerified:     boolean("kyc_verified").default(false),
  botEnabled:      boolean("bot_enabled").default(true),
  walletBalance:   decimal("wallet_balance", { precision: 12, scale: 2 }).default("0"),
  businessAddress: text("business_address"),
  referralCode:    text("referral_code").unique(),
  referredById:    text("referred_by_id"),
  // 1-based signup order. Smallest orders = earliest signups. Used for the
  // free-beta (first 100) program and the early-adopter offer (first 1000,
  // non-waitlist, 20% off 6/12-month plans for the first 3 months after signup).
  signupOrder:     integer("signup_order"),
  // Vendor-configured delivery charges shown at checkout (defaults = platform rates).
  deliveryFeeLagos:   decimal("delivery_fee_lagos", { precision: 12, scale: 2 }).default("1500"),
  deliveryFeeOther:   decimal("delivery_fee_other", { precision: 12, scale: 2 }).default("3500"),
  freeDeliveryThreshold: decimal("free_delivery_threshold", { precision: 12, scale: 2 }).default("15000"),
  isDeleted:       boolean("is_deleted").default(false).notNull(),
  deletedAt:       timestamp("deleted_at", { withTimezone: true }),
  createdAt:       createdAt(),
  updatedAt:       updatedAt(),
});

// ─── otp_sessions ─────────────────────────────────────────────────────────────

export const otpSessions = pgTable("otp_sessions", {
  id:        uid(),
  phone:     text("phone").notNull(),
  otp:       text("otp").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used:      boolean("used").default(false),
  createdAt: createdAt(),
});

// ─── products ─────────────────────────────────────────────────────────────────

export const products = pgTable("products", {
  id:          uid(),
  userId:      text("user_id").notNull(),
  name:        text("name").notNull(),
  description: text("description"),
  price:       decimal("price", { precision: 12, scale: 2 }).notNull().default("0"),
  imageUrl:    text("image_url"),
  images:      jsonb("images").$type<string[]>().default(sql`'[]'::jsonb`),
  category:    text("category"),
  stock:       integer("stock").default(0),
  active:      boolean("active").default(true),
  salePrice:   decimal("sale_price", { precision: 12, scale: 2 }),
  saleEndsAt:  timestamp("sale_ends_at", { withTimezone: true }),
  // ── Pre-order support ──────────────────────────────────────────────────────
  preorder:            boolean("preorder").default(false),
  preorderReleaseDate: timestamp("preorder_release_date", { withTimezone: true }),
  createdAt:   createdAt(),
  updatedAt:   updatedAt(),
}, (t) => [
  // Prevent a vendor uploading the same product name twice (case-insensitive).
  // Partial: only enforces while active so a soft-deleted product can be re-added.
  uniqueIndex("uq_product_vendor_name_active")
    .on(t.userId, sql`lower(${t.name})`)
    .where(sql`${t.active} = true`),
]);

// ─── orders ───────────────────────────────────────────────────────────────────

export const orders = pgTable("orders", {
  id:                uid(),
  orderNumber:       text("order_number").unique(),              // human-readable e.g. ORD-LQF3X-A7B
  userId:            text("user_id").notNull(),
  buyerName:         text("buyer_name").notNull(),
  buyerEmail:        text("buyer_email"),
  buyerPhone:        text("buyer_phone").notNull(),
  buyerAddress:      text("buyer_address"),
  buyerCity:         text("buyer_city"),
  buyerState:        text("buyer_state"),                        // delivery zone driver (Lagos vs other states)
  buyerZip:          text("buyer_zip"),
  notes:             text("notes"),
  status:            text("status").default("pending"),          // pending|paid|shipped|delivered|cancelled
  escrowStatus:      text("escrow_status").default("locked"),    // locked|released|refunded|disputed
  escrowOtp:         text("escrow_otp"),
  totalAmount:       decimal("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  paymentReference:  text("payment_reference").unique(),          // one paid reference = one order (anti-fraud)
  paymentProvider:   text("payment_provider"),                   // paystack|flutterwave
  paymentChannel:    text("payment_channel"),
  trackingId:        text("tracking_id"),
  logisticsProvider: text("logistics_provider"),
  // ── Pre-order fields ───────────────────────────────────────────────────────
  isPreorder:     boolean("is_preorder").default(false),
  expectedShipDate: timestamp("expected_ship_date", { withTimezone: true }),
  // Buyer protection: if we cannot ship by this deadline, the escrow job
  // auto-refunds the buyer. Only set for pre-orders / manual orders.
  escrowExpiresAt:  timestamp("escrow_expires_at", { withTimezone: true }),
  // Optionally release part of a pre-order to the vendor at payment as working
  // capital: 0 = full escrow, 0.4 = 40% released now, 60% held until delivery.
  releasePercentAtPayment: decimal("release_percent_at_pay", { precision: 5, scale: 2 }).default("0"),
  escrowAmount:     decimal("escrow_amount", { precision: 12, scale: 2 }), // net amount held until delivery confirmation
  workingCapitalAmount: decimal("working_capital_amount", { precision: 12, scale: 2 }), // released to vendor at payment (anti-scam business loss if not shipped)
  // Platform commission recorded at payment (net = total - commission).
  commission:       decimal("commission", { precision: 12, scale: 2 }).default("0"),
  // Dispute tracking — freezes escrow while a dispute is open.
  disputeStatus:    text("dispute_status").default("none"),      // none|open|resolved
  disputeReason:    text("dispute_reason"),
  refundedAt:       timestamp("refunded_at", { withTimezone: true }),
  createdAt:         createdAt(),
  updatedAt:         updatedAt(),
});

// ─── order_items ──────────────────────────────────────────────────────────────

export const orderItems = pgTable("order_items", {
  id:          uid(),
  orderId:     text("order_id").notNull(),
  productId:   text("product_id"),
  productName: text("product_name").notNull(),
  quantity:    integer("quantity").notNull().default(1),
  unitPrice:   decimal("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt:   createdAt(),
});

// ─── templates ────────────────────────────────────────────────────────────────

export const templates = pgTable("templates", {
  id:              uid(),
  userId:          text("user_id").notNull(),
  name:            text("name").notNull(),
  kind:            text("kind").default("storefront"),
  accentColor:     text("accent_color"),
  bgColor:         text("bg_color"),
  textColor:       text("text_color"),
  cardColor:       text("card_color"),
  launched:        boolean("launched").default(false),
  launchUrl:       text("launch_url"),
  storePaused:     boolean("store_paused").default(false),
  paymentGateways: jsonb("payment_gateways").$type<string[]>(),
  thumbnail:       text("thumbnail"),
  whatsappLink:    text("whatsapp_link"),
  settings:        jsonb("settings").$type<Record<string, unknown>>(),
  createdAt:       createdAt(),
  updatedAt:       updatedAt(),
});

// ─── template_pages ───────────────────────────────────────────────────────────

export const templatePages = pgTable("template_pages", {
  id:         uid(),
  templateId: text("template_id").notNull(),
  name:       text("name").notNull(),
  slug:       text("slug").notNull(),
  order:      integer("order").default(0),
  isHome:     boolean("is_home").default(false),
  createdAt:  createdAt(),
  updatedAt:  updatedAt(),
});

// ─── template_sections ────────────────────────────────────────────────────────

export const templateSections = pgTable("template_sections", {
  id:         uid(),
  templateId: text("template_id").notNull(),
  pageId:     text("page_id").notNull(),
  name:       text("name").notNull(),
  type:       text("type"),
  order:      integer("order").default(0),
  bgColor:    text("bg_color"),
  bgImage:    text("bg_image"),
  visible:    boolean("visible").default(true),
  config:     jsonb("config").$type<Record<string, unknown>>(),
  createdAt:  createdAt(),
  updatedAt:  updatedAt(),
});

// ─── template_components ─────────────────────────────────────────────────────

export const templateComponents = pgTable("template_components", {
  id:       uid(),
  sectionId: text("section_id").notNull(),
  type:     text("type").notNull(),
  content:  text("content"),
  props:    jsonb("props").$type<Record<string, unknown>>(),
  styles:   jsonb("styles").$type<Record<string, unknown>>(),
  behavior: jsonb("behavior").$type<Record<string, unknown>>(),
  order:    integer("order").default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── subscriptions ────────────────────────────────────────────────────────────

export const subscriptions = pgTable("subscriptions", {
  id:               uid(),
  userId:           text("user_id").notNull(),
  plan:             text("plan").notNull(),              // 6months|yearly
  status:           text("status").default("pending"),   // pending|active|expired|cancelled
  startDate:        timestamp("start_date", { withTimezone: true }),
  endDate:          timestamp("end_date", { withTimezone: true }),
  paymentProvider:  text("payment_provider"),
  paymentReference: text("payment_reference"),
  createdAt:        createdAt(),
  updatedAt:        updatedAt(),
});

// ─── referrals ────────────────────────────────────────────────────────────────

export const referrals = pgTable("referrals", {
  id:         uid(),
  referrerId: text("referrer_id").notNull(),
  referredId: text("referred_id").notNull(),
  status:     text("status").default("pending"),  // pending|active|rewarded
  reward:     decimal("reward", { precision: 12, scale: 2 }).default("0"),
  createdAt:  createdAt(),
});

// ─── wallet_transactions ──────────────────────────────────────────────────────

export const walletTransactions = pgTable("wallet_transactions", {
  id:          uid(),
  userId:      text("user_id").notNull(),
  type:        text("type").notNull(),           // credit|debit|withdrawal|refund
  amount:      decimal("amount", { precision: 12, scale: 2 }).notNull(),
  reference:   text("reference"),
  description: text("description"),
  status:      text("status").default("completed"),
  createdAt:   createdAt(),
});

// ─── bank_accounts ────────────────────────────────────────────────────────────

export const bankAccounts = pgTable("bank_accounts", {
  id:            uid(),
  userId:        text("user_id").notNull(),
  bankCode:      text("bank_code").notNull(),
  bankName:      text("bank_name").notNull(),
  accountNumber: text("account_number").notNull(),
  accountName:   text("account_name").notNull(),
  isPrimary:     boolean("is_primary").default(false),
  createdAt:     createdAt(),
});

// ─── ads ─────────────────────────────────────────────────────────────────────

export const ads = pgTable("ads", {
  id:               uid(),
  userId:           text("user_id").notNull(),
  name:             text("name").notNull(),
  description:      text("description"),
  platforms:        jsonb("platforms").$type<string[]>().default(sql`'[]'::jsonb`),
  targetAudience:   text("target_audience"),
  budget:           decimal("budget", { precision: 12, scale: 2 }).default("0"),
  spent:            decimal("spent", { precision: 12, scale: 2 }).default("0"),
  status:           text("status").default("draft"),     // draft|active|paused
  impressions:      integer("impressions").default(0),
  clicks:           integer("clicks").default(0),
  leads:            integer("leads").default(0),
  imageUrl:         text("image_url"),
  videoUrl:         text("video_url"),
  paymentReference: text("payment_reference"),
  paymentProvider:  text("payment_provider"),
  startDate:        timestamp("start_date", { withTimezone: true }),
  endDate:          timestamp("end_date", { withTimezone: true }),
  createdAt:        createdAt(),
  updatedAt:        updatedAt(),
});

// ─── whatsapp_messages ────────────────────────────────────────────────────────

export const whatsappMessages = pgTable("whatsapp_messages", {
  id:                uid(),
  userId:            text("user_id").notNull(),
  customerPhone:     text("customer_phone").notNull(),
  direction:         text("direction").notNull(),   // inbound|outbound
  message:           text("message").notNull(),
  whatsappMessageId: text("whatsapp_message_id"),
  status:            text("status").default("sent"),
  createdAt:         createdAt(),
});

// ─── logistics_bookings ───────────────────────────────────────────────────────

export const logisticsBookings = pgTable("logistics_bookings", {
  id:                 uid(),
  userId:             text("user_id").notNull(),
  orderId:            text("order_id"),
  provider:           text("provider").notNull(),           // terminal_africa|kwik|sendbox|gig_logistics|gokada
  trackingId:         text("tracking_id"),
  trackingUrl:        text("tracking_url"),
  providerBookingId:  text("provider_booking_id"),
  packageDescription: text("package_description"),
  status:             text("status").default("pending"),
  pickupAddress:      text("pickup_address"),
  deliveryAddress:    text("delivery_address"),
  estimatedCost:      decimal("estimated_cost", { precision: 12, scale: 2 }),
  riderName:          text("rider_name"),
  riderPhone:         text("rider_phone"),
  vehicleType:        text("vehicle_type"),
  riderLat:           decimal("rider_lat", { precision: 10, scale: 7 }),
  riderLng:           decimal("rider_lng", { precision: 10, scale: 7 }),
  riderUpdatedAt:     timestamp("rider_updated_at"),
  createdAt:          createdAt(),
});

// ─── user_push_tokens ─────────────────────────────────────────────────────────

export const userPushTokens = pgTable("user_push_tokens", {
  id:        uid(),
  userId:    text("user_id").notNull(),
  token:     text("token").notNull(),
  platform:  text("platform").default("unknown"),
  createdAt: createdAt(),
}, (t) => [
  unique("uq_push_tokens_user_token").on(t.userId, t.token),
]);

// ─── newsletter_subscribers ───────────────────────────────────────────────────

export const newsletterSubscribers = pgTable("newsletter_subscribers", {
  id:         uid(),
  userId:     text("user_id").notNull(),
  email:      text("email").notNull(),
  name:       text("name"),
  phone:      text("phone"),
  source:     text("source").default("manual"),
  subscribed: boolean("subscribed").default(true).notNull(),
  createdAt:  createdAt(),
}, (t) => [
  unique("uq_newsletter_user_email").on(t.userId, t.email),
]);

// ─── support_messages ─────────────────────────────────────────────────────────

export const supportMessages = pgTable("support_messages", {
  id:        uid(),
  userId:    text("user_id").notNull(),
  subject:   text("subject"),
  message:   text("message").notNull(),
  status:    text("status").default("open"),    // open|replied
  reply:     text("reply"),
  createdAt: createdAt(),
});

// ─── customer_notes ───────────────────────────────────────────────────────────
// Vendor-private notes attached to a customer (identified by phone number).

export const customerNotes = pgTable("customer_notes", {
  id:            uid(),
  userId:        text("user_id").notNull(),      // vendor
  customerPhone: text("customer_phone").notNull(),
  note:          text("note").notNull(),
  tag:           text("tag"),                    // wholesale|vip|follow-up|loyal|high-value
  createdAt:     createdAt(),
});

// ─── product_reviews ──────────────────────────────────────────────────────────
// Buyer reviews for products — submitted from the shop storefront after purchase.

export const productReviews = pgTable("product_reviews", {
  id:          uid(),
  vendorId:    text("vendor_id").notNull(),
  productId:   text("product_id"),              // null for legacy/WhatsApp orders
  productName: text("product_name").notNull(),
  orderId:     text("order_id"),                // links to the verified purchase
  buyerEmail:  text("buyer_email"),
  buyerName:   text("buyer_name").notNull(),
  rating:      integer("rating").notNull(),     // 1–5
  body:        text("body"),
  photoUrls:   jsonb("photo_urls").$type<string[]>().default(sql`'[]'::jsonb`),
  status:      text("status").default("pending"), // pending|approved|hidden
  reply:       text("reply"),                   // seller's public reply
  createdAt:   createdAt(),
});

// ─── discounts ────────────────────────────────────────────────────────────────
// Vendor-created promo codes applied at checkout.

export const discounts = pgTable("discounts", {
  id:         uid(),
  vendorId:   text("vendor_id").notNull(),
  code:       text("code").notNull(),
  type:       text("type").notNull().default("percent"), // percent|fixed
  value:      decimal("value", { precision: 12, scale: 2 }).notNull(),
  minOrder:   decimal("min_order", { precision: 12, scale: 2 }).default("0"),
  maxUses:    integer("max_uses"),               // null = unlimited
  usesCount:  integer("uses_count").default(0),
  expiresAt:  timestamp("expires_at", { withTimezone: true }),
  active:     boolean("active").default(true),
  createdAt:  createdAt(),
}, (t) => [
  unique("uq_discount_vendor_code").on(t.vendorId, t.code),
]);

// ─── restock_alerts ───────────────────────────────────────────────────────────
// Customer subscribes to be notified when an out-of-stock product is restocked.

export const restockAlerts = pgTable("restock_alerts", {
  id:            uid(),
  productId:     text("product_id").notNull(),
  vendorId:      text("vendor_id").notNull(),
  customerPhone: text("customer_phone").notNull(),
  createdAt:     createdAt(),
}, (t) => [
  unique("uq_restock_alert").on(t.productId, t.customerPhone),
]);

// ─── contact_messages ────────────────────────────────────────────────────────
// Messages sent by customers through the Contact section on a vendor's storefront.

export const contactMessages = pgTable("contact_messages", {
  id:          uid(),
  userId:      text("user_id").notNull(),       // vendor receiving the message
  senderName:  text("sender_name").notNull(),
  senderEmail: text("sender_email"),
  subject:     text("subject"),
  message:     text("message").notNull(),
  read:        boolean("read").default(false),
  createdAt:   createdAt(),
});

// ─── buyer_referrals ──────────────────────────────────────────────────────────
// Each buyer who orders gets a unique referral code for that vendor's store.
// When someone else orders using their link, the original buyer gets rewarded.

export const buyerReferrals = pgTable("buyer_referrals", {
  id:         uid(),
  vendorId:   text("vendor_id").notNull(),
  buyerPhone: text("buyer_phone").notNull(),
  buyerName:  text("buyer_name").notNull(),
  code:       text("code").notNull().unique(),
  timesUsed:  integer("times_used").default(0),
  createdAt:  createdAt(),
}, (t) => [
  unique("uq_buyer_ref_vendor_phone").on(t.vendorId, t.buyerPhone),
]);

// ─── abandoned_carts ──────────────────────────────────────────────────────────
// Tracks visitor carts that were not checked out.
// A background job checks for carts idle > 1 hour and emails the buyer once.

export const abandonedCarts = pgTable("abandoned_carts", {
  id:            uid(),
  userId:        text("user_id").notNull(),          // vendor whose store this is
  sessionToken:  text("session_token").notNull(),    // anonymous cart session ID
  recoveryToken: text("recovery_token"),             // UUID sent in email link
  buyerEmail:    text("buyer_email"),
  buyerName:     text("buyer_name"),
  items:         jsonb("items").notNull(),            // Array<{id, name, price, imageUrl}>
  emailSentAt:   timestamp("email_sent_at", { withTimezone: true }),
  recoveredAt:   timestamp("recovered_at", { withTimezone: true }),
  createdAt:     createdAt(),
  updatedAt:     updatedAt(),
});

// ─── disputes ─────────────────────────────────────────────────────────────────
// Buyer↔vendor dispute audit log. While a row is `open`, the order's escrow is
// frozen (escrowStatus='disputed') so money cannot move. Admin resolves it.

export const disputes = pgTable("disputes", {
  id:            uid(),
  orderId:       text("order_id").notNull(),
  openedBy:      text("opened_by").notNull(),            // buyer_phone | vendor
  reason:        text("reason").notNull(),               // not_received | wrong_item | damaged | other
  description:   text("description"),
  evidence:      jsonb("evidence").$type<string[]>().default(sql`'[]'::jsonb`),
  status:        text("status").default("open"),         // open | resolved | escalated
  resolution:    text("resolution"),                     // release_to_merchant | refund_buyer
  resolvedById:  text("resolved_by_id"),
  resolutionNote: text("resolution_note"),
  createdAt:     createdAt(),
  updatedAt:     updatedAt(),
});

// ─── waitlist ─────────────────────────────────────────────────────────────────

export const waitlist = pgTable("waitlist", {
  id:        uid(),
  email:     text("email").notNull().unique(),
  phone:     text("phone"),
  name:      text("name"),
  createdAt: createdAt(),
});

// ─── app_settings ─────────────────────────────────────────────────────────────
// Platform-level key/value settings (admin managed). e.g. beta program switch.

export const appSettings = pgTable("app_settings", {
  key:       text("key").primaryKey(),
  value:     text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
