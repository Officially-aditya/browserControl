import {
  PRODUCTION_GATEWAY_URL,
  getGatewayHttpUrl,
  resolveGatewayUrl,
} from "./gateway-connection.js";

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/[\s-]/g, "");
}

async function deviceContext() {
  const stored = await chrome.storage.local.get({
    gatewayUrl: PRODUCTION_GATEWAY_URL,
    developerGatewayUrl: "",
    deviceId: "",
    deviceToken: "",
  });
  if (!stored.deviceId || !stored.deviceToken) {
    throw new Error("Enable remote access before approving a remote app connection.");
  }
  return {
    gatewayUrl: resolveGatewayUrl(stored),
    deviceId: stored.deviceId,
    deviceToken: stored.deviceToken,
  };
}

async function deviceRequest(pathname, { method = "GET", body } = {}) {
  const context = await deviceContext();
  const response = await fetch(getGatewayHttpUrl(context.gatewayUrl, pathname), {
    method,
    headers: {
      Authorization: `Bearer ${context.deviceToken}`,
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    cache: "no-store",
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `browserControl relay returned HTTP ${response.status}`);
  return payload;
}

export async function lookupRemoteApproval(code) {
  const normalized = normalizeCode(code);
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(normalized)) {
    throw new Error("Enter the 8-character approval code shown by the app.");
  }
  return {
    code: normalized,
    request: await deviceRequest("/device-approvals/lookup", {
      method: "POST",
      body: { code: normalized },
    }),
  };
}

export async function decideRemoteApproval({ code, requestId, decision }) {
  if (decision !== "approve" && decision !== "deny") throw new Error("Invalid approval decision");
  return deviceRequest("/device-approvals/decision", {
    method: "POST",
    body: { code: normalizeCode(code), requestId, decision },
  });
}

export async function listRemoteGrants() {
  const payload = await deviceRequest("/device-approvals/grants");
  return Array.isArray(payload.grants) ? payload.grants : [];
}

export async function revokeRemoteGrant(grantId) {
  return deviceRequest("/device-approvals/grants/revoke", {
    method: "POST",
    body: { grantId },
  });
}
