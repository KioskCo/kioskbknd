/**
 * Image upload routes.
 *
 * GET  /api/uploads/config  — return upload config so the client can choose a provider
 * POST /api/uploads/presign — generate a presigned S3 PUT URL (signed with AWS Sig V4)
 *
 * Strategy: clients upload files DIRECTLY to the cloud storage provider
 * (Cloudinary / S3), never via this server. This keeps the API server
 * lightweight and avoids large file payloads.
 *
 * Cloudinary unsigned uploads (simplest — no server secret needed):
 *   Client POSTs to https://api.cloudinary.com/v1_1/<cloud>/image/upload
 *   with { upload_preset, file } — no server signature required.
 *
 * S3 presigned PUT URL (if CLOUDINARY vars not set):
 *   Uses AWS Signature V4 signed entirely with Node's built-in `crypto` module
 *   — no AWS SDK dependency required.
 */

import { createHmac, createHash } from "crypto";
import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(requireAuth);

const CLOUD_NAME = process.env["CLOUDINARY_CLOUD_NAME"];
const UPLOAD_PRESET = process.env["CLOUDINARY_UPLOAD_PRESET"] ?? "kiosk_unsigned";

const AWS_BUCKET = process.env["AWS_S3_BUCKET"];
const AWS_REGION = process.env["AWS_REGION"] ?? "us-east-1";
const AWS_KEY_ID = process.env["AWS_ACCESS_KEY_ID"];
const AWS_SECRET = process.env["AWS_SECRET_ACCESS_KEY"];

// ─── AWS Signature V4 helpers ─────────────────────────────────────────────────

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function getSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate    = hmac(`AWS4${secret}`, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Generate an AWS Signature V4 presigned PUT URL for a single S3 object.
 * The URL is valid for `expiresSeconds` seconds (max 604 800 = 7 days for IAM users).
 */
function presignS3Put(params: {
  bucket: string;
  region: string;
  keyId: string;
  secret: string;
  objectKey: string;        // e.g. "uploads/userId/timestamp-file.jpg"
  contentType: string;
  expiresSeconds: number;
}): string {
  const { bucket, region, keyId, secret, objectKey, expiresSeconds } = params;

  const now = new Date();
  // e.g. "20240101T120000Z"
  const amzDate = now.toISOString().replace(/[:-]/g, "").split(".")[0] + "Z";
  // e.g. "20240101"
  const dateStamp = amzDate.slice(0, 8);

  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${keyId}/${credentialScope}`;
  const signedHeaders = "host";

  // Query params must be sorted by key name for the canonical form
  const queryEntries: Array<[string, string]> = ([
    ["X-Amz-Algorithm",     "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential",    credential],
    ["X-Amz-Date",          amzDate],
    ["X-Amz-Expires",       String(expiresSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ] as Array<[string, string]>).sort(([a], [b]) => a.localeCompare(b));

  const canonicalQueryString = queryEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  // Presigned PUT URLs use UNSIGNED-PAYLOAD — the body hash is not included.
  const canonicalRequest = [
    "PUT",
    `/${objectKey}`,
    canonicalQueryString,
    `host:${host}\n`,   // canonical headers (must end with \n)
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(secret, dateStamp, region, "s3");
  const signature  = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const finalParams = new URLSearchParams(Object.fromEntries(queryEntries));
  finalParams.set("X-Amz-Signature", signature);

  return `https://${host}/${objectKey}?${finalParams.toString()}`;
}

// ─── GET /api/uploads/config ──────────────────────────────────────────────────

router.get("/uploads/config", (_req, res) => {
  if (CLOUD_NAME) {
    res.json({
      success: true,
      data: {
        provider: "cloudinary",
        cloudName: CLOUD_NAME,
        uploadPreset: UPLOAD_PRESET,
        uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
      },
    });
    return;
  }

  if (AWS_BUCKET) {
    res.json({
      success: true,
      data: { provider: "s3", region: AWS_REGION, bucket: AWS_BUCKET },
    });
    return;
  }

  res.json({ success: true, data: { provider: "inline" } });
});

// ─── POST /api/uploads/presign ───────────────────────────────────────────────

router.post("/uploads/presign", async (req, res) => {
  const { filename, contentType } = req.body as { filename?: string; contentType?: string };

  if (!filename || !contentType) {
    res.status(400).json({ success: false, error: "filename and contentType are required" });
    return;
  }

  if (CLOUD_NAME) {
    // Cloudinary: client uploads directly — just return the URL + preset.
    res.json({
      success: true,
      data: {
        provider: "cloudinary",
        uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
        uploadPreset: UPLOAD_PRESET,
      },
    });
    return;
  }

  if (!AWS_BUCKET || !AWS_KEY_ID || !AWS_SECRET) {
    res.json({
      success: true,
      data: { provider: "inline", message: "No cloud storage configured. Use base64 inline images." },
    });
    return;
  }

  try {
    const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `uploads/${req.user!.userId}/${Date.now()}-${sanitizedName}`;
    const expiresSeconds = 300; // 5 minutes

    const presignedUrl = presignS3Put({
      bucket: AWS_BUCKET,
      region: AWS_REGION,
      keyId: AWS_KEY_ID,
      secret: AWS_SECRET,
      objectKey,
      contentType,
      expiresSeconds,
    });

    const publicUrl = `https://${AWS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${objectKey}`;

    res.json({
      success: true,
      data: { provider: "s3", presignedUrl, publicUrl, key: objectKey, expiresIn: expiresSeconds },
    });
  } catch (err) {
    logger.error({ err }, "Failed to generate presigned URL");
    res.status(500).json({ success: false, error: "Failed to generate upload URL" });
  }
});

export default router;
