export function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function getLoopbackHealthUrl(gatewayUrl) {
  try {
    const url = new URL(gatewayUrl);
    if (url.protocol !== "ws:" || !isLoopbackHostname(url.hostname)) return null;
    url.protocol = "http:";
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function getReconnectDelay(attempt) {
  const normalizedAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  return Math.min(30_000, 1_000 * (2 ** Math.min(normalizedAttempt, 5)));
}
