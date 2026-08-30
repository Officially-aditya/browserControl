const DEBUGGER_VERSION = "1.3";
let socket = null;
let attachedTabId = null;
let visualEpoch = 0;
let paused = false;
let reconnectTimer = null;
const observations = new Map();
const MAX_OBSERVATIONS = 32;

const DEFAULT_CONFIG = {
  gatewayUrl: "ws://127.0.0.1:8787/extension",
  deviceToken: "",
  autoReconnect: true,
};

async function getConfig() {
  return { ...DEFAULT_CONFIG, ...(await chrome.storage.local.get(DEFAULT_CONFIG)) };
}

async function setStatus(status, extra = {}) {
  await chrome.storage.local.set({ status, attachedTabId, visualEpoch, paused, ...extra });
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

function invalidateVisualState() {
  visualEpoch++;
  observations.clear();
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
  invalidateVisualState();
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await setStatus(paused ? "paused" : socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
}

async function detach() {
  const tabId = attachedTabId;
  attachedTabId = null;
  invalidateVisualState();
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

function mimeType(format) {
  return format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
}

function rememberObservation(record) {
  observations.set(record.observationId, record);
  while (observations.size > MAX_OBSERVATIONS) {
    const oldest = observations.keys().next().value;
    observations.delete(oldest);
  }
}

function assertFresh(observationId) {
  if (!observationId) throw new Error("observationId is required for coordinate actions");
  const record = observations.get(String(observationId));
  if (!record || record.tabId !== attachedTabId || record.visualEpoch !== visualEpoch) {
    const err = new Error("STALE_OBSERVATION");
    err.code = "STALE_OBSERVATION";
    throw err;
  }
  return record;
}

function normalizedRegionToSource(region, sourceRegion) {
  const values = [region.x, region.y, region.width, region.height];
  if (!values.every(Number.isFinite)) throw new Error("region coordinates must be finite numbers");
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1000 || region.y + region.height > 1000) {
    throw new Error("region must fit inside normalized 0-1000 coordinate space");
  }
  return {
    x: sourceRegion.x + (region.x / 1000) * sourceRegion.width,
    y: sourceRegion.y + (region.y / 1000) * sourceRegion.height,
    width: (region.width / 1000) * sourceRegion.width,
    height: (region.height / 1000) * sourceRegion.height,
  };
}

function normalizedPointToSource(x, y, record) {
  if (![x, y].every(Number.isFinite)) throw new Error("x and y must be finite numbers");
  if (x < 0 || x > 1000 || y < 0 || y > 1000) throw new Error("normalized coordinates must be between 0 and 1000");
  const r = record.sourceRegion;
  return {
    x: Math.max(0, r.x + (x / 1000) * r.width),
    y: Math.max(0, r.y + (y / 1000) * r.height),
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
    ...(format === "png" ? {} : { quality }),
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const observationId = `${tabId}:${visualEpoch}:${crypto.randomUUID()}`;
  const sourceRegion = { x: 0, y: 0, width: vp.width, height: vp.height };
  rememberObservation({ observationId, tabId, visualEpoch, sourceRegion });
  return {
    observationId,
    visualEpoch,
    targetId: String(tabId),
    url: tab.url || "",
    title: tab.title || "",
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    sourceRegion,
    kind: "overview",
    coordinateSpace: "normalized_1000",
    mimeType: mimeType(format),
    image: shot.data,
  };
}

async function inspectRegion(params = {}) {
  const source = assertFresh(params.observationId);
  const vp = await viewport();
  const region = normalizedRegionToSource(params, source.sourceRegion);
  const format = params.format || "png";
  const quality = params.quality ?? 90;
  const shot = await send("Page.captureScreenshot", {
    format,
    ...(format === "png" ? {} : { quality }),
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: vp.pageX + region.x,
      y: vp.pageY + region.y,
      width: region.width,
      height: region.height,
      scale: 1,
    },
  });
  const observationId = `${attachedTabId}:${visualEpoch}:${crypto.randomUUID()}`;
  rememberObservation({ observationId, tabId: attachedTabId, visualEpoch, sourceRegion: region });
  return {
    observationId,
    sourceObservationId: params.observationId,
    visualEpoch,
    targetId: String(attachedTabId),
    sourceRegion: region,
    kind: "region",
    coordinateSpace: "normalized_1000",
    mimeType: mimeType(format),
    image: shot.data,
  };
}

async function mouseMove(params) {
  const record = assertFresh(params.observationId);
  const p = normalizedPointToSource(params.x, params.y, record);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function mouseClick(params, clickCount = 1) {
  const record = assertFresh(params.observationId);
  const p = normalizedPointToSource(params.x, params.y, record);
  const button = params.button || "left";
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button, clickCount });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function drag(params) {
  const record = assertFresh(params.observationId);
  if (!Array.isArray(params.path) || params.path.length < 2) throw new Error("drag path requires at least two points");
  const points = params.path.map((point) => normalizedPointToSource(point.x, point.y, record));
  const first = points[0];
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: first.x, y: first.y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: first.x, y: first.y, button: "left", clickCount: 1 });
  for (const point of points.slice(1)) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1 });
  }
  const last = points[points.length - 1];
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, button: "left", clickCount: 1 });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function scroll(params) {
  const record = assertFresh(params.observationId);
  const p = normalizedPointToSource(params.x ?? 500, params.y ?? 500, record);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: params.deltaX || 0, deltaY: params.deltaY || 0 });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function typeText(params) {
  await send("Input.insertText", { text: String(params.text ?? "") });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function keypress(params) {
  const keys = Array.isArray(params.keys) ? params.keys : [];
  if (!keys.length) throw new Error("keys is required");
  const modifiersMap = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const modifierNames = new Set(Object.keys(modifiersMap));
  let modifiers = 0;
  for (const key of keys) if (modifierNames.has(key)) modifiers |= modifiersMap[key];
  const primary = keys.find((k) => !modifierNames.has(k)) || keys[keys.length - 1];
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: primary, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: primary, modifiers });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function navigate(params) {
  if (!params.url) throw new Error("url is required");
  await send("Page.navigate", { url: params.url });
  invalidateVisualState();
  return { success: true, visualEpoch, url: params.url };
}

