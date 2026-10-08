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
import { keyDefinition, keyEvents } from "./keyboard.js";
import { captureViewportScreenshot } from "./screenshot.js";
import {
  randomBetween, bezierPath, stepTimings,
  preClickDelayMs, clickHoldMs, clickJitter,
  keyHoldMs, charFlightMs, wordPauseMs, shortcutHoldMs,
  scrollChunks, scrollStepDelayMs,
  wordCount, minDwellMs,
  humanClickPoint, naturalRestingPoint,
} from "./human-input.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUGGER_VERSION = "1.3";
const VISUAL_INVALIDATION_BINDING = "__browserControlVisualInvalidated";
const CONTROL_SESSION_ALARM = "browsercontrol-control-session-idle";
const CONTROL_SESSION_IDLE_MINUTES = 15;
const ENROLLMENT_HEADER = "X-BrowserControl-Enrollment";
const ENROLLMENT_HEADER_VALUE = "extension-v1";
const TRANSPORT_LEASE_MS = 60_000;
const AGENT_INPUT_ECHO_DELIVERY_TTL_MS = 1_000;
const POINTER_EVENT_THROTTLE_MS = 33;
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
  "evaluate",
  "click_element",
  "type_element",
  "select_and_advance",
  "action_queue",
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
  let lastPointerSentAt = 0;
  let pointerHost = null;
  let pointerRing = null;
  let pointerHideTimer = null;
  let pointerShown = false;
  let overlaySuppressed = true;

  const applyPointerVisibility = () => {
    if (!pointerHost?.isConnected) return;
    pointerHost.style.setProperty("visibility", pointerShown && !overlaySuppressed ? "visible" : "hidden", "important");
  };

  const ensurePointerOverlay = () => {
    if (pointerHost?.isConnected) return pointerHost;
    const host = document.createElement("div");
    host.setAttribute("data-browsercontrol-pointer", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = [
      "all:initial !important",
      "position:fixed !important",
      "left:0 !important",
      "top:0 !important",
      "width:24px !important",
      "height:32px !important",
      "pointer-events:none !important",
      "user-select:none !important",
      "z-index:2147483647 !important",
      "visibility:hidden !important",
      "transform:translate3d(-100px,-100px,0) !important",
      "contain:layout style paint !important",
    ].join(";");

    const shadow = host.attachShadow({ mode: "closed" });
    const ring = document.createElement("span");
    ring.style.cssText = [
      "position:absolute",
      "left:-10px",
      "top:-10px",
      "width:24px",
      "height:24px",
      "border:2px solid rgba(66,133,244,.92)",
      "border-radius:999px",
      "box-sizing:border-box",
      "opacity:0",
      "pointer-events:none",
    ].join(";");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 32");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "32");
    svg.style.cssText = "display:block;width:24px;height:32px;overflow:visible;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35));";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M2 1.5V24.5L8.2 18.5L12.7 29L17 27.1L12.6 16.9H21.3L2 1.5Z");
    path.setAttribute("fill", "#111111");
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    shadow.appendChild(ring);
    shadow.appendChild(svg);

    const mount = () => {
      const parent = document.documentElement || document.body;
      if (!parent || host.isConnected) return;
      parent.appendChild(host);
    };
    mount();
    if (!host.isConnected) addEventListener("DOMContentLoaded", mount, { once: true });
    pointerHost = host;
    pointerRing = ring;
    applyPointerVisibility();
    return host;
  };

  const showPointer = (x, y, pulse = false) => {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    const host = ensurePointerOverlay();
    if (!host) return;
    pointerShown = true;
    host.style.setProperty("transform", "translate3d(" + (px - 2) + "px," + (py - 1.5) + "px,0)", "important");
    host.setAttribute("data-x", String(px));
    host.setAttribute("data-y", String(py));
    applyPointerVisibility();
    clearTimeout(pointerHideTimer);
    pointerHideTimer = setTimeout(() => {
      pointerShown = false;
      applyPointerVisibility();
    }, 30000);
    if (pulse && pointerRing?.animate) {
      for (const animation of pointerRing.getAnimations()) animation.cancel();
      pointerRing.animate([
        { opacity: 0.9, transform: "scale(.35)" },
        { opacity: 0, transform: "scale(1.45)" },
      ], { duration: 320, easing: "ease-out" });
    }
  };

  globalThis.__browserControlSetPointerOverlayVisibility = (visible) => {
    overlaySuppressed = visible === false;
    applyPointerVisibility();
  };

  const notify = (payload) => {
    try {
      globalThis.${VISUAL_INVALIDATION_BINDING}(JSON.stringify({
        at: Date.now(),
        ...payload,
      }));
    } catch {}
  };
  const pointerPayload = (event, reason, kind = "input") => ({
    kind,
    reason,
    x: Number(event?.clientX),
    y: Number(event?.clientY),
    viewportWidth: Number(globalThis.innerWidth),
    viewportHeight: Number(globalThis.innerHeight),
  });
  addEventListener("pointermove", (event) => {
    if (event?.isTrusted === false) return;
    showPointer(event?.clientX, event?.clientY, false);
    const now = Date.now();
    if (now - lastPointerSentAt < ${POINTER_EVENT_THROTTLE_MS}) return;
    lastPointerSentAt = now;
    notify(pointerPayload(event, "user-pointermove", "pointer"));
  }, true);
  for (const eventName of ["pointerdown", "keydown", "beforeinput", "input", "change", "wheel", "touchstart"]) {
    addEventListener(eventName, (event) => {
      if (event?.isTrusted === false) return;
      if (eventName === "pointerdown") {
        showPointer(event?.clientX, event?.clientY, true);
        notify(pointerPayload(event, "user-pointerdown"));
        return;
      }
      if (eventName === "wheel") {
        showPointer(event?.clientX, event?.clientY, false);
        notify(pointerPayload(event, "user-wheel"));
        return;
      }
      notify({ kind: "input", reason: "user-" + eventName });
    }, true);
  }
})();`;

let socket = null;
let localConnection = null;
let localConnected = false;
let attachedTabId = null;
let attachedMainFrameId = null;
let lastTargetTabId = null;
let visualEpoch = 0;
let lastInvalidationReason = "startup";
let lastInvalidatedAt = 0;
let pointerState = null;
let paused = false;
let manualDisconnect = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let gatewayConnectInFlight = false;
let followTabInFlight = false;
let transportLeaseOwner = null;
let transportLeaseExpiresAt = 0;
const observations = new Map();
const agentInputWindows = [];
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
    lastInvalidationReason,
    lastInvalidatedAt,
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

function invalidateVisualState(reason = "browser-control-action") {
  visualEpoch++;
  lastInvalidationReason = String(reason || "browser-control-action");
  lastInvalidatedAt = Date.now();
  observations.clear();
}

function clamp1000(value) {
  return Math.max(0, Math.min(1000, value));
}

function clearPointer() {
  pointerState = null;
}

function setPointerFromViewport(x, y, viewportWidth, viewportHeight, source, updatedAt = Date.now(), tabId = attachedTabId) {
  const px = Number(x);
  const py = Number(y);
  const width = Number(viewportWidth);
  const height = Number(viewportHeight);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isInteger(tabId)) return;
  pointerState = {
    known: true,
    x: clamp1000((px / width) * 1000),
    y: clamp1000((py / height) * 1000),
    coordinateSpace: "viewport_normalized_1000",
    insideViewport: px >= 0 && py >= 0 && px <= width && py <= height,
    source: source === "user" ? "user" : "agent",
    updatedAt: Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : Date.now(),
    targetId: String(tabId),
  };
}

function setPointerFromRecordPoint(point, record, source = "agent") {
  setPointerFromViewport(point.x, point.y, record.viewportWidth, record.viewportHeight, source, Date.now(), record.tabId);
}

function pointerMetadata() {
  if (!pointerState || String(attachedTabId) !== pointerState.targetId) {
    return { known: false, coordinateSpace: "viewport_normalized_1000" };
  }
  return { ...pointerState };
}

async function setPointerOverlayVisibility(visible, tabId = attachedTabId) {
  if (!Number.isInteger(tabId)) return;
  await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `globalThis.__browserControlSetPointerOverlayVisibility?.(${visible ? "true" : "false"})`,
  }).catch(() => undefined);
}

function inputEchoReasons(method, params = {}) {
  if (method === "Input.dispatchMouseEvent") {
    if (params.type === "mouseMoved") return new Set(["user-pointermove"]);
    if (params.type === "mousePressed") return new Set(["user-pointerdown"]);
    if (params.type === "mouseWheel") return new Set(["user-wheel"]);
  }
  if (method === "Input.insertText") return new Set(["user-beforeinput", "user-input"]);
  if (method === "Input.dispatchKeyEvent" && ["keyDown", "rawKeyDown"].includes(params.type)) {
    return new Set(["user-keydown"]);
  }
  return null;
}

function beginAgentInputWindow(method, params = {}) {
  const reasons = inputEchoReasons(method, params);
  if (!reasons) return null;
  const window = { reasons, startedAt: Date.now(), endedAt: Infinity };
  agentInputWindows.push(window);
  return window;
}

function endAgentInputWindow(window) {
  if (window) window.endedAt = Date.now();
}

function parseVisualInvalidationPayload(payload) {
  const raw = String(payload || "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        kind: String(parsed.kind || "input"),
        reason: String(parsed.reason || "user-control-input"),
        at: Number.isFinite(Number(parsed.at)) ? Number(parsed.at) : Date.now(),
        x: Number(parsed.x),
        y: Number(parsed.y),
        viewportWidth: Number(parsed.viewportWidth),
        viewportHeight: Number(parsed.viewportHeight),
      };
    }
  } catch {}
  return { kind: "input", reason: raw || "user-control-input", at: Date.now() };
}

function consumeAgentInputEcho(event) {
  const now = Date.now();
  for (let i = agentInputWindows.length - 1; i >= 0; i--) {
    const window = agentInputWindows[i];
    const expired = Number.isFinite(window.endedAt)
      && now - window.endedAt > AGENT_INPUT_ECHO_DELIVERY_TTL_MS;
    if (expired || window.reasons.size === 0) {
      agentInputWindows.splice(i, 1);
      continue;
    }
    if (!window.reasons.has(event.reason)) continue;
    if (event.at < window.startedAt || event.at > window.endedAt) continue;
    window.reasons.delete(event.reason);
    if (window.reasons.size === 0) agentInputWindows.splice(i, 1);
    return true;
  }
  return false;
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

function isBootstrapTab(tab) {
  if (!tab?.id) return false;
  const url = String(tab.url || "");
  return !url || url === "about:blank" || url.startsWith("chrome://newtab") || url.startsWith("chrome://new-tab-page");
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

  const error = new Error("Open a web page or ask the agent to navigate the active Chrome New Tab page");
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
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (err) {
    if (err.message && err.message.includes('already attached')) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    } else {
      throw err;
    }
  }
  attachedTabId = tabId;
  attachedMainFrameId = null;
  clearPointer();
  invalidateVisualState("tab-attached");
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    const frameTree = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
    attachedMainFrameId = frameTree?.frameTree?.frame?.id || null;
    await installVisualInvalidationHooks(tabId);
  } catch (error) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
    attachedTabId = null;
    attachedMainFrameId = null;
    clearPointer();
    invalidateVisualState("attach-failed");
    throw error;
  }
  await touchControlSession();
  await setStatus(paused ? "paused" : anyTransportConnected() ? "connected" : "disconnected");
}

async function detach(updateStatus = true) {
  const tabId = attachedTabId;
  attachedTabId = null;
  attachedMainFrameId = null;
  clearPointer();
  invalidateVisualState("tab-detached");
  if (tabId != null) {
    await setPointerOverlayVisibility(false, tabId);
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
  const inputWindow = beginAgentInputWindow(method, params);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } finally {
    endAgentInputWindow(inputWindow);
  }
}

async function viewport() {
  const metrics = await send("Page.getLayoutMetrics");
  const vv = metrics.cssVisualViewport || metrics.visualViewport;
  // Native screenshots include scrollbars; CSS visual viewport dimensions do not.
  const surface = await send("Runtime.evaluate", {
    expression: "({ width: innerWidth / (visualViewport?.scale || 1), height: innerHeight / (visualViewport?.scale || 1) })",
    returnByValue: true,
  });
  return {
    width: vv?.clientWidth ?? vv?.width,
    height: vv?.clientHeight ?? vv?.height,
    surfaceWidth: surface.result.value.width,
    surfaceHeight: surface.result.value.height,
    pageX: vv?.pageX ?? 0,
    pageY: vv?.pageY ?? 0,
  };
}

function mimeType(format) {
  return format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
}

async function captureScreenshot(params) {
  await setPointerOverlayVisibility(false);
  try {
    return await send("Page.captureScreenshot", params);
  } finally {
    await setPointerOverlayVisibility(true);
  }
}

function rememberObservation(record) {
  observations.set(record.observationId, record);
  while (observations.size > MAX_OBSERVATIONS) {
    const oldest = observations.keys().next().value;
    observations.delete(oldest);
  }
}

function assertFresh(observationId, { softMode = false } = {}) {
  if (!observationId) {
    const err = new Error("observationId is required for visual or focus-dependent browser actions");
    err.code = "OBSERVATION_REQUIRED";
    throw err;
  }
  const record = observations.get(String(observationId));
  if (!record) {
    const err = new Error("STALE_OBSERVATION: observation expired or not found");
    err.code = "STALE_OBSERVATION";
    throw err;
  }
  if (record.tabId !== attachedTabId) {
    const err = new Error("STALE_OBSERVATION: tab changed since observation");
    err.code = "STALE_OBSERVATION";
    throw err;
  }
  if (!softMode && record.visualEpoch !== visualEpoch) {
    const age = Date.now() - (lastInvalidatedAt || 0);
    const cosmetic = ["agent-move", "agent-scroll", "resize", "animation", "agent-type", "agent-click-element", "agent-type-element"]
      .some((r) => lastInvalidationReason?.includes(r));
    if (!cosmetic || age > 2000) {
      const err = new Error(`STALE_OBSERVATION: control context changed after the screenshot (${lastInvalidationReason})`);
      err.code = "STALE_OBSERVATION";
      throw err;
    }
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
  const shot = await captureViewportScreenshot(captureScreenshot, vp, { format, quality, maxLongEdge });
  const observationId = `${tabId}:${visualEpoch}:${crypto.randomUUID()}`;
  const sourceRegion = { x: 0, y: 0, width: vp.width, height: vp.height };
  rememberObservation({ observationId, tabId, visualEpoch, sourceRegion, viewportWidth: vp.width, viewportHeight: vp.height });
  return {
    observationId,
    visualEpoch,
    targetId: String(tabId),
    url: tab.url || "",
    title: tab.title || "",
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    imageWidth: shot.width,
    imageHeight: shot.height,
    imageScale: shot.scale,
    sourceRegion,
    pointer: pointerMetadata(),
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
  const shot = await captureViewportScreenshot(captureScreenshot, vp, { format, quality, region });
  const observationId = `${attachedTabId}:${visualEpoch}:${crypto.randomUUID()}`;
  rememberObservation({ observationId, tabId: attachedTabId, visualEpoch, sourceRegion: region, viewportWidth: vp.width, viewportHeight: vp.height });
  return {
    observationId,
    sourceObservationId: params.observationId,
    visualEpoch,
    targetId: String(attachedTabId),
    imageWidth: shot.width,
    imageHeight: shot.height,
    imageScale: shot.scale,
    sourceRegion: region,
    pointer: pointerMetadata(),
    kind: "region",
    coordinateSpace: "normalized_1000",
    mimeType: mimeType(format),
    image: shot.data,
  };
}

// Page-side helpers shared by browser_snapshot and every ref-based resolver. A ref is the
// 1-based position in bcInteractiveElements(), so snapshot labels and click/type targets
// always agree on which element a number means.
const ELEMENT_INDEX_HELPERS = `
  const BC_SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','LINK','META','BR','WBR','HEAD']);
  const BC_INTERACTIVE_ROLES = new Set(['button','link','textbox','checkbox','radio','combobox','listbox','menuitem','tab','switch','slider','searchbox','option','menuitemcheckbox','menuitemradio','treeitem']);
  function bcVisible(el) {
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return true;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    return !!el.offsetParent;
  }
  function bcInteractive(el) {
    const tag = el.tagName;
    if (['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY'].includes(tag)) return true;
    const role = el.getAttribute('role');
    if (role && BC_INTERACTIVE_ROLES.has(role)) return true;
    if (el.contentEditable === 'true') return true;
    if (el.getAttribute('tabindex') !== null && Number(el.getAttribute('tabindex')) >= 0) return true;
    if (el.onclick || el.getAttribute('onclick')) return true;
    return false;
  }
  function bcIsSvg(el) {
    return el.tagName === 'SVG' || el.namespaceURI === 'http://www.w3.org/2000/svg';
  }
  function bcInteractiveElements() {
    const found = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (BC_SKIP_TAGS.has(node.tagName) || bcIsSvg(node) || !bcVisible(node)) return;
      if (bcInteractive(node)) found.push(node);
      for (const child of node.children) walk(child);
    };
    walk(document.body);
    return found;
  }
