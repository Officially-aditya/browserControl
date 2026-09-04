import { getGatewayHttpUrl } from "./gateway-connection.js";

const ENROLLMENT_HEADER = "x-browsercontrol-enrollment";
const ENROLLMENT_HEADER_VALUE = "extension-v1";

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export async function enrollDevice({ gatewayUrl, name = "Chrome", fetchImpl = fetch } = {}) {
  if (!gatewayUrl) throw new Error("browserControl relay is not configured");

  const nonce = randomNonce();
  const nonceHash = await sha256Hex(nonce);
  const headers = {
    "Content-Type": "application/json",
    [ENROLLMENT_HEADER]: ENROLLMENT_HEADER_VALUE,
  };

  const start = await fetchImpl(getGatewayHttpUrl(gatewayUrl, "/enroll/start"), {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify({ nonceHash, name }),
  });
  const started = await readJson(start);
  if (!start.ok || !started.ticket) {
    throw new Error(started.error || `Device enrollment failed with HTTP ${start.status}`);
  }

  const claim = await fetchImpl(getGatewayHttpUrl(gatewayUrl, "/enroll/claim"), {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify({ ticket: started.ticket, nonce }),
  });
  const credential = await readJson(claim);
  if (!claim.ok || !credential.deviceId || !credential.deviceToken || !credential.mcpToken) {
    throw new Error(credential.error || `Device enrollment claim failed with HTTP ${claim.status}`);
  }

  return {
    deviceId: credential.deviceId,
    deviceToken: credential.deviceToken,
    mcpToken: credential.mcpToken,
  };
}
