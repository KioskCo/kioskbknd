/**
 * Terminal Africa logistics service.
 *
 * Terminal Africa aggregates multiple Nigerian couriers under one API.
 * Docs: https://docs.terminal.africa/
 *
 * Required environment variable:
 *   TERMINAL_AFRICA_API_KEY — get from https://app.terminal.africa/settings/api
 */

import { logger } from "./logger";

const API_KEY = process.env["TERMINAL_AFRICA_API_KEY"] ?? "";
const BASE_URL = "https://api.terminal.africa/v1";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Address {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  line1: string;         // Street address
  city: string;
  state: string;
  country: string;       // e.g. "NG"
}

export interface RateResult {
  carrierId: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  estimatedDays: number;
  fee: number;           // in Naira
  currency: string;
}

export interface ShipmentResult {
  shipmentId: string;
  trackingNumber: string;
  labelUrl: string;
  carrierId: string;
  fee: number;
}

export interface TrackingEvent {
  timestamp: string;
  status: string;
  location: string;
  description: string;
}

// ─── Get available rates ──────────────────────────────────────────────────────

export async function getRates(params: {
  pickup: Address;
  delivery: Address;
  weightKg: number;
}): Promise<RateResult[]> {
  if (!API_KEY) {
    logger.warn("TERMINAL_AFRICA_API_KEY not set — returning mock rates");
    return [
      { carrierId: "mock-dhl", carrierName: "DHL Express", serviceCode: "dhl-express", serviceName: "Express Delivery", estimatedDays: 1, fee: 3500, currency: "NGN" },
      { carrierId: "mock-gig", carrierName: "GIG Logistics", serviceCode: "gig-standard", serviceName: "Standard Delivery", estimatedDays: 2, fee: 1800, currency: "NGN" },
      { carrierId: "mock-ups", carrierName: "UPS", serviceCode: "ups-standard", serviceName: "Standard", estimatedDays: 3, fee: 2200, currency: "NGN" },
    ];
  }

  const res = await fetch(`${BASE_URL}/rates`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      pickup_address: {
        first_name: params.pickup.firstName,
        last_name: params.pickup.lastName,
        email: params.pickup.email,
        phone: params.pickup.phone,
        line1: params.pickup.line1,
        city: params.pickup.city,
        state: params.pickup.state,
        country: params.pickup.country,
      },
      delivery_address: {
        first_name: params.delivery.firstName,
        last_name: params.delivery.lastName,
        email: params.delivery.email,
        phone: params.delivery.phone,
        line1: params.delivery.line1,
        city: params.delivery.city,
        state: params.delivery.state,
        country: params.delivery.country,
      },
      weight: params.weightKg,
      currency: "NGN",
    }),
  });

  const body = (await res.json()) as {
    status: boolean;
    data: Array<{
      carrier_id: string;
      carrier: { name: string };
      service_code: string;
      service_name: string;
      delivery_eta: number;
      amount: number;
      currency: string;
    }>;
  };

  if (!body.status) {
    logger.error({ body }, "Terminal Africa rates failed");
    throw new Error("Failed to fetch shipping rates");
  }

  return body.data.map((r) => ({
    carrierId: r.carrier_id,
    carrierName: r.carrier.name,
    serviceCode: r.service_code,
    serviceName: r.service_name,
    estimatedDays: r.delivery_eta,
    fee: r.amount,
    currency: r.currency,
  }));
}

// ─── Create a shipment ────────────────────────────────────────────────────────

export async function createShipment(params: {
  pickup: Address;
  delivery: Address;
  carrierId: string;
  serviceCode: string;
  parcels: Array<{ weightKg: number; description: string }>;
}): Promise<ShipmentResult> {
  if (!API_KEY) {
    const mockTrackingNumber = `TA${Date.now().toString().slice(-8)}`;
    return {
      shipmentId: `mock-shipment-${Date.now()}`,
      trackingNumber: mockTrackingNumber,
      labelUrl: `https://terminal.africa/label/${mockTrackingNumber}`,
      carrierId: params.carrierId,
      fee: 2500,
    };
  }

  const res = await fetch(`${BASE_URL}/shipments`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      pickup_address: params.pickup,
      delivery_address: params.delivery,
      carrier_id: params.carrierId,
      service_code: params.serviceCode,
      parcels: params.parcels.map((p) => ({
        weight: p.weightKg,
        description: p.description,
      })),
      currency: "NGN",
    }),
  });

  const body = (await res.json()) as {
    status: boolean;
    data: {
      id: string;
      tracking_number: string;
      label_url: string;
      carrier_id: string;
      amount: number;
    };
  };

  if (!body.status) {
    logger.error({ body }, "Terminal Africa shipment creation failed");
    throw new Error("Failed to create shipment");
  }

  return {
    shipmentId: body.data.id,
    trackingNumber: body.data.tracking_number,
    labelUrl: body.data.label_url,
    carrierId: body.data.carrier_id,
    fee: body.data.amount,
  };
}

// ─── Track a shipment ─────────────────────────────────────────────────────────

export async function trackShipment(trackingNumber: string): Promise<TrackingEvent[]> {
  if (!API_KEY) {
    return [
      { timestamp: new Date().toISOString(), status: "in_transit", location: "Lagos Hub", description: "Package received at sorting facility" },
      { timestamp: new Date(Date.now() - 3600000).toISOString(), status: "picked_up", location: "Pickup Point", description: "Package collected from sender" },
    ];
  }

  const res = await fetch(`${BASE_URL}/shipments/${trackingNumber}/tracking`, {
    headers: headers(),
  });

  const body = (await res.json()) as {
    status: boolean;
    data: Array<{
      timestamp: string;
      status: string;
      location: string;
      description: string;
    }>;
  };

  if (!body.status) {
    logger.error({ body }, "Terminal Africa tracking failed");
    throw new Error("Failed to track shipment");
  }

  return body.data;
}
