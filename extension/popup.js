import { PRODUCTION_MCP_URL } from "./gateway-connection.js";

const $ = (id) => document.getElementById(id);

async function call(message) {
  return chrome.runtime.sendMessage(message);
}

function setError(message = "") {
  $("error").textContent = message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.defaultLabel;
}

async function refresh() {
  const state = await call({ type: "getStatus" });
  const connected = state.status === "connected" || state.status === "paused";
  const paused = !!state.paused;
  const attached = !!state.attachedTabId;
  const enrolled = !!(state.deviceId && state.deviceToken && state.mcpToken);

  let label = connected ? "Connected" : state.status === "error" ? "Needs attention" : "Disconnected";
  if (connected && attached) label += ` • active tab ${state.attachedTabId}`;
  else if (connected) label += " • ready";
  if (paused) label += " • paused";
  $("status").textContent = label;
  $("status").classList.toggle("connected", connected && !paused);

  $("connectSection").hidden = connected;
  $("connectedSection").hidden = !connected;
  $("connect").textContent = enrolled ? "Reconnect browserControl" : "Connect browserControl";
  $("connect").dataset.defaultLabel = $("connect").textContent;
  $("pause").textContent = paused ? "Resume" : "Pause";
  $("autoAttach").checked = state.autoAttach !== false;
  $("followActiveTab").checked = state.followActiveTab !== false;

  if (state.lastError) setError(state.lastError);
}

$("connect").dataset.defaultLabel = $("connect").textContent;

$("connect").addEventListener("click", async () => {
  const button = $("connect");
  setError();
  setBusy(button, true, "Connecting…");
  try {
    const result = await call({ type: "connectProduction" });
    if (!result?.ok) throw new Error(result?.error || "Could not connect browserControl");
    setError("Connected. Add the Claude connector once, then browserControl is ready whenever you need it.");
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    setBusy(button, false, "Connecting…");
    await refresh();
  }
});

$("copyConnector").addEventListener("click", async () => {
  setError();
  try {
    await navigator.clipboard.writeText(PRODUCTION_MCP_URL);
    setError("Claude connector URL copied.");
  } catch {
    setError(PRODUCTION_MCP_URL);
  }
});

for (const id of ["autoAttach", "followActiveTab"]) {
  $(id).addEventListener("change", async () => {
    setError();
    const result = await call({
      type: "updatePreferences",
      preferences: {
        autoAttach: $("autoAttach").checked,
        followActiveTab: $("followActiveTab").checked,
      },
    });
    if (!result?.ok) setError(result?.error || "Could not save browserControl preferences");
    await refresh();
  });
}

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
