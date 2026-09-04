import {
  PRODUCTION_GATEWAY_URL,
  PRODUCTION_HTTP_ORIGIN,
  getGatewayHttpUrl,
  getGatewayPermissionOrigin,
  getLoopbackHealthUrl,
  getReconnectDelay,
  resolveGatewayUrl,
} from "./gateway-connection.js";
import { createLocalConnection } from "./local-connection.js";
import { keyEvents } from "./keyboard.js";

const DEBUGGER_VERSION = "1.3";
const VISUAL_INVALIDATION_BINDING = "__browserControlVisualInvalidated";
const CONTROL_SESSION_ALARM = "browsercontrol-control-session-idle";
const CONTROL_SESSION_IDLE_MINUTES = 15;
const ENROLLMENT_HEADER = "X-BrowserControl-Enrollment";
const ENROLLMENT_HEADER_VALUE = "extension-v1";
const TRANSPORT_LEASE_MS = 60_000;
const MUTATING_RPC_METHODS = new Set([
  "move",
  "click",
  "double_click",
  "drag",
  "scroll",
  "type",
  "keypress",
  "navigate",
  "back",
  "forward",
  "reload",
  "switch_tab",
  "new_tab",
  "close_tab",
  "handle_dialog",
]);
const CONTROL_SURFACE_HOSTS = new Set([
  "claude.ai",
  "chatgpt.com",
  "chat.openai.com",
  "browsercontrol-relay-production.up.railway.app",
]);
const VISUAL_HOOK_SCRIPT = `(() => {
  if (globalThis.__browserControlVisualWatchInstalled) return;
  globalThis.__browserControlVisualWatchInstalled = true;
  let timer = null;
  const notify = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { globalThis.${VISUAL_INVALIDATION_BINDING}("visual-change"); } catch {}
    }, 50);
  };
  const observer = new MutationObserver(notify);
  const start = () => {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  };
  start();
  if (!document.documentElement) addEventListener("DOMContentLoaded", start, { once: true });
  for (const eventName of ["pointerdown", "pointermove", "keydown", "input", "change", "scroll", "resize"]) {
    addEventListener(eventName, notify, true);
  }
})();`;

let socket = null;
let localConnection = null;
let localConnected = false;
let attachedTabId = null;
let lastTargetTabId = null;
let visualEpoch = 0;
let paused = false;
let manualDisconnect = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let gatewayConnectInFlight = false;
let followTabInFlight = false;
let transportLeaseOwner = null;
let transportLeaseExpiresAt = 0;
const observations = new Map();
const MAX_OBSERVATIONS = 32;

const DEFAULT_CONFIG = {
  gatewayUrl: PRODUCTION_GATEWAY_URL,
  developerGatewayUrl: "",
  deviceId: "",
  deviceToken: "",
  mcpToken: "",
  autoReconnect: true,
  autoAttach: true,
  followActiveTab: true,
};

async function getConfig() {
  const stored = { ...DEFAULT_CONFIG, ...(await chrome.storage.local.get(DEFAULT_CONFIG)) };
  return { ...stored, gatewayUrl: resolveGatewayUrl(stored) };
}

function remoteConnected() {
  return socket?.readyState === WebSocket.OPEN;
}

function anyTransportConnected() {
  return remoteConnected() || localConnected;
}