`;

const DOM_SNAPSHOT_SCRIPT = `(() => {
  ${ELEMENT_INDEX_HELPERS}
  const SKIP = BC_SKIP_TAGS;
  const INLINE = new Set(['SPAN','EM','STRONG','B','I','U','A','ABBR','CODE','SMALL','SUB','SUP','MARK','TIME','LABEL']);
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  function norm(v, max) { return Math.round(Math.max(0, Math.min(1000, (v / max) * 1000))); }
  const vis = bcVisible;
  const interactive = bcInteractive;
  const refs = new Map(bcInteractiveElements().map((el, i) => [el, i + 1]));
  function attrs(el) {
    const parts = [];
    if (el.id) parts.push('id="' + el.id + '"');
    if (el.name) parts.push('name="' + el.name + '"');
    if (el.type && el.tagName === 'INPUT') parts.push('type="' + el.type + '"');
    if (el.tagName === 'A' && el.href) parts.push('href="' + el.getAttribute('href') + '"');
    if (el.placeholder) parts.push('placeholder="' + el.placeholder + '"');
    if (el.getAttribute('aria-label')) parts.push('aria-label="' + el.getAttribute('aria-label') + '"');
    if (el.getAttribute('role')) parts.push('role="' + el.getAttribute('role') + '"');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const v = el.value || '';
      parts.push('value="' + v.slice(0, 200) + '"');
    }
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      if (opt) parts.push('selected="' + opt.text + '"');
    }
    if (el.checked !== undefined) parts.push(el.checked ? 'checked' : 'unchecked');
    if (el.disabled) parts.push('disabled');
    if (el.readOnly) parts.push('readonly');
    return parts.join(' ');
  }
  function coords(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return '';
    const cx = norm(r.left + r.width / 2, vw);
    const cy = norm(r.top + r.height / 2, vh);
    return ' @(' + cx + ',' + cy + ')';
  }
  const lines = [];
  function text(el) {
    let t = '';
    for (const c of el.childNodes) {
      if (c.nodeType === 3) t += c.textContent;
    }
    return t.replace(/\\s+/g, ' ').trim().slice(0, 500);
  }
  function refLine(el, ref, pad) {
    const a = attrs(el);
    const t = text(el);
    const label = t ? ' "' + t.slice(0, 200) + '"' : '';
    return pad + '[' + ref + '] ' + el.tagName.toLowerCase() + (a ? ' ' + a : '') + label + coords(el);
  }
  function walk(el, depth) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    if (SKIP.has(tag)) return;
    if (bcIsSvg(el)) {
      lines.push('  '.repeat(depth) + '[svg]');
      return;
    }
    if (!vis(el)) return;
    const isI = interactive(el);
    const pad = '  '.repeat(depth);
    const t = text(el);
    const tagLower = tag.toLowerCase();
    if (isI) {
      lines.push(refLine(el, refs.get(el), pad));
    } else if (['H1','H2','H3','H4','H5','H6'].includes(tag)) {
      lines.push(pad + tagLower + ': ' + t);
    } else if (tag === 'IMG') {
      const alt = el.alt || el.getAttribute('aria-label') || '';
      lines.push(pad + '[img' + (alt ? ' alt="' + alt + '"' : '') + ']');
    } else if (tag === 'TABLE') {
      lines.push(pad + '[table]');
    } else if (tag === 'TR') {
      const cells = Array.from(el.children)
        .filter(c => c.tagName === 'TD' || c.tagName === 'TH')
        .map(c => text(c) || (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200))
        .filter(Boolean);
      if (cells.length) lines.push(pad + '  row: ' + cells.join(' | '));
      // List every numbered element inside the row so no ref is hidden from the agent.
      for (const node of el.querySelectorAll('*')) {
        const ref = refs.get(node);
        if (ref) lines.push(refLine(node, ref, pad + '    '));
      }
      return;
    } else if (INLINE.has(tag) || tag === 'P' || tag === 'LI' || tag === 'DIV' || tag === 'SECTION' || tag === 'MAIN' || tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE' || tag === 'ARTICLE') {
      if (t && !el.children.length) {
        lines.push(pad + t);
        return;
      }
    }
    for (const child of el.children) walk(child, depth + (isI ? 1 : (tag === 'BODY' ? 0 : 1)));
  }
  walk(document.body, 0);
  return {
    dom: lines.join('\\n'),
    interactiveCount: refs.size,
    viewportWidth: vw,
    viewportHeight: vh,
  };
})()`;

async function snapshot(params = {}) {
  const tabId = await ensureAttached();
  const tab = await chrome.tabs.get(tabId);
  const vp = await viewport();
  const result = await send("Runtime.evaluate", {
    expression: DOM_SNAPSHOT_SCRIPT,
    returnByValue: true,
  });
  const data = result?.result?.value || {};
  const observationId = `${tabId}:${visualEpoch}:${crypto.randomUUID()}`;
  const sourceRegion = { x: 0, y: 0, width: vp.width, height: vp.height };
  rememberObservation({ observationId, tabId, visualEpoch, sourceRegion, viewportWidth: vp.width, viewportHeight: vp.height });
  return {
    observationId,
    visualEpoch,
    targetId: String(tabId),
    url: tab.url || "",
    title: tab.title || "",
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    pointer: pointerMetadata(),
    kind: "snapshot",
    coordinateSpace: "normalized_1000",
    dom: data.dom || "",
    interactiveCount: data.interactiveCount || 0,
  };
}

/** Move cursor along an organic Bézier curve from current pointer to target viewport coords. */
async function humanMouseMoveTo(targetX, targetY) {
  // Disabled artificial mouse movement per user instruction
  return;
}

async function mouseMove(params) {
  const record = assertFresh(params.observationId);
  const p = normalizedPointToSource(params.x, params.y, record);
  await humanMouseMoveTo(p.x, p.y);
  setPointerFromRecordPoint(p, record, "agent");
  invalidateVisualState("agent-move");
  return { success: true, visualEpoch, pointer: pointerMetadata() };
}

/** Humanized press/hold/release at viewport CSS-pixel coordinates (shared by browser_click and queued clicks). */
async function dispatchClick(x, y, button = "left", clickCount = 1) {
  // 1. Move to target along Bézier curve
  await humanMouseMoveTo(x, y);

  // 2. Pre-click hover delay
  await sleep(preClickDelayMs());

  // 3. Press with hold duration
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await sleep(clickHoldMs());

  // 4. Release with slight jitter
  const jitter = clickJitter();
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x + jitter.dx, y: y + jitter.dy,
    button, clickCount,
  });
}

async function mouseClick(params, clickCount = 1) {
  const record = assertFresh(params.observationId);
  const p = normalizedPointToSource(params.x, params.y, record);
  await dispatchClick(p.x, p.y, params.button || "left", clickCount);

  setPointerFromRecordPoint(p, record, "agent");
  invalidateVisualState(clickCount === 2 ? "agent-double-click" : "agent-click");
  return { success: true, visualEpoch, pointer: pointerMetadata() };
}

async function drag(params) {
  const record = assertFresh(params.observationId);
  if (!Array.isArray(params.path) || params.path.length < 2) throw new Error("drag path requires at least two points");
  if (params.path.length > 50) throw new Error("drag path must have at most 50 points");
  const points = params.path.map((point) => normalizedPointToSource(point.x, point.y, record));

  // Move to start with Bézier
  const first = points[0];
  await humanMouseMoveTo(first.x, first.y);
  await sleep(randomBetween(30, 60));

  // Press
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: first.x, y: first.y, button: "left", clickCount: 1 });
  await sleep(randomBetween(30, 60));

  // Drag through waypoints with sub-steps
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const subSteps = Math.max(1, Math.ceil(dist / 20));
    for (let s = 1; s <= subSteps; s++) {
      const t = s / subSteps;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(randomBetween(8, 16));
    }
  }

  // Release
  const last = points[points.length - 1];
  await sleep(randomBetween(30, 60));
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, button: "left", clickCount: 1 });
  setPointerFromRecordPoint(last, record, "agent");
  invalidateVisualState("agent-drag");
  return { success: true, visualEpoch, pointer: pointerMetadata() };
}

async function scroll(params) {
  const record = assertFresh(params.observationId);
  const deltaX = Number(params.deltaX || 0);
  const deltaY = Number(params.deltaY || 0);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error("scroll deltas must be finite numbers");
  if (Math.abs(deltaX) > 4000 || Math.abs(deltaY) > 4000) throw new Error("scroll deltas must be within ±4000");
  const p = normalizedPointToSource(params.x ?? 500, params.y ?? 500, record);

  // Chunked scrolling
  const chunks = scrollChunks(deltaX, deltaY);
  for (let i = 0; i < chunks.length; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: chunks[i].dx, deltaY: chunks[i].dy });
    if (i < chunks.length - 1) await sleep(scrollStepDelayMs());
  }

  setPointerFromRecordPoint(p, record, "agent");
  invalidateVisualState("agent-scroll");
  return { success: true, visualEpoch };
}


async function humanTypeText(text) {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "\n" || char === "\r") {
      const events = keyEvents(["Enter"]);
      await send("Input.dispatchKeyEvent", events.down);
      await sleep(keyHoldMs());
      await send("Input.dispatchKeyEvent", events.up);
    } else if (char === "\t") {
      const events = keyEvents(["Tab"]);
      await send("Input.dispatchKeyEvent", events.down);
      await sleep(keyHoldMs());
      await send("Input.dispatchKeyEvent", events.up);
    } else {
      const def = keyDefinition(char);
      const isUpperCase = char >= "A" && char <= "Z";
      const modifiers = isUpperCase ? 8 : 0; // MODIFIERS.Shift = 8
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        modifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
        text: char,
        unmodifiedText: char,
      });
      await send("Input.insertText", { text: char });
      await sleep(keyHoldMs());
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      });
    }

    if (i < chars.length - 1) {
      let delay = charFlightMs();
      if (char === " ") {
        delay += wordPauseMs();
      }
      if (chars.length > 500) {
        delay = Math.min(delay, 20);
      }
      await sleep(delay);
    }
  }
}

async function typeText(params) {
  assertFresh(params.observationId);
  const text = String(params.text ?? "");
  if (text.length > 5000) throw new Error("type text must be at most 5000 characters");

  await humanTypeText(text);

  invalidateVisualState("agent-type");
  return { success: true, visualEpoch };
}

/** Send one keyboard shortcut (shared by browser_keypress and queued keypress items). */
async function dispatchKeys(keys) {
  const events = keyEvents(keys);
  await send("Input.dispatchKeyEvent", events.down);
  if (!events.down.modifiers && events.down.text) {
    await send("Input.dispatchKeyEvent", {
      type: "char",
      text: events.down.text,
      unmodifiedText: events.down.text,
    });
  }
  await sleep(shortcutHoldMs());
  await send("Input.dispatchKeyEvent", events.up);
}

async function keypress(params) {
  assertFresh(params.observationId);
  await dispatchKeys(params.keys);
  invalidateVisualState("agent-keypress");
  return { success: true, visualEpoch };
}

const RESOLVE_ELEMENT_SCRIPT = `(selector, ref, text) => {
  ${ELEMENT_INDEX_HELPERS}
  const vis = bcVisible;

  let el = null;
  if (selector) {
    el = document.querySelector(selector);
  } else if (typeof ref === 'number' && ref > 0) {
    el = bcInteractiveElements()[ref - 1] || null;
  } else if (text) {
    const target = String(text).trim().toLowerCase();
    const candidateNodes = document.querySelectorAll('a, button, input, select, textarea, label, [role="button"], [role="radio"], [role="checkbox"], [role="option"], [role="tab"], p, span, div, li, td, h1, h2, h3, h4, h5, h6');
    for (const node of candidateNodes) {
      if (!vis(node)) continue;
      const t = (node.textContent || node.value || node.getAttribute('aria-label') || '').trim().toLowerCase();
      if (t === target || t.includes(target)) {
        el = node;
        if (t === target) break;
      }
    }
  }

    if (!el) return null;
  if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox') && el.labels && el.labels[0]) {
    el = el.labels[0];
  }
  el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  let r = el.getBoundingClientRect();
  if ((r.width <= 0 || r.height <= 0) && (el.firstElementChild || el.querySelector('span, div, p'))) {
    const child = el.firstElementChild || el.querySelector('span, div, p');
    const cr = child.getBoundingClientRect();
    if (cr.width > 0 && cr.height > 0) r = cr;
  }
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    width: r.width,
    height: r.height,
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    text: (el.textContent || el.value || '').trim().slice(0, 100),
  };
}`;

async function resolveElement(params = {}) {
  await ensureAttached();
  const selector = params.selector ? String(params.selector) : null;
  const ref = typeof params.ref === "number" ? params.ref : null;
  const text = params.text ? String(params.text) : null;

  if (!selector && ref == null && !text) {
    throw new Error("Must provide selector, ref, or text to resolve an element");
  }

  const res = await send("Runtime.evaluate", {
    expression: `(${RESOLVE_ELEMENT_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(ref)}, ${JSON.stringify(text)})`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Element resolution script failed");
  }

  const rect = res?.result?.value;
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`Element not found or not visible: ${selector || (ref ? `ref #${ref}` : `"${text}"`)}`);
  }
  return rect;
}

async function clickElement(params = {}) {
  const rect = await resolveElement(params);

  // Compute realistic human landing point across the element (never dead-center)
  const clickPoint = humanClickPoint(rect);
  const targetX = clickPoint.x;
  const targetY = clickPoint.y;
  const button = params.button || "left";
  const clickCount = params.clickCount || 1;

  await humanMouseMoveTo(targetX, targetY);
  await sleep(preClickDelayMs());
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: targetX, y: targetY, button, clickCount });
  await sleep(clickHoldMs());

  const jitter = clickJitter();
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: targetX + jitter.dx,
    y: targetY + jitter.dy,
    button,
    clickCount,
  });

  const vp = await viewport();
  setPointerFromViewport(targetX, targetY, vp.width, vp.height, "agent");
  invalidateVisualState("agent-click-element");
  return { success: true, visualEpoch, clicked: rect };
}

const FOCUS_ELEMENT_SCRIPT = `(selector, ref, text) => {
  ${ELEMENT_INDEX_HELPERS}
  const vis = bcVisible;
  let el = null;
  if (selector) {
    el = document.querySelector(selector);
  } else if (typeof ref === 'number' && ref > 0) {
    el = bcInteractiveElements()[ref - 1] || null;
  } else if (text) {
    const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const target = norm(text);
    const NON_TEXT_INPUTS = new Set(['button','submit','reset','checkbox','radio','file','image','hidden','range','color']);
    const names = (node) => {
      const out = [node.placeholder, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('name'), node.id];
      for (const label of node.labels || []) out.push(label.innerText || label.textContent);
      for (const id of (node.getAttribute('aria-labelledby') || '').split(' ')) {
        const labelEl = id && document.getElementById(id);
        if (labelEl) out.push(labelEl.innerText || labelEl.textContent);
      }
      if (node.isContentEditable || node.getAttribute('role') === 'textbox') out.push(node.textContent);
      return out.map(norm).filter(Boolean);
    };
    let partial = null;
    const candidateNodes = document.querySelectorAll('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    for (const node of candidateNodes) {
      if (!vis(node) || node.disabled || node.readOnly) continue;
      if (node.tagName === 'INPUT' && NON_TEXT_INPUTS.has(String(node.type || '').toLowerCase())) continue;
      const n = names(node);
      if (n.includes(target) || norm(node.value) === target) {
        el = node;
        break;
      }
      if (!partial && n.some((v) => v.includes(target))) partial = node;
    }
    if (!el) el = partial;
  }

  if (!el) return null;
  el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  el.focus();
  if (typeof el.select === 'function') el.select();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    name: el.name || '',
  };
}`;

async function typeElement(params = {}) {
  const text = String(params.text ?? "");
  if (text.length > 5000) throw new Error("type text must be at most 5000 characters");

  await ensureAttached();
  const selector = params.selector ? String(params.selector) : null;
  const ref = typeof params.ref === "number" ? params.ref : null;
  const queryText = params.queryText ? String(params.queryText) : null;

  const res = await send("Runtime.evaluate", {
    expression: `(${FOCUS_ELEMENT_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(ref)}, ${JSON.stringify(queryText)})`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Focus element script failed");
  }

  if (!res?.result?.value) {
    throw new Error(`Element to focus not found: ${selector || (ref ? `ref #${ref}` : `"${queryText}"`)}`);
  }

  await sleep(randomBetween(50, 120));
  await humanTypeText(text);

  invalidateVisualState("agent-type-element");
  return { success: true, visualEpoch, focused: res.result.value };
}

function buildCheckScript(params) {
  const conditions = [];
  if (Array.isArray(params.text) && params.text.length > 0) {
    const escaped = JSON.stringify(params.text);
    conditions.push(`(() => {
      const body = document.body?.innerText || '';
      const texts = ${escaped};
      for (const t of texts) {
        if (body.includes(t)) return { met: true, reason: 'text: ' + t };
      }
      return null;
    })()`);
  }
  if (params.selector) {
    conditions.push(`(() => {
      const el = document.querySelector(${JSON.stringify(params.selector)});
      if (el) {
        const s = getComputedStyle(el);
        if (s.display !== 'none' && s.visibility !== 'hidden') {
          return { met: true, reason: 'selector: ' + ${JSON.stringify(params.selector)} };
        }
      }
      return null;
    })()`);
  }
  if (params.url) {
    conditions.push(`(() => {
      return location.href.includes(${JSON.stringify(params.url)})
        ? { met: true, reason: 'url: ' + location.href } : null;
    })()`);
  }
  if (params.idle) {
    conditions.push(`(() => {
      const busy = document.querySelector('[aria-busy="true"], .loading, .spinner, [data-loading="true"]');
      return !busy ? { met: true, reason: 'idle' } : null;
    })()`);
  }

  return `(() => {
    ${conditions.map((c, i) => `const c${i} = ${c}; if (c${i}) return c${i};`).join("\n    ")}
    return { met: false };
  })()`;
}

async function waitFor(params = {}) {
  await ensureAttached();
  const timeout = Math.min(30000, Math.max(500, Number(params.timeoutMs) || 10000));
  const startedAt = Date.now();

  const script = buildCheckScript(params);

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollInterval);
      resolve({
        success: false,
        reason: "timeout",
        elapsed: Date.now() - startedAt,
        visualEpoch,
      });
    }, timeout);

    const pollInterval = setInterval(async () => {
      if (resolved) return;
      try {
        const check = await send("Runtime.evaluate", {
          expression: script,
          returnByValue: true,
        });
        if (check?.result?.value?.met) {
          resolved = true;
          clearTimeout(timer);
          clearInterval(pollInterval);
          invalidateVisualState("wait-condition-met");
          resolve({
            success: true,
            reason: check.result.value.reason,
            elapsed: Date.now() - startedAt,
            visualEpoch,
          });
        }
      } catch {
        // Navigation or context reload occurring, keep polling
      }
    }, 200);
  });
}

async function selectAndAdvance(params = {}) {
  const dwellMs = Math.max(1000, Math.min(15000, Number(params.dwellMs) || 3500));

  // 1. Click target option
  const targetResult = await clickElement(params.target || {});

  // 2. Cognitive reading/thinking dwell time
  const actualDwell = dwellMs + randomBetween(-300, 300);
  await sleep(actualDwell);

  // 3. Click advance button if specified
  let advanceResult = null;
  if (params.advance) {
    advanceResult = await clickElement(params.advance);
  }

  // 4. Wait for transition
  if (Array.isArray(params.waitText) && params.waitText.length > 0) {
    await waitFor({ text: params.waitText, timeoutMs: 10000 });
  } else {
    await waitFor({ idle: true, timeoutMs: 5000 });
  }

  // Short settle time
  await sleep(100);

  // 5. Take fresh DOM snapshot
  const snap = await snapshot();
  return {
    success: true,
    visualEpoch,
    clickedTarget: targetResult.clicked,
    clickedAdvance: advanceResult?.clicked || null,
    actualDwellMs: Math.round(actualDwell),
    ...snap,
  };
}

async function executeActionQueue(params = {}) {
  const queue = Array.isArray(params.queue) ? params.queue : [];
  if (queue.length === 0) throw new Error("queue must be a non-empty array of actions");
  const supportedTypes = ["click", "double_click", "move", "type", "keypress", "scroll", "wait"];
  for (const [i, item] of queue.entries()) {
    if (!item || typeof item !== "object" || !supportedTypes.includes(item.type || "click")) {
      throw new Error(`Unsupported queue action type at index ${i}: ${item?.type}`);
    }
  }

  const usesPoint = (item) => !item.target
    && ["click", "double_click", "move"].includes(item.type || "click")
    && (item.x != null || item.y != null);
  // Coordinate items are all planned against one observation, so it must be current before any
  // input is sent. Later items keep using its mapping even though earlier items bump visualEpoch.
  const record = queue.some(usesPoint) ? assertFresh(params.observationId) : null;
  const pointFor = (item) => {
    if (record.tabId !== attachedTabId) {
      const error = new Error("STALE_OBSERVATION: tab changed during the queue");
      error.code = "STALE_OBSERVATION";
      throw error;
    }
    return normalizedPointToSource(item.x, item.y, record);
  };

  const results = [];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const type = item.type || "click";

    try {
      if (typeof paused !== "undefined" && paused) {
        const error = new Error("CONTROL_PAUSED_BY_USER");
        error.code = "CONTROL_PAUSED";
        throw error;
      }
      if (type === "click" || type === "double_click") {
        const button = item.button || "left";
        const clickCount = type === "double_click" ? 2 : 1;
        if (usesPoint(item)) {
          const p = pointFor(item);
          await dispatchClick(p.x, p.y, button, clickCount);
          setPointerFromRecordPoint(p, record, "agent");
          invalidateVisualState(clickCount === 2 ? "agent-double-click" : "agent-click");
          results.push({ action: type, x: item.x, y: item.y });
        } else {
          const clickRes = await clickElement({ ...(item.target || item), button, clickCount });
          results.push({ action: type, result: clickRes });
        }
      } else if (type === "move") {
        if (usesPoint(item)) {
          const p = pointFor(item);
          await humanMouseMoveTo(p.x, p.y);
          setPointerFromRecordPoint(p, record, "agent");
        } else {
          const rect = await resolveElement(item.target || {});
          await humanMouseMoveTo(rect.x, rect.y);
          const vp = await viewport();
          setPointerFromViewport(rect.x, rect.y, vp.width, vp.height, "agent");
        }
        invalidateVisualState("agent-move");
        results.push({ action: "move" });
      } else if (type === "type") {
        if (item.target) {
          const typeRes = await typeElement({
            ...item.target,
            queryText: item.target.text,
            text: item.text,
          });
          results.push({ action: "type", result: typeRes });
        } else {
          // No target: type into whatever currently has focus (e.g. after a coordinate click).
          const text = String(item.text ?? "");
          if (text.length > 5000) throw new Error("type text must be at most 5000 characters");
          await humanTypeText(text);
          invalidateVisualState("agent-type");
          results.push({ action: "type", target: "focused" });
        }
      } else if (type === "keypress") {
        if (!Array.isArray(item.keys) || item.keys.length === 0) throw new Error("keypress needs a non-empty keys array");
        await dispatchKeys(item.keys);
        invalidateVisualState("agent-keypress");
        results.push({ action: "keypress", keys: item.keys });
      } else if (type === "scroll") {
        const deltaX = item.deltaX ?? 0;
        const deltaY = item.deltaY ?? 0;
        if (![deltaX, deltaY].every(Number.isFinite) || Math.abs(deltaX) > 4000 || Math.abs(deltaY) > 4000) {
          throw new Error("scroll deltas must be finite numbers within ±4000");
        }
        const vp = await viewport();
        const p = normalizedPointToSource(item.x ?? 500, item.y ?? 500, {
          sourceRegion: { x: 0, y: 0, width: vp.width, height: vp.height },
        });
        const chunks = scrollChunks(deltaX, deltaY);
        for (const c of chunks) {
          await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: c.dx, deltaY: c.dy });
          await sleep(scrollStepDelayMs());
        }
        setPointerFromViewport(p.x, p.y, vp.width, vp.height, "agent");
        invalidateVisualState("agent-scroll");
        results.push({ action: "scroll" });
      } else if (type === "wait") {
        const ms = item.ms ?? 1000;
        await sleep(ms);
        results.push({ action: "wait", ms });
      }

      // Natural inter-action dwell time between items (reading next row/question)
      const dwell = item.dwellMs !== undefined ? Number(item.dwellMs) : (i < queue.length - 1 ? randomBetween(450, 950) : 0);
      if (dwell > 0) await sleep(Math.max(0, dwell + randomBetween(-100, 100)));
    } catch (error) {
      return {
        success: false,
        visualEpoch,
        completedActions: results.length,
        failedActionIndex: i,
        errorCode: error?.code || "QUEUE_ACTION_FAILED",
        message: error?.message || String(error),
        results,
      };
    }
  }

  let waitResult = null;
  if (Array.isArray(params.waitText) && params.waitText.length > 0) {
    waitResult = await waitFor({ text: params.waitText, timeoutMs: params.timeoutMs ?? 10000 });
  } else if (params.waitForIdle !== false) {
    waitResult = await waitFor({ idle: true, timeoutMs: params.timeoutMs ?? 5000 });
  }

  await sleep(100);
  const snap = await snapshot();
  return {
    success: waitResult?.success !== false,
    visualEpoch,
    completedActions: results.length,
    results,
    waitResult,
    ...snap,
  };
}

async function evaluateScript(params = {}) {
  const expression = String(params.expression || "").trim();
  if (!expression) throw new Error("expression is required");
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Script execution failed";
    throw new Error(desc);
  }
  invalidateVisualState("agent-evaluate");
  return { success: true, visualEpoch, value: res.result?.value };
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

async function waitForEligibleTarget(tabId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && isEligibleTargetTab(tab)) return tab;
    if (tab && isControlSurfaceTab(tab)) {
      const error = new Error("browserControl cannot bootstrap navigation into an AI control surface");
      error.code = "TAB_NOT_CONTROLLABLE";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const error = new Error("The tab did not become a controllable web page after navigation");
  error.code = "NAVIGATION_FAILED";
  throw error;
}

async function navigate(params) {
  if (!params.url) throw new Error("url is required");
  const safeUrl = assertSafeNavigationUrl(params.url);
  const active = await activeTab();

  if (attachedTabId == null && isBootstrapTab(active)) {
    await chrome.tabs.update(active.id, { url: safeUrl, active: true });
    const target = await waitForEligibleTarget(active.id);
    await attach(target.id);
    return { success: true, visualEpoch, url: safeUrl, bootstrap: true, targetId: String(target.id) };
  }

  const tabId = await ensureAttached();
  await chrome.debugger.sendCommand({ tabId }, "Page.navigate", { url: safeUrl });
  invalidateVisualState("agent-navigate");
  return { success: true, visualEpoch, url: safeUrl, bootstrap: false, targetId: String(tabId) };
}

async function historyAction(_params, direction) {
  const tabId = await ensureAttached();
  if (direction === "back") await chrome.tabs.goBack(tabId);
  else await chrome.tabs.goForward(tabId);
  invalidateVisualState(direction === "back" ? "agent-back" : "agent-forward");
  return { success: true, visualEpoch };
}

async function reload(_params = {}) {
  const tabId = await ensureAttached();
  await chrome.tabs.reload(tabId);
  invalidateVisualState("agent-reload");
  return { success: true, visualEpoch };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({ targetId: String(tab.id), windowId: tab.windowId, active: tab.active, title: tab.title || "", url: tab.url || "", bootstrap: isBootstrapTab(tab) }));
}

async function switchTab(params) {
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
  const safeUrl = assertSafeNewTabUrl(params.url);
  const tab = await chrome.tabs.create({ url: safeUrl, active: true });
  if (!tab.id) throw new Error("Failed to create tab");
  if (safeUrl !== "about:blank") {
    const target = await waitForEligibleTarget(tab.id);
    await attach(target.id);
  }
  return { success: true, targetId: String(tab.id), visualEpoch };
}

async function closeTab(params = {}) {
  assertFresh(params.observationId);
  const tabId = params.targetId ? Number(params.targetId) : attachedTabId;
  if (!Number.isInteger(tabId)) throw new Error("No target tab to close");
  await chrome.tabs.remove(tabId);
  if (tabId === attachedTabId) {
    attachedTabId = null;
    attachedMainFrameId = null;
    clearPointer();
    invalidateVisualState("agent-close-tab");
  }
  return { success: true, visualEpoch };
}

async function handleDialog(params = {}) {
  if (params.observationId) {
    try { assertFresh(params.observationId, true); } catch {}
  }
  await send("Page.handleJavaScriptDialog", { accept: params.accept !== false, ...(params.promptText != null ? { promptText: String(params.promptText) } : {}) });
  invalidateVisualState("agent-handle-dialog");
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
    case "status": {
      const active = await activeTab().catch(() => null);
      return {
        attachedTabId,
        visualEpoch,
        lastInvalidationReason,
        lastInvalidatedAt,
        pointer: pointerMetadata(),
        paused,
        connected: anyTransportConnected(),
        localConnected,
        remoteConnected: remoteConnected(),
        manualDisconnect,
        activeTab: active ? {
          targetId: String(active.id),
          title: active.title || "",
          url: active.url || "",
          bootstrap: isBootstrapTab(active),
          controllable: isEligibleTargetTab(active),
        } : null,
        transportLease: {
          owner: transportLeaseOwner,
          expiresAt: transportLeaseExpiresAt,
        },
      };
    }
    case "observe": return observe(request.params || {});
    case "snapshot": return snapshot(request.params || {});
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
    case "evaluate": return evaluateScript(request.params || {});
    case "click_element": return clickElement(request.params || {});
    case "type_element": return typeElement(request.params || {});
    case "wait_for": return waitFor(request.params || {});
    case "select_and_advance": return selectAndAdvance(request.params || {});
    case "action_queue": {
      const keepLease = setInterval(() => {
        if (transportLeaseOwner === source) transportLeaseExpiresAt = Date.now() + TRANSPORT_LEASE_MS;
      }, 10_000);
      try {
        return await executeActionQueue(request.params || {});
      } finally {
        clearInterval(keepLease);
      }
    }
    case "reload_extension": setTimeout(() => chrome.runtime.reload(), 50); return { success: true };
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
    const event = parseVisualInvalidationPayload(params?.payload);
    if (consumeAgentInputEcho(event)) return;
    if (Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.viewportWidth) && Number.isFinite(event.viewportHeight)) {
      setPointerFromViewport(event.x, event.y, event.viewportWidth, event.viewportHeight, "user", event.at);
    }
    if (event.kind === "pointer" || event.reason === "user-pointermove") return;
    invalidateVisualState(event.reason);
    return;
  }
  if (method === "Page.frameNavigated") {
    const frame = params?.frame;
    if (frame?.id && !frame?.parentId) {
      attachedMainFrameId = frame.id;
      invalidateVisualState("main-frame-navigated");
    }
    return;
  }
  if (method === "Page.navigatedWithinDocument") {
    if (!attachedMainFrameId || params?.frameId === attachedMainFrameId) {
      invalidateVisualState("main-frame-same-document-navigation");
    }
    return;
  }
  if (method === "Page.javascriptDialogOpening") {
    invalidateVisualState("javascript-dialog-opened");
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    attachedMainFrameId = null;
    clearPointer();
    invalidateVisualState("debugger-detached");
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

chrome.windows.onBoundsChanged.addListener((window) => {
  if (attachedTabId == null || !Number.isInteger(window?.id)) return;
  void chrome.tabs.get(attachedTabId).then((tab) => {
    if (tab?.windowId === window.id) {
      clearPointer();
      invalidateVisualState("window-resized");
    }
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
        lastInvalidationReason,
        lastInvalidatedAt,
        pointer: pointerMetadata(),
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
    if (message.type === "disconnectLocal") {
      if (!localConnection) throw new Error("No local agent is connected");
      await localConnection.disconnect();
      if (transportLeaseOwner === "local") {
        transportLeaseOwner = null;
        transportLeaseExpiresAt = 0;
      }
      await chrome.alarms.clear(CONTROL_SESSION_ALARM);
      await detach(false);
      await setStatus(anyTransportConnected() ? "connected" : "disconnected");
      return { ok: true };
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
      invalidateVisualState("pause-toggled");
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
