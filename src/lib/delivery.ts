/**
 * Location-aware delivery charges.
 *
 * Delivery is priced by zone so merchants can quote accurately:
 *   - LAGOS_ZONE   = within Lagos (local delivery, cheaper/faster)
 *   - OTHER_ZONE   = any other Nigerian state (inter-state, more expensive)
 *
 * The zone is derived from the buyer's state (or city as a fallback) sent at
 * checkout. Vendors can override the default rates and the free-delivery
 * threshold from the kioskm app (see `delivery_fee_lagos`,
 * `delivery_fee_other`, `free_delivery_threshold` on `users`).
 */

export const DEFAULT_DELIVERY_FEES = {
  LAGOS: 1_500,
  OTHER: 3_500,
  FREE_THRESHOLD: 15_000,
} as const;

export type DeliveryZone = "LAGOS" | "OTHER";

/** Per-vendor delivery config, mirroring the `users` columns. */
export interface VendorDeliveryConfig {
  feeLagos?: number | null;
  feeOther?: number | null;
  freeThreshold?: number | null;
}

const LAGOS_CITIES = new Set([
  "lagos", "ikeja", "victoria island", "lekki", "ajah", "surulere", "yaba",
  "mainland", "festac", "badagry", "epe", "ipaja", "ikorodu", "oshodi", "ikotun",
]);

/** Normalise an arbitrary location string to lower-case, trimmed. */
function norm(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

/** Decide the delivery zone from the buyer's state and city. */
export function resolveDeliveryZone(state?: string | null, city?: string | null): DeliveryZone {
  if (norm(state) === "lagos" || LAGOS_CITIES.has(norm(city))) {
    return "LAGOS";
  }
  return "OTHER";
}

/** Compute the flat delivery fee for a subtotal, zone and optional vendor config. */
export function computeDeliveryFee(
  subtotal: number,
  zone: DeliveryZone,
  config?: VendorDeliveryConfig,
): number {
  const threshold = config?.freeThreshold != null && config.freeThreshold > 0
    ? config.freeThreshold
    : DEFAULT_DELIVERY_FEES.FREE_THRESHOLD;
  if (subtotal <= 0 || subtotal >= threshold) return 0;

  const rate = zone === "LAGOS"
    ? config?.feeLagos ?? DEFAULT_DELIVERY_FEES.LAGOS
    : config?.feeOther ?? DEFAULT_DELIVERY_FEES.OTHER;
  return Math.max(0, rate);
}