async function setStatus(status, extra = {}) {
  const effectiveStatus = paused ? "paused" : anyTransportConnected() ? "connected" : status;
  await chrome.storage.local.set({
    status: effectiveStatus,
    attachedTabId,
    visualEpoch,
    paused,
    manualDisconnect,
    localConnected,
    remoteConnected: remoteConnected(),
    ...extra,
  });
  const map = {
    connected: ["ON", "#137333"],
    paused: ["II", "#b06000"],
    disconnected: ["", "#5f6368"],
    error: ["!", "#b3261e"],
  };
  const [text, color] = map[effectiveStatus] || ["", "#5f6368"];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function invalidateVisualState() {
  visualEpoch++;
  observations.clear();
}

function isControllableWebTab(tab) {
  if (!tab?.id || !tab.url) return false;
  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isControlSurfaceTab(tab) {
  if (!isControllableWebTab(tab)) return false;
  try {
    const hostname = new URL(tab.url).hostname.toLowerCase();
    for (const root of CONTROL_SURFACE_HOSTS) {
      if (hostname === root || hostname.endsWith(`.${root}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isEligibleTargetTab(tab) {
  return isControllableWebTab(tab) && !isControlSurfaceTab(tab);
}

async function rememberTargetTab(tab) {
  if (!isEligibleTargetTab(tab) || !tab.id) return;
  lastTargetTabId = tab.id;
  await chrome.storage.local.set({ lastTargetTabId: tab.id });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active Chrome tab found");
  return tab;
}

async function preferredTargetTab() {
  const active = await activeTab();
  if (isEligibleTargetTab(active)) {
    await rememberTargetTab(active);
    return active;
  }

  const stored = lastTargetTabId ?? (await chrome.storage.local.get("lastTargetTabId")).lastTargetTabId;
  if (Number.isInteger(stored)) {
    const previous = await chrome.tabs.get(stored).catch(() => null);
    if (previous && isEligibleTargetTab(previous)) {
      lastTargetTabId = stored;
      return previous;
    }
  }

  const error = new Error("Open the web page you want browserControl to use, then return to Claude or ChatGPT and try again");
  error.code = "NO_TARGET_TAB";
  throw error;
}

async function installVisualInvalidationHooks(tabId) {
  await chrome.debugger.sendCommand({ tabId }, "Runtime.addBinding", { name: VISUAL_INVALIDATION_BINDING });
  await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: VISUAL_HOOK_SCRIPT });
  await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: VISUAL_HOOK_SCRIPT });
}

async function touchControlSession() {
  await chrome.storage.local.set({ lastRemoteActivityAt: Date.now() });
  await chrome.alarms.create(CONTROL_SESSION_ALARM, { delayInMinutes: CONTROL_SESSION_IDLE_MINUTES });
}

async function attach(tabId) {
  if (attachedTabId === tabId) {
    await touchControlSession();
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isEligibleTargetTab(tab)) {
    const error = new Error("browserControl can automatically attach only to normal web tabs outside the AI control surface");
    error.code = "TAB_NOT_CONTROLLABLE";
    throw error;
  }
  await rememberTargetTab(tab);
  if (attachedTabId != null) await detach(false);
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  attachedTabId = tabId;
  invalidateVisualState();
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await installVisualInvalidationHooks(tabId);
  } catch (error) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
    attachedTabId = null;
    invalidateVisualState();
    throw error;
  }
  await touchControlSession();
  await setStatus(paused ? "paused" : anyTransportConnected() ? "connected" : "disconnected");
}

async function detach(updateStatus = true) {
  const tabId = attachedTabId;
  attachedTabId = null;
  invalidateVisualState();
  if (tabId != null) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  if (updateStatus) {
    await setStatus(paused ? "paused" : anyTransportConnected() ? "connected" : "disconnected");
  }
}

async function ensureAttached() {
  if (attachedTabId != null) return attachedTabId;
  const config = await getConfig();
  if (!config.autoAttach) {
    const error = new Error("Automatic active-tab control is disabled in the browserControl extension");
    error.code = "AUTO_ATTACH_DISABLED";
    throw error;
  }
  const tab = await preferredTargetTab();
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
  if (!observationId) {
    const err = new Error("observationId is required for mutating browser actions");
    err.code = "OBSERVATION_REQUIRED";
    throw err;
  }
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
  const maxX = Math.max(r.x, r.x + r.width - 0.001);
  const maxY = Math.max(r.y, r.y + r.height - 0.001);
  return {
    x: Math.min(maxX, Math.max(r.x, r.x + (x / 1000) * r.width)),
    y: Math.min(maxY, Math.max(r.y, r.y + (y / 1000) * r.height)),
  };
}

async function observe(params = {}) {
  const tabId = await ensureAttached();
  const tab = await chrome.tabs.get(tabId);
  const vp = await viewport();
  const format = params.format || "jpeg";
  const quality = params.quality ?? 82;
  const maxLongEdge = Math.min(2000, Math.max(480, Number(params.maxLongEdge) || 1280));
  const longEdge = Math.max(vp.width, vp.height);
  const scale = longEdge > 0 ? Math.min(1, maxLongEdge / longEdge) : 1;
  const shot = await send("Page.captureScreenshot", {
    format,
    ...(format === "png" ? {} : { quality }),
    fromSurface: true,
    captureBeyondViewport: false,
    clip: {
      x: vp.pageX,
      y: vp.pageY,
      width: vp.width,
      height: vp.height,
      scale,
    },
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
    imageWidth: Math.max(1, Math.round(vp.width * scale)),
    imageHeight: Math.max(1, Math.round(vp.height * scale)),
    imageScale: scale,
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
    imageWidth: Math.round(region.width),
    imageHeight: Math.round(region.height),
    imageScale: 1,
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
  if (params.path.length > 50) throw new Error("drag path must have at most 50 points");
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
  const deltaX = Number(params.deltaX || 0);
  const deltaY = Number(params.deltaY || 0);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error("scroll deltas must be finite numbers");
  if (Math.abs(deltaX) > 4000 || Math.abs(deltaY) > 4000) throw new Error("scroll deltas must be within ±4000");
  const p = normalizedPointToSource(params.x ?? 500, params.y ?? 500, record);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX, deltaY });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function typeText(params) {
  assertFresh(params.observationId);
  const text = String(params.text ?? "");
  if (text.length > 5000) throw new Error("type text must be at most 5000 characters");
  await send("Input.insertText", { text });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function keypress(params) {
  assertFresh(params.observationId);
  const events = keyEvents(params.keys);
  await send("Input.dispatchKeyEvent", events.down);
  await send("Input.dispatchKeyEvent", events.up);
  invalidateVisualState();
  return { success: true, visualEpoch };
}

function assertSafeNavigationUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url || url.length > 2048 || /[\x00-\x20]/.test(url)) {
    throw new Error("Blocked unsafe navigation URL (only http/https allowed)");
  }
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error("Blocked unsafe navigation URL (only http/https allowed)");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`Blocked navigation to ${protocol} (only http/https allowed)`);
  }
  return url;
}

function assertSafeNewTabUrl(rawUrl) {
  if (rawUrl == null || rawUrl === "" || rawUrl === "about:blank") return "about:blank";
  return assertSafeNavigationUrl(rawUrl);
}

async function navigate(params) {
  assertFresh(params.observationId);
  if (!params.url) throw new Error("url is required");
  const safeUrl = assertSafeNavigationUrl(params.url);
  await send("Page.navigate", { url: safeUrl });
  invalidateVisualState();
  return { success: true, visualEpoch, url: safeUrl };
}

async function historyAction(params, direction) {
  assertFresh(params.observationId);
  const tabId = await ensureAttached();
  if (direction === "back") await chrome.tabs.goBack(tabId);
  else await chrome.tabs.goForward(tabId);
  invalidateVisualState();
  return { success: true, visualEpoch };
}

async function reload(params) {
  assertFresh(params.observationId);
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
  assertFresh(params.observationId);
  const tabId = Number(params.targetId);
  if (!Number.isInteger(tabId)) throw new Error("targetId must be a Chrome tab id");
  const tab = await chrome.tabs.get(tabId);
  if (!isEligibleTargetTab(tab)) throw new Error("browserControl cannot switch control to an AI control surface or restricted tab");
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await attach(tabId);
  return { success: true, targetId: String(tabId), visualEpoch };
}

async function newTab(params = {}) {
  assertFresh(params.observationId);
  const safeUrl = assertSafeNewTabUrl(params.url);
  const tab = await chrome.tabs.create({ url: safeUrl, active: true });
  if (!tab.id) throw new Error("Failed to create tab");
  if (safeUrl !== "about:blank") await attach(tab.id);
  return { success: true, targetId: String(tab.id), visualEpoch };
}

async function closeTab(params = {}) {
  assertFresh(params.observationId);
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
  assertFresh(params.observationId);
  await send("Page.handleJavaScriptDialog", { accept: !!params.accept, ...(params.promptText != null ? { promptText: String(params.promptText) } : {}) });
  invalidateVisualState();
  return { success: true, visualEpoch };
}

function claimTransportLease(source, method) {
  if (!MUTATING_RPC_METHODS.has(method)) return;
  const now = Date.now();
  if (transportLeaseOwner && now >= transportLeaseExpiresAt) {
    transportLeaseOwner = null;
    transportLeaseExpiresAt = 0;
  }

  if (source === "local") {
    transportLeaseOwner = "local";
    transportLeaseExpiresAt = now + TRANSPORT_LEASE_MS;
    return;
  }

  if (transportLeaseOwner === "local") {
    const error = new Error("A local browserControl agent currently controls this Chrome session");
    error.code = "DEVICE_BUSY_LOCAL";
    throw error;
  }

  transportLeaseOwner = "remote";
  transportLeaseExpiresAt = now + TRANSPORT_LEASE_MS;
}

async function handleRpc(request, source = "remote") {
  if (paused && request.method !== "status") {
    throw Object.assign(new Error("CONTROL_PAUSED_BY_USER"), { code: "CONTROL_PAUSED" });
  }
  claimTransportLease(source, request.method);
  if (request.method !== "status") await touchControlSession();
  switch (request.method) {
    case "status": return {
      attachedTabId,
      visualEpoch,
      paused,
      connected: anyTransportConnected(),
      localConnected,
      remoteConnected: remoteConnected(),
      manualDisconnect,
      transportLease: {
        owner: transportLeaseOwner,
        expiresAt: transportLeaseExpiresAt,
      },
    };
    case "observe": return observe(request.params || {});
    case "inspect_region": return inspectRegion(request.params || {});
    case "move": return mouseMove(request.params || {});
    case "click": return mouseClick(request.params || {}, 1);
    case "double_click": return mouseClick(request.params || {}, 2);
    case "drag": return drag(request.params || {});
    case "scroll": return scroll(request.params || {});
    case "type": return typeText(request.params || {});
    case "keypress": return keypress(request.params || {});
    case "navigate": return navigate(request.params || {});
    case "back": return historyAction(request.params || {}, "back");
    case "forward": return historyAction(request.params || {}, "forward");
    case "reload": return reload(request.params || {});
    case "tabs": return listTabs();
    case "switch_tab": return switchTab(request.params || {});
    case "new_tab": return newTab(request.params || {});
    case "close_tab": return closeTab(request.params || {});
    case "handle_dialog": return handleDialog(request.params || {});
    default: throw new Error(`Unknown RPC method: ${request.method}`);
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

async function ensureGatewayPermission(gatewayUrl) {
  if (gatewayUrl === PRODUCTION_GATEWAY_URL) return;
  const origin = getGatewayPermissionOrigin(gatewayUrl);
  if (!origin) throw new Error("Invalid developer gateway URL");
  const present = await chrome.permissions.contains({ origins: [origin] });
  if (present) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error("Developer relay access was not granted");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function enrollDevice(gatewayUrl) {
  await ensureGatewayPermission(gatewayUrl);
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const nonceHash = await sha256Hex(nonce);
  const platform = await chrome.runtime.getPlatformInfo().catch(() => ({ os: "unknown" }));
  const headers = {
    "Content-Type": "application/json",
    [ENROLLMENT_HEADER]: ENROLLMENT_HEADER_VALUE,
  };

  const started = await fetch(getGatewayHttpUrl(gatewayUrl, "/enroll/start"), {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify({ nonceHash, name: `Chrome on ${platform.os || "unknown"}` }),
  });
  const startPayload = await started.json().catch(() => ({}));
  if (!started.ok || !startPayload.ticket) {
    throw new Error(startPayload.error || `Enrollment failed with HTTP ${started.status}`);
  }

  const claimed = await fetch(getGatewayHttpUrl(gatewayUrl, "/enroll/claim"), {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify({ ticket: startPayload.ticket, nonce }),
  });
  const credential = await claimed.json().catch(() => ({}));
  if (!claimed.ok || !credential.deviceId || !credential.deviceToken || !credential.mcpToken) {
    throw new Error(credential.error || `Enrollment claim failed with HTTP ${claimed.status}`);
  }
  return credential;
}

async function connectGateway() {
  clearReconnectTimer();
  if (manualDisconnect || gatewayConnectInFlight) return;
  const config = await getConfig();
  if (!config.deviceToken) return;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;

  gatewayConnectInFlight = true;
  try {
    let url;
    try {
      url = new URL(config.gatewayUrl);
      if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Gateway URL must use ws:// or wss://");
    } catch (error) {
      await setStatus("error", { gatewayUrl: config.gatewayUrl, lastError: error.message });
      return;
    }

    const healthUrl = getLoopbackHealthUrl(config.gatewayUrl);
    const permissionOrigin = getGatewayPermissionOrigin(config.gatewayUrl);
    const mayProbeHealth = healthUrl && permissionOrigin
      ? await chrome.permissions.contains({ origins: [permissionOrigin] })
      : false;
    if (healthUrl && mayProbeHealth) {
      const probeController = new AbortController();
      const probeTimer = setTimeout(() => probeController.abort(), 1500);
      try {
        const response = await fetch(healthUrl, { cache: "no-store", signal: probeController.signal });
        if (!response.ok) throw new Error(`Gateway health check returned HTTP ${response.status}`);
      } catch {
        socket = null;
        await setStatus("disconnected", { gatewayUrl: config.gatewayUrl });
        if (!manualDisconnect && config.autoReconnect) {
          const delay = getReconnectDelay(reconnectAttempts++);
          reconnectTimer = setTimeout(() => void connectGateway(), delay);
        }
        return;
      } finally {
        clearTimeout(probeTimer);
      }
    }

    const currentSocket = new WebSocket(url.toString(), [`browsercontrol.${config.deviceToken}`]);
    socket = currentSocket;

    currentSocket.onopen = async () => {
      if (socket !== currentSocket) return;
      reconnectAttempts = 0;
      await setStatus(paused ? "paused" : "connected", { gatewayUrl: config.gatewayUrl, lastError: "" });
      if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({ type: "hello", version: 1, userAgent: navigator.userAgent }));
      }
    };

    currentSocket.onmessage = async (event) => {
      if (socket !== currentSocket) return;
      let request;
      try { request = JSON.parse(event.data); } catch { return; }
      if (!request?.id || !request?.method) return;
      try {
        const result = await handleRpc(request, "remote");
        if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ id: request.id, ok: true, result }));
        }
      } catch (error) {
        if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ id: request.id, ok: false, error: { code: error?.code || "RPC_ERROR", message: error?.message || String(error) } }));
        }
      }
    };

    currentSocket.onclose = async (event) => {
      if (socket !== currentSocket) return;
      socket = null;
      const revoked = event.code === 4003;
      if (revoked) {
        manualDisconnect = true;
        await chrome.storage.local.set({ deviceId: "", deviceToken: "", mcpToken: "" });
        await chrome.alarms.clear(CONTROL_SESSION_ALARM);
        await detach(false);
        await setStatus("error", { lastError: "This device credential was revoked. Click Connect to securely enroll again." });
        return;
      }
      await setStatus(paused ? "paused" : "disconnected");
      const latestConfig = await getConfig();
      if (!manualDisconnect && latestConfig.autoReconnect) {
        const delay = getReconnectDelay(reconnectAttempts++);
        reconnectTimer = setTimeout(() => void connectGateway(), delay);
      }
    };

    currentSocket.onerror = () => {
      if (socket === currentSocket) void setStatus("disconnected", { lastError: "Could not reach the browserControl relay. It will retry automatically." });
    };
  } finally {
    gatewayConnectInFlight = false;
  }
}

async function replaceGatewayConnection() {
  clearReconnectTimer();
  reconnectAttempts = 0;
  const previousSocket = socket;
  socket = null;
  if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
    try { previousSocket.close(1000, "Gateway configuration changed"); } catch {}
  }
  await connectGateway();
}

async function connectProduction() {
  const current = await getConfig();
  const gatewayUrl = resolveGatewayUrl(current);
  manualDisconnect = false;
  paused = false;
  await chrome.storage.local.set({ manualDisconnect: false, paused: false, gatewayUrl, lastError: "" });

  let credential = current.deviceId && current.deviceToken && current.mcpToken
    ? { deviceId: current.deviceId, deviceToken: current.deviceToken, mcpToken: current.mcpToken }
    : null;
  if (!credential) credential = await enrollDevice(gatewayUrl);

  await chrome.storage.local.set({
    gatewayUrl,
    deviceId: credential.deviceId,
    deviceToken: credential.deviceToken,
    mcpToken: credential.mcpToken,
    autoReconnect: true,
    autoAttach: current.autoAttach !== false,
    followActiveTab: current.followActiveTab !== false,
    lastError: "",
  });
  await replaceGatewayConnection();
  return { ok: true, deviceId: credential.deviceId };
}

async function followActiveTabIfNeeded(tabId) {
  if (followTabInFlight || attachedTabId == null || paused) return;
  const config = await getConfig();
  if (!config.followActiveTab) return;
  followTabInFlight = true;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (isControlSurfaceTab(tab)) return;
    if (!isControllableWebTab(tab)) {
      await chrome.alarms.clear(CONTROL_SESSION_ALARM);
      await detach();
      return;
    }
    await rememberTargetTab(tab);
    await attach(tabId);
  } catch {
    // Tab switches can race with tab close/navigation; the next browser request can reattach.
  } finally {
    followTabInFlight = false;
  }
}

async function noteActiveTarget(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isEligibleTargetTab(tab)) await rememberTargetTab(tab);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  if (method === "Runtime.bindingCalled" && params?.name === VISUAL_INVALIDATION_BINDING) {
    invalidateVisualState();
    return;
  }
  if ([
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Page.loadEventFired",
    "Page.javascriptDialogOpening",
    "Runtime.executionContextsCleared",
  ].includes(method)) {
    invalidateVisualState();
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    invalidateVisualState();
    void chrome.alarms.clear(CONTROL_SESSION_ALARM);
    void setStatus(paused ? "paused" : anyTransportConnected() ? "connected" : "disconnected");
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void noteActiveTarget(tabId);
  void followActiveTabIfNeeded(tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (!tab?.id) return;
    void noteActiveTarget(tab.id);
    if (attachedTabId != null && !paused) return followActiveTabIfNeeded(tab.id);
  }).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CONTROL_SESSION_ALARM) return;
  void detach();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "getStatus") {
      const stored = await chrome.storage.local.get(null);
      return {
        ...DEFAULT_CONFIG,
        ...stored,
        gatewayUrl: resolveGatewayUrl(stored),
        attachedTabId,
        visualEpoch,
        paused,
        manualDisconnect,
        localConnected,
        remoteConnected: remoteConnected(),
      };
    }
    if (message.type === "connectProduction") return connectProduction();
    if (message.type === "probeLocal") {
      await localConnection?.connect();
      return { ok: true, localConnected };
    }
    if (message.type === "getOAuthCredential") {
      const senderUrl = String(sender?.url || "");
      if (!senderUrl.startsWith(`${PRODUCTION_HTTP_ORIGIN}/authorize`) && !senderUrl.startsWith(`${PRODUCTION_HTTP_ORIGIN}/oauth/authorize`)) {
        return { ok: false };
      }
      const config = await getConfig();
      return config.mcpToken ? { ok: true, mcpToken: config.mcpToken, deviceId: config.deviceId } : { ok: false };
    }
    if (message.type === "updatePreferences") {
      const preferences = message.preferences || {};
      const update = {
        ...(typeof preferences.autoAttach === "boolean" ? { autoAttach: preferences.autoAttach } : {}),
        ...(typeof preferences.followActiveTab === "boolean" ? { followActiveTab: preferences.followActiveTab } : {}),
      };
      await chrome.storage.local.set(update);
      if (update.autoAttach === false && attachedTabId != null) {
        await chrome.alarms.clear(CONTROL_SESSION_ALARM);
        await detach();
      }
      return { ok: true };
    }
    if (message.type === "saveConfig") {
      manualDisconnect = false;
      await chrome.storage.local.set(message.config || {});
      await replaceGatewayConnection();
      return { ok: true };
    }
    if (message.type === "shareActiveTab") {
      const tab = await preferredTargetTab();
      await attach(tab.id);
      return { ok: true, targetId: String(tab.id) };
    }
    if (message.type === "togglePause") {
      paused = !paused;
      invalidateVisualState();
      if (paused) {
        await chrome.alarms.clear(CONTROL_SESSION_ALARM);
        await detach(false);
      }
      await setStatus(paused ? "paused" : anyTransportConnected() ? "connected" : "disconnected");
      return { ok: true, paused };
    }
    if (message.type === "disconnect") {
      manualDisconnect = true;
      clearReconnectTimer();
      await chrome.alarms.clear(CONTROL_SESSION_ALARM);
      const closingSocket = socket;
      socket = null;
      if (closingSocket) {
        try { closingSocket.close(1000, "Disconnected by user"); } catch {}
      }
      await detach(false);
      await setStatus(localConnected ? "connected" : "disconnected");
      return { ok: true };
    }
    return { ok: false };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

void (async () => {
  const stored = await chrome.storage.local.get(["paused", "manualDisconnect", "lastTargetTabId"]);
  paused = !!stored.paused;
  manualDisconnect = !!stored.manualDisconnect;
  lastTargetTabId = Number.isInteger(stored.lastTargetTabId) ? stored.lastTargetTabId : null;
  const current = await activeTab().catch(() => null);
  if (current && isEligibleTargetTab(current)) await rememberTargetTab(current);

  localConnection = createLocalConnection({
    handleRpc,
    onStateChange: ({ connected }) => {
      localConnected = !!connected;
      void setStatus(anyTransportConnected() ? "connected" : "disconnected");
    },
  });

  await connectGateway();
})();
