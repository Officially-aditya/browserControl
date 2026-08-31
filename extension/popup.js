const $ = (id) => document.getElementById(id);

async function call(message) {
  return chrome.runtime.sendMessage(message);
}

function isLoopback(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function gatewayHttpUrl(gatewayValue, pathname) {
  const url = new URL(gatewayValue);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Gateway must use ws:// or wss://");
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new Error("Deployed gateways must use secure wss://");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

async function requestGatewayPermission(gatewayValue) {
  const httpUrl = gatewayHttpUrl(gatewayValue, "/health");
  const origin = `${httpUrl.protocol}//${httpUrl.host}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error("Gateway access was not granted");
}

function setError(message = "") {
  $("error").textContent = message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = busy ? label : button.dataset.defaultLabel;
}

async function refresh() {
  const state = await call({ type: "getStatus" });
  $("gateway").value = state.gatewayUrl || "";
  $("token").value = state.deviceToken || "";
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
    if (!gatewayUrl) throw new Error("Enter the gateway WebSocket URL");
    if (!/^\d{6,12}$/.test(code)) throw new Error("Enter the pairing code shown by your gateway");

    setBusy(button, true, "Pairing…");
    await requestGatewayPermission(gatewayUrl);
    const claimUrl = gatewayHttpUrl(gatewayUrl, "/pairing/claim");
    const response = await fetch(claimUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ code }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.deviceToken) {
      throw new Error(payload.error || `Pairing failed with HTTP ${response.status}`);
    }

    $("token").value = payload.deviceToken;
    const saved = await call({
      type: "saveConfig",
      config: { gatewayUrl, deviceToken: payload.deviceToken, autoReconnect: true },
    });
    if (!saved?.ok) throw new Error(saved?.error || "Could not save the paired device");
    $("pairing").value = "";
    setError("Paired successfully. You can now share a tab.");
    setTimeout(refresh, 250);
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    setBusy(button, false, "Pairing…");
  }
});

$("save").addEventListener("click", async () => {
  const button = $("save");
  setError();
  try {
    const gatewayUrl = $("gateway").value.trim();
    if (!gatewayUrl) throw new Error("Enter the gateway WebSocket URL");
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
    if (!result?.ok) throw new Error(result?.error || "Could not save gateway configuration");
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
