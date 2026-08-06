/**
 * GIG Logistics (GIGL) API service.
 *
 * GIG Logistics is Nigeria's largest courier company — nationwide door-to-door
 * delivery covering all 36 states. Bikes, vans, and trucks.
 *
 * Docs / access: giglogistics.com → Corporate Portal → API Access
 *
 * Required environment variables:
 *   GIG_API_USERNAME — corporate account email
 *   GIG_API_PASSWORD — corporate account password
 *   GIG_API_KEY      — optional static partner API key (some tiers use this instead)
 */

import { logger } from "./logger.js";

const USERNAME = process.env["GIG_API_USERNAME"] ?? "";
const PASSWORD = process.env["GIG_API_PASSWORD"] ?? "";
const API_KEY  = process.env["GIG_API_KEY"]      ?? "";
const BASE_URL = "https://api.gigl-go.com";

let cachedToken: string | null = null;
let tokenExpiry  = 0;

function isConfigured(): boolean {
  return !!((USERNAME && PASSWORD) || API_KEY);
}

async function getAuthToken(): Promise<string> {
  if (API_KEY) return API_KEY;

  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${BASE_URL}/api/Auth/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, Password: PASSWORD }),
  });

  if (!res.ok) throw new Error(`GIG auth failed (${res.status})`);

  const data = await res.json() as { Object?: { access_token?: string; expires_in?: number } };
  const token = data.Object?.access_token;
  if (!token) throw new Error("GIG auth: no access_token in response");

  cachedToken = token;
  tokenExpiry  = Date.now() + ((data.Object?.expires_in ?? 3600) - 60) * 1000;
  return token;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GigRate {
  serviceType: string;     // "Regular" | "Express" | "Cargo"
  serviceName: string;
  estimatedDays: number;
  fee: number;
  currency: string;
}

export interface GigShipment {
  waybillNumber: string;
  shipmentId: string;
  trackingUrl: string;
  status: string;
  estimatedDelivery: string;
  fee: number;
}

export interface GigTrackingEvent {
  status: string;
  location: string;
  timestamp: string;
  description: string;
}

// ─── Get shipping rates/quote ─────────────────────────────────────────────────

