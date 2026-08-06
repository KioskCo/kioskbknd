/**
 * Gokada Delivery API service.
 *
 * Gokada is a Nigerian last-mile logistics provider (bikes + cars).
 * Docs: https://docs.gokada.ng (request API access from Gokada directly)
 *
 * Required environment variable:
 *   GOKADA_API_KEY — get from your Gokada business account
 *   GOKADA_BASE_URL — Gokada will provide this (default shown below)
 */

import { logger } from "./logger.js";

const API_KEY = process.env["GOKADA_API_KEY"] ?? "";
const BASE_URL = process.env["GOKADA_BASE_URL"] ?? "https://api.gokada.ng/v1";

function isConfigured(): boolean {
  return !!API_KEY;
}

function headers(): Record<string, string> {
  return {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

export interface GokadaRider {
  id: string;
  name: string;
  phone: string;
  vehicleType: string;
  rating: number;
  eta: number;
  distanceKm: number;
  priceNaira: number;
}

export interface GokadaBooking {
  bookingId: string;
  riderId: string;
  trackingUrl: string;
  status: string;
}

// ─── Search nearby Gokada riders ─────────────────────────────────────────────

export async function searchGokadaRiders(params: {
  pickupLat: number;
  pickupLng: number;
  deliveryLat: number;
  deliveryLng: number;
  vehicleType?: string;
}): Promise<GokadaRider[]> {
  if (!isConfigured()) {
    logger.warn("Gokada not configured — GOKADA_API_KEY missing");
    return [];
  }

  try {
    const res = await fetch(`${BASE_URL}/riders/available`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        pickup: { lat: params.pickupLat, lng: params.pickupLng },
        delivery: { lat: params.deliveryLat, lng: params.deliveryLng },
        vehicle_type: params.vehicleType ?? "bike",
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Gokada rider search failed");
      return [];
    }

    const data = await res.json() as { data?: any[]; riders?: any[] };
    const riders = data.data ?? data.riders ?? [];

    return riders.map((r: any) => ({
      id: String(r.id ?? r.rider_id),
      name: r.name ?? r.rider_name ?? "Gokada Rider",
      phone: r.phone ?? r.phone_number ?? "",
      vehicleType: r.vehicle_type ?? r.vehicleType ?? "bike",
      rating: parseFloat(r.rating ?? "4.5"),
      eta: r.eta ?? r.estimated_time ?? 15,
      distanceKm: r.distance ?? r.distance_km ?? 0,
      priceNaira: r.price ?? r.amount ?? 0,
    }));
  } catch (err) {
    logger.error({ err }, "Gokada rider search error");
    return [];
  }
}

// ─── Book a Gokada rider ──────────────────────────────────────────────────────

export async function bookGokadaRider(params: {
  riderId: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  recipientName: string;
  recipientPhone: string;
  packageDescription?: string;
}): Promise<GokadaBooking> {
  if (!isConfigured()) {
    throw new Error("Gokada not configured. Add GOKADA_API_KEY to your environment.");
  }

  const res = await fetch(`${BASE_URL}/bookings`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      rider_id: params.riderId,
      pickup: {
        address: params.pickupAddress,
        lat: params.pickupLat,
        lng: params.pickupLng,
      },
      delivery: {
        address: params.deliveryAddress,
        lat: params.deliveryLat,
        lng: params.deliveryLng,
        recipient_name: params.recipientName,
        recipient_phone: params.recipientPhone,
      },
      package_description: params.packageDescription ?? "Package",
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Gokada booking failed (${res.status})`);
  }

  const data = await res.json() as { data?: any };
  const b = data.data ?? data;

  return {
    bookingId: String(b.id ?? b.booking_id),
    riderId: params.riderId,
    trackingUrl: b.tracking_url ?? b.trackingUrl ?? "",
    status: b.status ?? "booked",
  };
}

// ─── Ping a Gokada rider ──────────────────────────────────────────────────────

export async function pingGokadaRider(riderId: string, message?: string): Promise<{ sent: boolean }> {
  if (!isConfigured()) return { sent: false };

  try {
    await fetch(`${BASE_URL}/riders/${riderId}/notify`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ message: message ?? "A merchant is interested in booking you." }),
    });
    return { sent: true };
  } catch {
    return { sent: false };
  }
}
