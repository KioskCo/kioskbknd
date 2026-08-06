/**
 * Sendbox Delivery API service.
 *
 * Sendbox is a Nigerian multi-carrier logistics platform (inter-city + last-mile).
 * Docs: https://api.sendbox.co/docs
 *
 * Required environment variable:
 *   SENDBOX_API_KEY — get from app.sendbox.co → Settings → API Keys
 *   SENDBOX_SECRET_KEY — also from the same settings page
 */

import { logger } from "./logger.js";

const API_KEY    = process.env["SENDBOX_API_KEY"]    ?? "";
const SECRET_KEY = process.env["SENDBOX_SECRET_KEY"] ?? "";
const BASE_URL   = "https://api.sendbox.co";

function isConfigured(): boolean {
  return !!(API_KEY && SECRET_KEY);
}

function headers(): Record<string, string> {
  return {
    "Authorization": `Bearer ${API_KEY}`,
    "X-API-SECRET": SECRET_KEY,
    "Content-Type": "application/json",
  };
}

export interface SendboxRate {
  carrierId: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  estimatedDays: number;
  fee: number;
  currency: string;
}

export interface SendboxShipment {
  shipmentId: string;
  trackingId: string;
  trackingUrl: string;
  carrierId: string;
  status: string;
  estimatedDelivery: string;
}

// ─── Get Sendbox shipping rates ───────────────────────────────────────────────

export async function getSendboxRates(params: {
  pickupState: string;
  pickupCity: string;
  deliveryState: string;
  deliveryCity: string;
  weightKg: number;
}): Promise<SendboxRate[]> {
  if (!isConfigured()) {
    logger.warn("Sendbox not configured — SENDBOX_API_KEY or SENDBOX_SECRET_KEY missing");
    return [];
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/delivery/rates`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        origin: { state: params.pickupState, city: params.pickupCity, country: "NG" },
        destination: { state: params.deliveryState, city: params.deliveryCity, country: "NG" },
        parcel: { weight: params.weightKg * 1000 }, // sendbox uses grams
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Sendbox rate fetch failed");
      return [];
    }

    const data = await res.json() as { data?: any[]; rates?: any[] };
    const rates = data.data ?? data.rates ?? [];

    return rates.map((r: any) => ({
      carrierId: String(r.carrier_id ?? r.carrierId ?? r.id),
      carrierName: r.carrier ?? r.carrier_name ?? "Sendbox",
      serviceCode: r.service_code ?? r.serviceCode ?? "standard",
      serviceName: r.service ?? r.service_name ?? "Standard Delivery",
      estimatedDays: r.days ?? r.estimated_days ?? 3,
      fee: parseFloat(r.fee ?? r.amount ?? r.price ?? "0"),
      currency: "NGN",
    }));
  } catch (err) {
    logger.error({ err }, "Sendbox rate fetch error");
    return [];
  }
}

// ─── Create a Sendbox shipment ────────────────────────────────────────────────

export async function createSendboxShipment(params: {
  carrierId: string;
  serviceCode: string;
  pickupAddress: string;
  pickupCity: string;
  pickupState: string;
  pickupPhone: string;
  pickupName: string;
  pickupEmail?: string;
  deliveryAddress: string;
  deliveryCity: string;
  deliveryState: string;
  recipientName: string;
  recipientPhone: string;
  recipientEmail?: string;
  weightKg: number;
  description: string;
  declaredValue?: number;
}): Promise<SendboxShipment> {
  if (!isConfigured()) {
    throw new Error("Sendbox not configured. Add SENDBOX_API_KEY and SENDBOX_SECRET_KEY to your environment.");
  }

  const res = await fetch(`${BASE_URL}/v1/delivery/shipments`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      carrier_id: params.carrierId,
      service_code: params.serviceCode,
      origin: {
        address: params.pickupAddress,
        city: params.pickupCity,
        state: params.pickupState,
        country: "NG",
        contact_name: params.pickupName,
        contact_phone: params.pickupPhone,
        contact_email: params.pickupEmail,
      },
      destination: {
        address: params.deliveryAddress,
        city: params.deliveryCity,
        state: params.deliveryState,
        country: "NG",
        contact_name: params.recipientName,
        contact_phone: params.recipientPhone,
        contact_email: params.recipientEmail,
      },
      parcel: {
        weight: params.weightKg * 1000,
        description: params.description,
        declared_value: params.declaredValue ?? 0,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Sendbox shipment creation failed (${res.status})`);
  }

  const data = await res.json() as { data?: any };
  const s = data.data ?? data;

  return {
    shipmentId: String(s.id ?? s.shipment_id),
    trackingId: s.tracking_id ?? s.tracking_number ?? String(s.id),
    trackingUrl: s.tracking_url ?? `https://app.sendbox.co/tracking/${s.tracking_id ?? s.id}`,
    carrierId: params.carrierId,
    status: s.status ?? "created",
    estimatedDelivery: s.estimated_delivery ?? s.delivery_date ?? "",
  };
}

// ─── Track a Sendbox shipment ─────────────────────────────────────────────────

export async function trackSendboxShipment(trackingId: string): Promise<{ status: string; events: any[] }> {
  if (!isConfigured()) {
    return { status: "unknown", events: [] };
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/delivery/track/${trackingId}`, {
      headers: headers(),
    });

    if (!res.ok) return { status: "unknown", events: [] };

    const data = await res.json() as { data?: any };
    const d = data.data ?? data;

    return {
      status: d.status ?? "unknown",
      events: d.events ?? d.tracking_events ?? [],
    };
  } catch {
    return { status: "unknown", events: [] };
  }
}