export async function getGigRates(params: {
  originServiceCentre?: string;
  destinationServiceCentre?: string;
  pickupCity: string;
  pickupState: string;
  deliveryCity: string;
  deliveryState: string;
  weightKg: number;
  declaredValue?: number;
}): Promise<GigRate[]> {
  if (!isConfigured()) {
    logger.warn("GIG Logistics not configured — GIG_API_USERNAME/PASSWORD or GIG_API_KEY missing");
    return [];
  }

  try {
    const hdrs = await authHeaders();
    const res = await fetch(`${BASE_URL}/api/Shipment/GetShipmentQuote`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({
        DepartureServiceCentreCode: params.originServiceCentre ?? params.pickupState.toUpperCase().slice(0, 3),
        DestinationServiceCentreCode: params.destinationServiceCentre ?? params.deliveryState.toUpperCase().slice(0, 3),
        Weight: params.weightKg,
        ShipmentType: "Regular",
        DeclaredValue: params.declaredValue ?? 0,
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "GIG rate fetch failed");
      return [];
    }

    const data = await res.json() as { Object?: any; object?: any };
    const obj = data.Object ?? data.object ?? {};
    const prices: any[] = obj.Prices ?? obj.prices ?? [obj];

    return prices.map((p: any) => ({
      serviceType: p.ShipmentType ?? p.shipmentType ?? "Regular",
      serviceName: p.Description ?? p.description ?? "GIG Standard Delivery",
      estimatedDays: p.EstimatedDeliveryDays ?? p.days ?? 3,
      fee: parseFloat(p.Amount ?? p.amount ?? p.Price ?? p.price ?? "0"),
      currency: "NGN",
    }));
  } catch (err) {
    logger.error({ err }, "GIG rate fetch error");
    return [];
  }
}

// ─── Create a shipment ────────────────────────────────────────────────────────

export async function createGigShipment(params: {
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
  serviceType?: string;
  paymentType?: "Prepaid" | "POD";
}): Promise<GigShipment> {
  if (!isConfigured()) {
    throw new Error("GIG Logistics not configured. Add GIG_API_USERNAME and GIG_API_PASSWORD to your environment.");
  }

  const hdrs = await authHeaders();

  const senderParts = params.pickupName.trim().split(" ");
  const recipientParts = params.recipientName.trim().split(" ");

  const res = await fetch(`${BASE_URL}/api/Shipment/CreateShipment`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      SenderAddress: params.pickupAddress,
      SenderCity: params.pickupCity,
      SenderState: params.pickupState,
      SenderPhoneNumber: params.pickupPhone,
      SenderName: params.pickupName,
      SenderEmail: params.pickupEmail ?? "",

      ReceiverAddress: params.deliveryAddress,
      ReceiverCity: params.deliveryCity,
      ReceiverState: params.deliveryState,
      ReceiverPhoneNumber: params.recipientPhone,
      ReceiverFirstName: recipientParts[0] ?? params.recipientName,
      ReceiverLastName: recipientParts.slice(1).join(" ") || "",
      ReceiverEmail: params.recipientEmail ?? "",

      Weight: params.weightKg,
      Description: params.description,
      DeclaredValue: params.declaredValue ?? 0,
      ShipmentType: params.serviceType ?? "Regular",
      PaymentType: params.paymentType ?? "Prepaid",
      IsFromMobile: false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { ShortDescription?: string; message?: string };
    throw new Error(err.ShortDescription ?? err.message ?? `GIG shipment creation failed (${res.status})`);
  }

  const data = await res.json() as { Object?: any; object?: any };
  const s = data.Object ?? data.object ?? data;

  const waybill = String(s.WaybillNumber ?? s.waybillNumber ?? s.WayBillNumber ?? s.id ?? Date.now());

  return {
    waybillNumber: waybill,
    shipmentId: String(s.ShipmentId ?? s.shipmentId ?? waybill),
    trackingUrl: `https://giglogistics.com/track/${waybill}`,
    status: s.Status ?? s.status ?? "created",
    estimatedDelivery: s.EstimatedDeliveryDate ?? s.estimatedDelivery ?? "",
    fee: parseFloat(s.GrandTotal ?? s.Amount ?? s.fee ?? "0"),
  };
}

// ─── Track a shipment ─────────────────────────────────────────────────────────

export async function trackGigShipment(waybillNumber: string): Promise<{
  status: string;
  events: GigTrackingEvent[];
}> {
  if (!isConfigured()) {
    return { status: "unknown", events: [] };
  }

  try {
    const hdrs = await authHeaders();
    const res = await fetch(`${BASE_URL}/api/Shipment/TrackShipment/${encodeURIComponent(waybillNumber)}`, {
      headers: hdrs,
    });

    if (!res.ok) return { status: "unknown", events: [] };

    const data = await res.json() as { Object?: any; object?: any };
    const obj = data.Object ?? data.object ?? {};
    const events: any[] = obj.TrackingHistory ?? obj.trackingHistory ?? [];
    const currentStatus: string = obj.Status ?? obj.status ?? events[0]?.Status ?? "in_transit";

    return {
      status: currentStatus.toLowerCase().replace(/\s+/g, "_"),
      events: events.map((e: any) => ({
        status: e.Status ?? e.status ?? "",
        location: e.Location ?? e.location ?? e.ServiceCentre ?? "",
        timestamp: e.DateTime ?? e.datetime ?? e.CreatedDate ?? "",
        description: e.Remark ?? e.remark ?? e.Status ?? "",
      })),
    };
  } catch (err) {
    logger.error({ err }, "GIG track error");
    return { status: "unknown", events: [] };
  }
}
