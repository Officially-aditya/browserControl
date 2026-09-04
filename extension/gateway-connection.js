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
  return getGatewayHttpUrl(gatewayUrl, "/mcp").toString();
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

function validateDeveloperGateway(raw) {
  const url = new URL(raw);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Developer gateway must use ws:// or wss://");
  if (!isLoopbackHostname(url.hostname)) throw new Error("Developer gateway override is allowed only for loopback");
  return url.toString();
}

export function resolveGatewayUrl(config = {}) {
  const explicit = String(config.developerGatewayUrl || "").trim();
  if (explicit) return validateDeveloperGateway(explicit);

  // Backwards-compatible hidden local-dev path for existing test/dev profiles.
  // Non-loopback legacy URLs never override the managed production relay.
  const legacy = String(config.gatewayUrl || "").trim();
  if (legacy && legacy !== PRODUCTION_GATEWAY_URL) {
    try {
      const parsed = new URL(legacy);
      if (isLoopbackHostname(parsed.hostname)) return validateDeveloperGateway(legacy);
    } catch {}
  }
  return PRODUCTION_GATEWAY_URL;
}

export function getReconnectDelay(attempt) {
  const normalizedAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  return Math.min(30_000, 1_000 * (2 ** Math.min(normalizedAttempt, 5)));
}
