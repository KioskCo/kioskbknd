/**
 * Email service — sends transactional emails via SMTP (nodemailer).
 *
 * Required environment variables:
 *   SMTP_HOST       — e.g. smtp.gmail.com or smtp.sendgrid.net
 *   SMTP_PORT       — typically 587 (TLS) or 465 (SSL)
 *   SMTP_USER       — SMTP username / email address
 *   SMTP_PASS       — SMTP password or app password
 *   SMTP_FROM       — "display name <email>" for the From header
 *
 * Falls back to console logging when SMTP_HOST is not configured (dev mode).
 */

import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { logger } from "./logger.js";

const SMTP_HOST = process.env["SMTP_HOST"] ?? "";
const SMTP_PORT = parseInt(process.env["SMTP_PORT"] ?? "587", 10);
const SMTP_USER = process.env["SMTP_USER"] ?? "";
const SMTP_PASS = process.env["SMTP_PASS"] ?? "";
const SMTP_FROM = process.env["SMTP_FROM"] ?? "Kiosk <noreply@keeosk.store>";

// Resolve the SMTP host to an IPv4 address up front. Hosts like smtp.gmail.com
// advertise both A and AAAA records; environments without IPv6 routing (e.g.
// Railway containers) fail with ENETUNREACH when nodemailer picks an IPv6
// address. The original hostname is kept as the TLS servername (SNI) so
// certificate validation still works against a raw IP.
async function createTransport(): Promise<Transporter | null> {
  if (!SMTP_HOST) return null;

  let host = SMTP_HOST;
  let servername: string | undefined;
  if (!isIP(host)) {
    try {
      // dns.lookup uses the OS resolver (getaddrinfo) rather than Node's
      // c-ares resolver, so it matches whatever the container's DNS actually
      // serves and is far less likely to fail in managed environments.
      const { address } = await dns.lookup(host, { family: 4 });
      if (address) {
        servername = host;
        host = address;
      }
    } catch {
      // Fall back to the hostname; nodemailer's own resolver will retry.
    }
  }

  return nodemailer.createTransport({
    host,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: servername ? { servername } : undefined,
    // Fail fast instead of hanging if the network silently blocks SMTP.
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 15000,
  });
}

let transportPromise: Promise<Transporter | null> | null = null;
function getTransport(): Promise<Transporter | null> {
  if (!transportPromise) transportPromise = createTransport();
  return transportPromise;
}

export async function sendMail(
  to: string,
  subject: string,
  html: string,
  options?: { messageId?: string; inReplyTo?: string; references?: string }
): Promise<void> {
  const transport = await getTransport();
  if (!transport) {
    logger.warn({ to, subject }, "Email not configured — message logged only");
    logger.info({ to, subject, html }, "DEV email output");
    return;
  }
  await transport.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    html,
    messageId: options?.messageId,
    inReplyTo: options?.inReplyTo,
    references: options?.references,
  });
}

// ─── Send signup OTP ──────────────────────────────────────────────────────────

export async function sendSignupOtpEmail(email: string, otp: string): Promise<void> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
      <h2 style="color:#0a0a0a;margin-bottom:8px">Verify your email</h2>
      <p style="color:#555;margin-bottom:24px">Enter this code to complete your Kiosk signup:</p>
      <div style="background:#f4f4f5;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#0a0a0a">${otp}</span>
      </div>
      <p style="color:#888;font-size:13px">This code expires in 10 minutes. Do not share it with anyone.</p>
      <p style="color:#888;font-size:13px;margin-top:8px">If you didn't create a Kiosk account, you can safely ignore this email.</p>
    </div>
  `;
  await sendMail(email, "Your Kiosk verification code", html);
  logger.info({ email }, "Signup OTP email sent");
}

// ─── Send escrow release PIN to buyer ────────────────────────────────────────
// Buyer receives this PIN, gives it to the vendor on delivery to release payment.

export async function sendEscrowPinEmail(params: {
  email: string;
  buyerName: string;
  orderNumber: string;
  storeName: string;
  pin: string;
}): Promise<void> {
  const { email, buyerName, orderNumber, storeName, pin } = params;
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
      <h2 style="color:#0a0a0a;margin-bottom:8px">Your delivery PIN</h2>
      <p style="color:#555;margin-bottom:24px">
        Hi ${buyerName}, your order from <strong>${storeName}</strong> is confirmed and payment is secured in escrow.
      </p>
      <p style="color:#555;margin-bottom:16px">
        When your order arrives, give this <strong>4-digit PIN</strong> to the vendor to confirm delivery and release payment:
      </p>
      <div style="background:#f4f4f5;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:48px;font-weight:700;letter-spacing:12px;color:#0a0a0a">${pin}</span>
      </div>
      <p style="color:#888;font-size:13px">Order: <strong>${orderNumber}</strong></p>
      <p style="color:#e11d48;font-size:13px;margin-top:8px">
        Only share this PIN when you have physically received your order and are satisfied with it.
        Once given, payment is released to the vendor and cannot be reversed.
      </p>

      <div style="margin-top:24px;text-align:center">
        <a href="${process.env["SHOP_BASE_URL"]?.replace("/@", "/order/") ?? "https://keeosk.store/order/"}${orderNumber}"
           style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:999px;font-size:14px;font-weight:600">
          Track your order
        </a>
      </div>
    </div>
  `;
  await sendMail(email, `Your delivery PIN — ${orderNumber}`, html);
  logger.info({ email, orderNumber }, "Escrow PIN email sent to buyer");
}

