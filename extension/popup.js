import { getGatewayHttpUrl, getGatewayMcpUrl, getGatewayPermissionOrigin } from "./gateway-connection.js";

const $ = (id) => document.getElementById(id);

async function call(message) {
  return chrome.runtime.sendMessage(message);
}

async function requestGatewayPermission(gatewayValue) {
  const origin = getGatewayPermissionOrigin(gatewayValue);
  if (!origin) throw new Error("Enter a valid ws:// or wss:// relay URL");
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error("Relay access was not granted");
}

function setError(message = "") {
  $("error").textContent = message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = busy ? label : button.dataset.defaultLabel;
}

function refreshConnector(state) {
  const hasPairing = !!(state.mcpToken && state.gatewayUrl);
  const connectorUrl = hasPairing ? getGatewayMcpUrl(state.gatewayUrl) : "";
  $("connector").value = connectorUrl;
  const tokenEl = $("connectorToken");
  if (tokenEl) tokenEl.value = hasPairing ? state.mcpToken : "";
  $("connectorSection").hidden = !connectorUrl;
}

async function refresh() {
  const state = await call({ type: "getStatus" });
  $("gateway").value = state.gatewayUrl || "";
  $("token").value = state.deviceToken || "";
  refreshConnector(state);
  const connected = state.status === "connected";
  const paused = !!state.paused;
  const status = connected ? "Connected" : state.status === "error" ? "Needs attention" : state.status || "Disconnected";
  $("status").textContent = `${status}${state.attachedTabId ? ` • shared tab ${state.attachedTabId}` : " • no shared tab"}${paused ? " • paused" : ""}`;
  $("pause").textContent = paused ? "Resume" : "Pause";
  if (state.lastError) setError(state.lastError);
}

for (const id of ["pair", "save"]) {
  $(id).dataset.defaultLabel = $(id).textContent;
}

$("pair").addEventListener("click", async () => {
  const button = $("pair");
  setError();
  try {
    const gatewayUrl = $("gateway").value.trim();
    const code = $("pairing").value.replace(/\s+/g, "");
    if (!gatewayUrl) throw new Error("Enter the relay WebSocket URL");
    if (!/^\d{6,12}$/.test(code)) throw new Error("Enter the pairing code shown by your relay");

    setBusy(button, true, "Pairing…");
    await requestGatewayPermission(gatewayUrl);
    const claimUrl = getGatewayHttpUrl(gatewayUrl, "/pairing/claim");
    const response = await fetch(claimUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ code }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.deviceToken || !payload.mcpToken || !payload.deviceId) {
      throw new Error(payload.error || `Pairing failed with HTTP ${response.status}`);
    }

    $("token").value = payload.deviceToken;
    const saved = await call({
      type: "saveConfig",
      config: {
        gatewayUrl,
        deviceId: payload.deviceId,
        deviceToken: payload.deviceToken,
        mcpToken: payload.mcpToken,
        autoReconnect: true,
      },
    });
    if (!saved?.ok) throw new Error(saved?.error || "Could not save the paired device");
    $("pairing").value = "";
    refreshConnector({ gatewayUrl, mcpToken: payload.mcpToken });
    setError("Paired. Copy the connector URL into Claude, then share a tab.");
    setTimeout(refresh, 250);
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    setBusy(button, false, "Pairing…");
  }
});

$("copyConnector").addEventListener("click", async () => {
  setError();
  const connectorUrl = $("connector").value;
  if (!connectorUrl) return;
  try {
    await navigator.clipboard.writeText(connectorUrl);
    setError("Connector URL copied. Add it as a remote MCP connector in Claude.");
  } catch {
    $("connector").type = "text";
    $("connector").select();
    setError("Copy the selected connector URL, then keep it private.");
  }
});

$("copyConnectorToken").addEventListener("click", async () => {
  setError();
  const token = $("connectorToken").value;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    setError("MCP token copied. Paste it only into browserControl's authorization page or an Authorization header.");
  } catch {
    const tokenInput = $("connectorToken");
    tokenInput.type = "text";
    tokenInput.select();
    setError("Copy the selected MCP token, then keep it private.");
    setTimeout(() => { tokenInput.type = "password"; }, 5000);
  }
});

$("save").addEventListener("click", async () => {
  const button = $("save");
  setError();
  try {
    const gatewayUrl = $("gateway").value.trim();
    if (!gatewayUrl) throw new Error("Enter the relay WebSocket URL");
    setBusy(button, true, "Connecting…");
    await requestGatewayPermission(gatewayUrl);
    const result = await call({
      type: "saveConfig",
      config: {
        gatewayUrl,
        deviceToken: $("token").value.trim(),
        autoReconnect: true,
      },
    });
    if (!result?.ok) throw new Error(result?.error || "Could not save relay configuration");
    setTimeout(refresh, 250);
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    setBusy(button, false, "Connecting…");
  }
});

$("share").addEventListener("click", async () => {
  setError();
  const result = await call({ type: "shareActiveTab" });
  if (!result?.ok) setError(result?.error || "Failed to share active tab");
  await refresh();
});

$("pause").addEventListener("click", async () => {
  setError();
  const result = await call({ type: "togglePause" });
  if (!result?.ok) setError(result?.error || "Could not change pause state");
  await refresh();
});

$("disconnect").addEventListener("click", async () => {
  setError();
  const result = await call({ type: "disconnect" });
  if (!result?.ok) setError(result?.error || "Could not disconnect");
  await refresh();
});

void refresh();