async function historyAction(direction) {
  const tabId = await ensureAttached();
  if (direction === "back") await chrome.tabs.goBack(tabId);
  else await chrome.tabs.goForward(tabId);
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function reload() {
  const tabId = await ensureAttached();
  await chrome.tabs.reload(tabId);
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({ targetId: String(tab.id), windowId: tab.windowId, active: tab.active, title: tab.title || "", url: tab.url || "" }));
}

async function switchTab(params) {
  const tabId = Number(params.targetId);
  if (!Number.isInteger(tabId)) throw new Error("targetId must be a Chrome tab id");
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true });
  await attach(tabId);
  return { success: true, targetId: String(tabId), visualEpoch };
}

async function newTab(params = {}) {
  const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: true });
  if (!tab.id) throw new Error("Failed to create tab");
  await attach(tab.id);
  return { success: true, targetId: String(tab.id), visualEpoch };
}

async function closeTab(params = {}) {
  const tabId = params.targetId ? Number(params.targetId) : attachedTabId;
  if (!Number.isInteger(tabId)) throw new Error("No target tab to close");
  await chrome.tabs.remove(tabId);
  if (tabId === attachedTabId) {
    attachedTabId = null;
    invalidateVisualState();
  }
  return { success: true, visualEpoch };
}

async function handleDialog(params = {}) {
  await send("Page.handleJavaScriptDialog", { accept: !!params.accept, ...(params.promptText != null ? { promptText: String(params.promptText) } : {}) });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function handleRpc(request) {
  if (paused && !["status", "resume", "disconnect"].includes(request.method)) {
    throw Object.assign(new Error("CONTROL_PAUSED"), { code: "CONTROL_PAUSED" });
  }
  switch (request.method) {
    case "status": return { attachedTabId, visualEpoch, paused, connected: socket?.readyState === WebSocket.OPEN };
    case "observe": return observe(request.params);
    case "inspect_region": return inspectRegion(request.params || {});
    case "move": return mouseMove(request.params || {});
    case "click": return mouseClick(request.params || {}, 1);
    case "double_click": return mouseClick(request.params || {}, 2);
    case "drag": return drag(request.params || {});
    case "scroll": return scroll(request.params || {});
    case "type": return typeText(request.params || {});
    case "keypress": return keypress(request.params || {});
    case "navigate": return navigate(request.params || {});
    case "back": return historyAction("back");
    case "forward": return historyAction("forward");
    case "reload": return reload();
    case "tabs": return listTabs();
    case "switch_tab": return switchTab(request.params || {});
    case "new_tab": return newTab(request.params || {});
    case "close_tab": return closeTab(request.params || {});
    case "handle_dialog": return handleDialog(request.params || {});
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
    invalidateVisualState();
    setStatus(paused ? "paused" : socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    invalidateVisualState();
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
