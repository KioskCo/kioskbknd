/**
 * Kwik Delivery API service.
 *
 * Kwik is a last-mile delivery platform popular in Nigeria.
 * Docs: https://developer.kwikdelivery.com
 *
 * Required environment variable:
 *   KWIK_API_KEY — get from your Kwik merchant dashboard
 */

import { logger } from "./logger";

const API_KEY = process.env["KWIK_API_KEY"] ?? "";
const BASE_URL = "https://api.kwikdelivery.com/api/v1";

function headers(): Record<string, string> {
  return {
    "api-key": API_KEY,
    "Content-Type": "application/json",
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KwikRider {
  id: string;
  name: string;
  phone: string;
  vehicleType: string;    // bike | car | van | truck
  rating: number;
  eta: number;            // estimated arrival in minutes
  distanceKm: number;
  priceNaira: number;
  location?: string;    // human-readable area name (mock/dev riders only)
}

export interface KwikBooking {
  bookingId: string;
  riderId: string;
  trackingUrl: string;
  estimatedPickup: string;  // ISO datetime
  fee: number;
}

// ─── Search nearby riders ────────────────────────────────────────────────────

export async function searchNearbyRiders(params: {
  pickupLat: number;
  pickupLng: number;
  deliveryLat: number;
  deliveryLng: number;
  vehicleType?: string;    // "bike" | "car" | "van" | "truck"
}): Promise<KwikRider[]> {
  if (!API_KEY) {
    logger.warn("KWIK_API_KEY not set — returning mock riders");
    // Return realistic mock Nigerian riders for development
    return [
      { id: "rider-1", name: "Emeka Okonkwo", phone: "+2348012345001", vehicleType: "bike", rating: 4.8, eta: 8,  distanceKm: 1.2, priceNaira: 800,  location: "Yaba, Lagos" },
      { id: "rider-2", name: "Tunde Adeyemi", phone: "+2348012345002", vehicleType: "bike", rating: 4.6, eta: 12, distanceKm: 2.1, priceNaira: 1000, location: "Surulere, Lagos" },
      { id: "rider-3", name: "Chidi Nwosu",   phone: "+2348012345003", vehicleType: "car",  rating: 4.9, eta: 15, distanceKm: 2.8, priceNaira: 2200, location: "Victoria Island, Lagos" },
      { id: "rider-4", name: "Femi Adeola",   phone: "+2348012345004", vehicleType: "bike", rating: 4.5, eta: 20, distanceKm: 3.5, priceNaira: 1200, location: "Ikeja, Lagos" },
      { id: "rider-5", name: "Biodun Okafor", phone: "+2348012345005", vehicleType: "van",  rating: 4.7, eta: 25, distanceKm: 4.0, priceNaira: 3500, location: "Lekki, Lagos" },
    ];
  }

  const res = await fetch(`${BASE_URL}/riders/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      pickup_coordinates: { lat: params.pickupLat, lng: params.pickupLng },
      delivery_coordinates: { lat: params.deliveryLat, lng: params.deliveryLng },
      vehicle_type: params.vehicleType ?? "bike",
    }),
  });

  const body = (await res.json()) as {
    success: boolean;
    data: Array<{
      id: string;
      name: string;
      phone_number: string;
      vehicle_type: string;
      rating: number;
      eta_minutes: number;
      distance_km: number;
      price: number;
    }>;
  };

  if (!body.success) {
    logger.error({ body }, "Kwik rider search failed");
    throw new Error("Failed to search riders");
  }

  return body.data.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone_number,
    vehicleType: r.vehicle_type,
    rating: r.rating,
    eta: r.eta_minutes,
    distanceKm: r.distance_km,
    priceNaira: r.price,
  }));
}

// ─── Book a rider ─────────────────────────────────────────────────────────────

export async function bookRider(params: {
  riderId: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  recipientName: string;
  recipientPhone: string;
  packageDescription: string;
  orderReference: string;
}): Promise<KwikBooking> {
  if (!API_KEY) {
    return {
      bookingId: `kwik-booking-${Date.now()}`,
      riderId: params.riderId,
      trackingUrl: `https://track.kwikdelivery.com/dev-${Date.now()}`,
      estimatedPickup: new Date(Date.now() + 15 * 60000).toISOString(),
      fee: 1000,
    };
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
      package_description: params.packageDescription,
      order_reference: params.orderReference,
    }),
  });

  const body = (await res.json()) as {
    success: boolean;
    data: {
      booking_id: string;
      rider_id: string;
      tracking_url: string;
      estimated_pickup: string;
      fee: number;
    };
  };

  if (!body.success) {
    logger.error({ body }, "Kwik booking failed");
    throw new Error("Failed to book rider");
  }

  return {
    bookingId: body.data.booking_id,
    riderId: body.data.rider_id,
    trackingUrl: body.data.tracking_url,
    estimatedPickup: body.data.estimated_pickup,
    fee: body.data.fee,
  };
}

// ─── Ping a rider (pre-booking interest) ─────────────────────────────────────

export async function pingRider(riderId: string, message: string): Promise<{ sent: boolean }> {
  if (!API_KEY) {
    logger.info({ riderId, message }, "Mock rider pinged");
    return { sent: true };
  }

  const res = await fetch(`${BASE_URL}/riders/${riderId}/ping`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ message }),
  });

  const body = (await res.json()) as { success: boolean };
  return { sent: body.success };
}
