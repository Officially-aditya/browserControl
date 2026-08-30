const DEBUGGER_VERSION = "1.3";
let socket = null;
let attachedTabId = null;
let visualEpoch = 0;
let paused = false;
let reconnectTimer = null;

const DEFAULT_CONFIG = {
  gatewayUrl: "ws://127.0.0.1:8787/extension",
  deviceToken: "",
  autoReconnect: true,
};

async function getConfig() {
  return { ...DEFAULT_CONFIG, ...(await chrome.storage.local.get(DEFAULT_CONFIG)) };
}

async function setStatus(status, extra = {}) {
  await chrome.storage.local.set({
    status,
    attachedTabId,
    visualEpoch,
    paused,
    ...extra,
  });
  updateBadge(status);
}

function updateBadge(status) {
  const map = {
    connected: ["ON", "#137333"],
    paused: ["II", "#b06000"],
    disconnected: ["", "#5f6368"],
    error: ["!", "#b3261e"],
  };
  const [text, color] = map[status] || ["", "#5f6368"];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active Chrome tab found");
  return tab;
}

async function attach(tabId) {
  if (attachedTabId === tabId) return;
  if (attachedTabId != null) await detach();
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  attachedTabId = tabId;
  visualEpoch++;
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await setStatus(paused ? "paused" : socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
}

async function detach() {
  const tabId = attachedTabId;
  attachedTabId = null;
  visualEpoch++;
  if (tabId != null) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  await setStatus(socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
}

async function ensureAttached() {
  if (attachedTabId != null) return attachedTabId;
  const tab = await activeTab();
  await attach(tab.id);
  return tab.id;
}

async function send(method, params = {}) {
  const tabId = await ensureAttached();
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function normalizedPoint(x, y, viewport) {
  if (![x, y].every(Number.isFinite)) throw new Error("x and y must be finite numbers");
  if (x < 0 || x > 1000 || y < 0 || y > 1000) throw new Error("normalized coordinates must be between 0 and 1000");
  return {
    x: Math.min(viewport.width - Number.EPSILON, Math.max(0, (x / 1000) * viewport.width)),
    y: Math.min(viewport.height - Number.EPSILON, Math.max(0, (y / 1000) * viewport.height)),
  };
}

async function viewport() {
  const metrics = await send("Page.getLayoutMetrics");
  const vv = metrics.cssVisualViewport || metrics.visualViewport;
  return {
    width: vv?.clientWidth ?? vv?.width,
    height: vv?.clientHeight ?? vv?.height,
    pageX: vv?.pageX ?? 0,
    pageY: vv?.pageY ?? 0,
  };
}

async function observe(params = {}) {
  const tabId = await ensureAttached();
  const tab = await chrome.tabs.get(tabId);
  const vp = await viewport();
  const format = params.format || "jpeg";
  const quality = params.quality ?? 82;
  const shot = await send("Page.captureScreenshot", {
    format,
    quality: format === "png" ? undefined : quality,
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const observationId = `${tabId}:${visualEpoch}:${Date.now()}`;
  return {
    observationId,
    visualEpoch,
    targetId: String(tabId),
    url: tab.url || "",
    title: tab.title || "",
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    coordinateSpace: "normalized_1000",
    mimeType: format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg",
    image: shot.data,
  };
}

function assertFresh(observationId) {
  if (!observationId) throw new Error("observationId is required for coordinate actions");
  const [tab, epoch] = String(observationId).split(":");
  if (String(attachedTabId) !== tab || Number(epoch) !== visualEpoch) {
    const err = new Error("STALE_OBSERVATION");
    err.code = "STALE_OBSERVATION";
    throw err;
  }
}

async function mouseClick(params) {
  assertFresh(params.observationId);
  const vp = await viewport();
  const p = normalizedPoint(params.x, params.y, vp);
  const button = params.button || "left";
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button, clickCount: 1 });
  visualEpoch++;
  return { success: true, visualEpoch };
}

async function scroll(params) {
  assertFresh(params.observationId);
  const vp = await viewport();
  const p = normalizedPoint(params.x ?? 500, params.y ?? 500, vp);
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: p.x,
    y: p.y,
    deltaX: params.deltaX || 0,
    deltaY: params.deltaY || 0,
  });
  visualEpoch++;
  return { success: true, visualEpoch };
}

async function typeText(params) {
  await send("Input.insertText", { text: String(params.text ?? "") });
  visualEpoch++;
  return { success: true, visualEpoch };
}

async function keypress(params) {
  const keys = Array.isArray(params.keys) ? params.keys : [];
  if (!keys.length) throw new Error("keys is required");
  const modifierNames = new Set(["Alt", "Control", "Meta", "Shift"]);
  let modifiers = 0;
  const bit = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  for (const key of keys) if (modifierNames.has(key)) modifiers |= bit[key];
  const primary = keys.find((k) => !modifierNames.has(k)) || keys[keys.length - 1];
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: primary, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: primary, modifiers });
  visualEpoch++;
  return { success: true, visualEpoch };
}

