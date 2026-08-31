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

export function getGatewayMcpUrl(gatewayUrl, mcpToken) {
  if (!mcpToken) return "";
  const url = getGatewayHttpUrl(gatewayUrl, "/mcp");
  url.searchParams.set("token", mcpToken);
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

export function getReconnectDelay(attempt) {
  const normalizedAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  return Math.min(30_000, 1_000 * (2 ** Math.min(normalizedAttempt, 5)));
}