// ─── Send buyer order confirmation ───────────────────────────────────────────

export async function sendOrderConfirmationEmail(params: {
  email: string;
  buyerName: string;
  orderNumber: string;
  storeName: string;
  items: Array<{ name: string; qty: number; unitPrice: string }>;
  totalAmount: string;
  deliveryAddress: string;
}): Promise<void> {
  const { email, buyerName, orderNumber, storeName, items, totalAmount, deliveryAddress } = params;
  const itemRows = items.map((i) =>
    `<tr>
      <td style="padding:8px 0;color:#0a0a0a;border-bottom:1px solid #f0f0f0">${i.name}</td>
      <td style="padding:8px 0;color:#555;text-align:center;border-bottom:1px solid #f0f0f0">×${i.qty}</td>
      <td style="padding:8px 0;color:#0a0a0a;text-align:right;border-bottom:1px solid #f0f0f0">₦${Number(i.unitPrice).toLocaleString()}</td>
    </tr>`
  ).join("");

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px">
      <h2 style="color:#0a0a0a;margin-bottom:4px">Order confirmed</h2>
      <p style="color:#555;margin-bottom:24px">Hi ${buyerName}, your order from <strong>${storeName}</strong> has been placed.</p>

      <div style="background:#f4f4f5;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <p style="margin:0;font-size:13px;color:#888">Order number</p>
        <p style="margin:4px 0 0;font-size:18px;font-weight:700;letter-spacing:1px;color:#0a0a0a">${orderNumber}</p>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="padding:12px 0;font-weight:600;color:#0a0a0a">Total</td>
            <td style="padding:12px 0;font-weight:700;font-size:16px;text-align:right;color:#0a0a0a">₦${Number(totalAmount).toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>

      <p style="color:#555;font-size:13px"><strong>Delivery to:</strong> ${deliveryAddress}</p>

      <div style="margin-top:24px;text-align:center">
        <a href="${process.env["SHOP_BASE_URL"]?.replace("/@", "/order/") ?? "https://keeosk.store/order/"}${orderNumber}"
           style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:999px;font-size:14px;font-weight:600">
          Track your order
        </a>
      </div>

      <p style="color:#888;font-size:12px;margin-top:24px;text-align:center">
        Order: <strong>${orderNumber}</strong> · Questions? Reply to this email.
      </p>
    </div>
  `;
  await sendMail(email, `Order confirmed — ${orderNumber}`, html);
  logger.info({ email, orderNumber }, "Order confirmation email sent");
}

// ─── Send dispatch / rider-accepted notification to buyer ────────────────────
// Sent the moment a Kwik/Gokada rider accepts, or immediately after a GIG/Sendbox
// waybill is confirmed. This is when the tracking link becomes live.

export async function sendDispatchedEmail(params: {
  email: string;
  buyerName: string;
  orderNumber: string;
  storeName: string;
  provider: string;
  trackingId: string;
  trackingUrl?: string;
}): Promise<void> {
  const { email, buyerName, orderNumber, storeName, provider, trackingId, trackingUrl } = params;
  const providerLabel =
    provider === "kwik" ? "Kwik Delivery" :
    provider === "gokada" ? "Gokada" :
    provider === "sendbox" ? "Sendbox" :
    provider === "gig_logistics" ? "GIG Logistics" :
    "Terminal Africa";

  const trackBtn = trackingUrl
    ? `<div style="margin-top:24px;text-align:center">
        <a href="${trackingUrl}"
           style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:999px;font-size:14px;font-weight:600">
          Track your delivery
        </a>
       </div>`
    : "";

  const orderLink = `${process.env["SHOP_BASE_URL"]?.replace("/@", "/order/") ?? "https://keeosk.store/order/"}${orderNumber}`;

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px">
      <h2 style="color:#0a0a0a;margin-bottom:4px">Your order is on its way</h2>
      <p style="color:#555;margin-bottom:24px">
        Hi ${buyerName}, your order from <strong>${storeName}</strong> has been picked up and is heading to you.
      </p>

      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <p style="margin:0;font-size:13px;color:#166534;font-weight:600">Dispatched via ${providerLabel}</p>
        <p style="margin:6px 0 0;font-size:13px;color:#166534">Tracking ID: <strong>${trackingId}</strong></p>
      </div>

      ${trackBtn}

      <div style="margin-top:16px;text-align:center">
        <a href="${orderLink}"
           style="display:inline-block;color:#0a0a0a;text-decoration:underline;font-size:13px">
          View order details
        </a>
      </div>

      <p style="color:#888;font-size:12px;margin-top:24px;text-align:center">
        Order: <strong>${orderNumber}</strong> · Questions? Reply to this email.
      </p>
    </div>
  `;
  await sendMail(email, `Your order is on its way — ${orderNumber}`, html);
  logger.info({ email, orderNumber, provider }, "Dispatch email sent to buyer");
}

// ─── Notify vendor of a new storefront contact message ───────────────────────

export async function sendContactNotificationEmail(params: {
  vendorEmail: string;
  vendorName: string;
  senderName: string;
  senderEmail?: string;
  subject?: string;
  message: string;
}): Promise<void> {
  const { vendorEmail, vendorName, senderName, senderEmail, subject, message } = params;
  const replyLine = senderEmail
    ? `<p style="color:#555;font-size:13px">You can reply directly to this email to respond.</p>`
    : `<p style="color:#555;font-size:13px">The sender did not provide an email address.</p>`;

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px">
      <h2 style="color:#0a0a0a;margin-bottom:4px">New message from your store</h2>
      <p style="color:#555;margin-bottom:24px">Hi ${vendorName}, someone just sent a message through your storefront contact form.</p>

      <div style="background:#f4f4f5;border-radius:12px;padding:16px 20px;margin-bottom:16px">
        <p style="margin:0 0 4px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px">From</p>
        <p style="margin:0;font-size:15px;font-weight:600;color:#0a0a0a">${senderName}${senderEmail ? ` &lt;${senderEmail}&gt;` : ""}</p>
        ${subject ? `<p style="margin:8px 0 0;font-size:13px;color:#555"><strong>Subject:</strong> ${subject}</p>` : ""}
      </div>

      <div style="border:1px solid #e4e4e7;border-radius:12px;padding:16px 20px;margin-bottom:16px">
        <p style="margin:0 0 8px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Message</p>
        <p style="margin:0;font-size:14px;color:#0a0a0a;line-height:1.6;white-space:pre-wrap">${message}</p>
      </div>

      ${replyLine}
    </div>
  `;
  await sendMail(
    vendorEmail,
    subject ? `New message: "${subject}"` : `New message from ${senderName} — your store`,
    html,
    senderEmail ? { inReplyTo: `<contact-${Date.now()}@keeosk.store>` } : undefined
  );
  logger.info({ vendorEmail, senderName }, "Contact notification email sent to vendor");
}

// ─── Send abandoned cart recovery email ──────────────────────────────────────

export async function sendAbandonedCartEmail(params: {
  email: string;
  buyerName: string;
  storeName: string;
  storeUrl: string;
  items: Array<{ name: string; price: number; imageUrl?: string }>;
  recoveryToken: string;
}): Promise<void> {
  const { email, buyerName, storeName, storeUrl, items, recoveryToken } = params;
  const recoveryUrl = `${storeUrl}?recover_cart=${recoveryToken}`;

  const itemRows = items.slice(0, 5).map((i) => `
    <tr>
      <td style="padding:8px 0;color:#0a0a0a;border-bottom:1px solid #f0f0f0;font-size:14px">${i.name}</td>
      <td style="padding:8px 0;text-align:right;border-bottom:1px solid #f0f0f0;font-weight:600;color:#0a0a0a">₦${i.price.toLocaleString("en-NG")}</td>
    </tr>
  `).join("");

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;background:#ffffff">
      <h2 style="color:#0a0a0a;margin:0 0 6px">You left something behind</h2>
      <p style="color:#555;margin:0 0 24px;font-size:14px">
        Hi ${buyerName}, you had items in your cart at <strong>${storeName}</strong> that are still waiting for you.
      </p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tbody>${itemRows}</tbody>
      </table>
      ${items.length > 5 ? `<p style="color:#888;font-size:13px;margin:-16px 0 20px">...and ${items.length - 5} more item${items.length - 5 !== 1 ? "s" : ""}</p>` : ""}

      <div style="text-align:center;margin:28px 0">
        <a href="${recoveryUrl}"
           style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:999px;font-size:15px;font-weight:700">
          Complete your order
        </a>
      </div>

      <p style="color:#888;font-size:12px;text-align:center;margin-top:24px">
        This link recovers your cart at ${storeName}.<br>
        If you didn't start a purchase, you can safely ignore this email.
      </p>
    </div>
  `;

  await sendMail(email, `You left items in your cart at ${storeName}`, html);
  logger.info({ email, storeName }, "Abandoned cart recovery email sent");
}

// ─── Send password reset OTP ──────────────────────────────────────────────────

export async function sendPasswordResetEmail(email: string, otp: string): Promise<void> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
      <h2 style="color:#0a0a0a;margin-bottom:8px">Reset your password</h2>
      <p style="color:#555;margin-bottom:24px">Use this code to reset your Kiosk password:</p>
      <div style="background:#f4f4f5;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#0a0a0a">${otp}</span>
      </div>
      <p style="color:#888;font-size:13px">This code expires in 10 minutes. If you didn't request a password reset, ignore this email.</p>
    </div>
  `;
  await sendMail(email, "Reset your Kiosk password", html);
  logger.info({ email }, "Password reset email sent");
}
