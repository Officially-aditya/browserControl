export const PRODUCTION_GATEWAY_URL = "wss://browsercontrol-relay-production.up.railway.app/extension";
export const PRODUCTION_MCP_URL = "https://browsercontrol-relay-production.up.railway.app/mcp";
export const PRODUCTION_HTTP_ORIGIN = "https://browsercontrol-relay-production.up.railway.app";

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function getGatewayHttpUrl(gatewayUrl, pathname = "/") {
  const url = new URL(gatewayUrl);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Gateway URL must use ws:// or wss://");
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Deployed gateways must use secure wss://");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

export function getGatewayMcpUrl(gatewayUrl = PRODUCTION_GATEWAY_URL) {
  const url = getGatewayHttpUrl(gatewayUrl, "/mcp");
  return url.toString();
}

export function getGatewayPermissionOrigin(gatewayUrl) {
  try {
    const url = getGatewayHttpUrl(gatewayUrl, "/");
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

export function getLoopbackHealthUrl(gatewayUrl) {
  try {
    const source = new URL(gatewayUrl);
    if (source.protocol !== "ws:" || !isLoopbackHostname(source.hostname)) return null;
    return getGatewayHttpUrl(gatewayUrl, "/health").toString();
  } catch {
    return null;
  }
}

export function resolveGatewayUrl(config = {}) {
  const override = String(config.developerGatewayUrl || "").trim();
  if (!override) return PRODUCTION_GATEWAY_URL;
  const url = new URL(override);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Developer gateway must use ws:// or wss://");
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Developer ws:// override is allowed only for loopback");
  }
  return url.toString();
}

export function getReconnectDelay(attempt) {
  const normalizedAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  return Math.min(30_000, 1_000 * (2 ** Math.min(normalizedAttempt, 5)));
}