async function navigate(params) {
  if (!params.url) throw new Error("url is required");
  await send("Page.navigate", { url: params.url });
  visualEpoch++;
  return { success: true, visualEpoch, url: params.url };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    targetId: String(tab.id),
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title || "",
    url: tab.url || "",
  }));
}

async function switchTab(params) {
  const tabId = Number(params.targetId);
  if (!Number.isInteger(tabId)) throw new Error("targetId must be a Chrome tab id");
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true });
  await attach(tabId);
  return { success: true, targetId: String(tabId), visualEpoch };
}

async function handleRpc(request) {
  if (paused && !["status", "resume", "disconnect"].includes(request.method)) {
    throw Object.assign(new Error("CONTROL_PAUSED"), { code: "CONTROL_PAUSED" });
  }
  switch (request.method) {
    case "status":
      return { attachedTabId, visualEpoch, paused, connected: socket?.readyState === WebSocket.OPEN };
    case "observe": return observe(request.params);
    case "click": return mouseClick(request.params || {});
    case "scroll": return scroll(request.params || {});
    case "type": return typeText(request.params || {});
    case "keypress": return keypress(request.params || {});
    case "navigate": return navigate(request.params || {});
    case "tabs": return listTabs();
    case "switch_tab": return switchTab(request.params || {});
    case "attach_active": {
      const tab = await activeTab();
      await attach(tab.id);
      return { success: true, targetId: String(tab.id), visualEpoch };
    }
    case "pause": paused = true; await setStatus("paused"); return { success: true };
    case "resume": paused = false; await setStatus(socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected"); return { success: true };
    case "disconnect": await detach(); return { success: true };
    default: throw new Error(`Unknown RPC method: ${request.method}`);
  }
}

async function connectGateway() {
  clearTimeout(reconnectTimer);
  const config = await getConfig();
  if (!config.gatewayUrl) return;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const url = new URL(config.gatewayUrl);
  if (config.deviceToken) url.searchParams.set("token", config.deviceToken);
  socket = new WebSocket(url.toString());
  socket.onopen = async () => {
    await setStatus(paused ? "paused" : "connected", { gatewayUrl: config.gatewayUrl });
    socket.send(JSON.stringify({ type: "hello", version: 1, userAgent: navigator.userAgent }));
  };
  socket.onmessage = async (event) => {
    let request;
    try { request = JSON.parse(event.data); } catch { return; }
    if (!request?.id || !request?.method) return;
    try {
      const result = await handleRpc(request);
      socket.send(JSON.stringify({ id: request.id, ok: true, result }));
    } catch (error) {
      socket.send(JSON.stringify({ id: request.id, ok: false, error: { code: error?.code || "RPC_ERROR", message: error?.message || String(error) } }));
    }
  };
  socket.onclose = async () => {
    await setStatus("disconnected");
    socket = null;
    if ((await getConfig()).autoReconnect) reconnectTimer = setTimeout(connectGateway, 2000);
  };
  socket.onerror = () => setStatus("error");
}

chrome.debugger.onEvent.addListener((source, method) => {
  if (source.tabId !== attachedTabId) return;
  if (["Page.frameNavigated", "Page.navigatedWithinDocument", "Page.loadEventFired", "Page.javascriptDialogOpening"].includes(method)) {
    visualEpoch++;
    setStatus(paused ? "paused" : socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    visualEpoch++;
    setStatus(socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "getStatus") return { ...(await chrome.storage.local.get(null)), attachedTabId, visualEpoch, paused };
    if (message.type === "saveConfig") {
      await chrome.storage.local.set(message.config || {});
      if (socket) socket.close(); else connectGateway();
      return { ok: true };
    }
    if (message.type === "shareActiveTab") {
      const tab = await activeTab();
      await attach(tab.id);
      return { ok: true, targetId: String(tab.id) };
    }
    if (message.type === "togglePause") {
      paused = !paused;
      await setStatus(paused ? "paused" : socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
      return { ok: true, paused };
    }
    if (message.type === "disconnect") {
      if (socket) socket.close();
      await detach();
      return { ok: true };
    }
    return { ok: false };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

connectGateway();
