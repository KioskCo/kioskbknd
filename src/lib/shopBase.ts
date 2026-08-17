/**
 * Storefront URL resolution for the API server.
 *
 * The whole platform is driven by one env var — SHOP_BASE_URL — which points
 * at the storefront frontend (e.g. a Cloudflare Workers deployment) and always
 * ends with "/@". Everything that builds a store/order link should use these
 * helpers so a single Railway env change re-hosts every link.
 */

export function shopBaseUrl(): string {
  return process.env["SHOP_BASE_URL"] ?? "https://keeosk.store/@";
}

/** Base for order links: <base>/order/<number>. */
export function orderBaseUrl(): string {
  return shopBaseUrl().replace(/\/?@$/, "/order/");
}

/** Full store URL for a username: <base><username>. */
export function storeUrl(username: string): string {
  const slug = username.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9_]/g, "");
  return `${shopBaseUrl()}${slug}`;
}