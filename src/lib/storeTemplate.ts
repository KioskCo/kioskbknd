/**
 * Storefront template helpers.
 *
 * injectWhatsAppNumber() — deep-injects a vendor's connected WhatsApp number
 * into the storefront template JSON wherever a WhatsApp-related field is empty
 * or still a demo placeholder. Runs at read time (never mutates stored data),
 * so live stores always reflect the connected number without a re-publish.
 * Vendor-specified numbers are respected — only empty/placeholder fields change.
 */

const CONTACT_SECTION_TYPES = new Set(["contact", "map-location", "whatsapp-cta"]);

const PLACEHOLDER_DIGITS = new Set([
  "8000000000",
  "2348000000000",
  "8012345678",
  "2348012345678",
  "8031234567",
  "2348031234567",
]);

function digitsOf(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function isPlaceholder(value: unknown): boolean {
  const digits = digitsOf(value);
  if (!digits) return true;
  return PLACEHOLDER_DIGITS.has(digits);
}

export function injectWhatsAppNumber(templateJson: string, number: string): string {
  const clean = digitsOf(number);
  if (!clean) return templateJson;

  let data: unknown;
  try {
    data = JSON.parse(templateJson);
  } catch {
    return templateJson;
  }

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;

    const obj = node as Record<string, unknown>;

    // Section-level phone (contact / map-location / whatsapp-cta)
    if (typeof obj.type === "string" && CONTACT_SECTION_TYPES.has(obj.type) && isPlaceholder(obj.phone)) {
      obj.phone = number;
    }

    // Block actions — buttons / icons that open WhatsApp
    const action = obj.action as Record<string, unknown> | null | undefined;
    if (action?.type === "whatsapp" && isPlaceholder(action.number)) {
      action.number = clean;
    }

    // Form submit actions that send to WhatsApp
    const submitAction = obj.submitAction as Record<string, unknown> | null | undefined;
    if (submitAction?.type === "whatsapp" && isPlaceholder(submitAction.number)) {
      submitAction.number = clean;
    }

    // Social links pointing to WhatsApp
    if (obj.platform === "whatsapp" && isPlaceholder(obj.url ?? obj.href)) {
      obj.url = `https://wa.me/${clean}`;
    }

    Object.values(obj).forEach((value) => {
      if (value && typeof value === "object") walk(value);
    });
  };

  walk(data);
  return JSON.stringify(data);
}