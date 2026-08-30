const $ = (id) => document.getElementById(id);

async function call(message) {
  return chrome.runtime.sendMessage(message);
}

async function refresh() {
  const state = await call({ type: "getStatus" });
  $("gateway").value = state.gatewayUrl || "";
  $("token").value = state.deviceToken || "";
  const connected = state.status === "connected";
  const paused = !!state.paused;
  $("status").textContent = `${connected ? "Connected" : state.status || "Disconnected"}${state.attachedTabId ? ` • shared tab ${state.attachedTabId}` : " • no shared tab"}${paused ? " • paused" : ""}`;
  $("pause").textContent = paused ? "Resume" : "Pause";
}

$("save").addEventListener("click", async () => {
  await call({
    type: "saveConfig",
    config: {
      gatewayUrl: $("gateway").value.trim(),
      deviceToken: $("token").value.trim(),
      autoReconnect: true,
    },
  });
  setTimeout(refresh, 250);
});

$("share").addEventListener("click", async () => {
  const result = await call({ type: "shareActiveTab" });
  if (!result?.ok) alert(result?.error || "Failed to share active tab");
  await refresh();
});

$("pause").addEventListener("click", async () => {
  await call({ type: "togglePause" });
  await refresh();
});

$("disconnect").addEventListener("click", async () => {
  await call({ type: "disconnect" });
  await refresh();
});

refresh();
