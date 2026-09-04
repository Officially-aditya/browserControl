import { PRODUCTION_MCP_URL } from "./gateway-connection.js";
import {
  decideRemoteApproval,
  listRemoteGrants,
  lookupRemoteApproval,
  revokeRemoteGrant,
} from "./remote-approval.js";

const $ = (id) => document.getElementById(id);
let pendingApproval = null;
let remoteReady = false;

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

async function readState() {
  return call({ type: "getStatus" });
}

function setModePill(id, connected, onLabel, offLabel) {
  const element = $(id);
  element.textContent = connected ? onLabel : offLabel;
  element.classList.toggle("on", connected);
}

function clearApprovalReview() {
  pendingApproval = null;
  $("approvalReview").hidden = true;
  $("approvalClient").textContent = "";
  $("approvalMeta").textContent = "";
}

function renderGrants(grants) {
  const list = $("grantsList");
  list.textContent = "";
  if (!grants.length) {
    list.textContent = "No active remote app grants on this browser device.";
    return;
  }

  for (const grant of grants) {
    const row = document.createElement("div");
    row.className = "grant";

    const head = document.createElement("div");
    head.className = "grant-head";
    const name = document.createElement("div");
    name.className = "grant-name";
    name.textContent = grant.clientName || "MCP client";
    const revoke = document.createElement("button");
    revoke.className = "mini danger";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      if (!window.confirm(`Revoke ${name.textContent}'s access to this Chrome device?`)) return;
      revoke.disabled = true;
      setError();
      try {
        await revokeRemoteGrant(grant.grantId);
        setError(`${name.textContent} was revoked. Existing OAuth access and refresh tokens for this grant are no longer accepted.`);
        await refreshGrants();
      } catch (error) {
        setError(error?.message || String(error));
      } finally {
        revoke.disabled = false;
      }
    });
    head.append(name, revoke);

    const meta = document.createElement("div");
    meta.className = "muted";
    const lastUsed = grant.lastUsedAt ? new Date(grant.lastUsedAt).toLocaleString() : "unknown";
    meta.textContent = `${grant.scope || "browser:control"} • last authorized ${lastUsed}`;
    row.append(head, meta);
    list.append(row);
  }
}

async function refreshGrants() {
  if (!remoteReady) {
    $("grantsList").textContent = "Enable remote access to manage app grants.";
    return;
  }
  $("grantsList").textContent = "Loading…";
  try {
    renderGrants(await listRemoteGrants());
  } catch (error) {
    $("grantsList").textContent = "Could not load authorized apps.";
    setError(error?.message || String(error));
  }
}

async function refresh() {
  const state = await readState();
  const localConnected = !!state.localConnected;
  const remoteConnected = !!state.remoteConnected;
  const paused = !!state.paused;
  const attached = !!state.attachedTabId;
  const enrolled = !!(state.deviceId && state.deviceToken && state.mcpToken);
  const anyConnected = localConnected || remoteConnected;
  remoteReady = remoteConnected;

  setModePill("localState", localConnected, "Connected", "Waiting");
  setModePill("remoteState", remoteConnected, "Connected", enrolled ? "Offline" : "Off");

  const parts = [];
  if (localConnected) parts.push("local ready");
  if (remoteConnected) parts.push("remote ready");
  if (!parts.length) parts.push("waiting for an agent connection");
  if (attached) parts.push(`active tab ${state.attachedTabId}`);
  if (paused) parts.push("paused");
  $("status").textContent = parts.join(" • ");
  $("status").classList.toggle("connected", anyConnected && !paused);

  $("remoteConnectSection").hidden = remoteConnected;
  $("remoteConnectedSection").hidden = !remoteConnected;
  $("connect").textContent = enrolled ? "Reconnect remote access" : "Enable remote access";
  $("connect").dataset.defaultLabel = $("connect").textContent;
  $("probeLocal").dataset.defaultLabel = "Check local connection";
  $("reviewApproval").dataset.defaultLabel = "Review";
  $("pause").textContent = paused ? "Resume" : "Pause";
  $("pause").disabled = !anyConnected && !paused;
  $("autoAttach").checked = state.autoAttach !== false;
  $("followActiveTab").checked = state.followActiveTab !== false;

  if (!remoteConnected) clearApprovalReview();
  if (state.lastError && !localConnected) setError(state.lastError);
  return state;
}

async function waitForRemoteConnected(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState();
    if (state.remoteConnected) return state;
    if (state.status === "error" && !state.localConnected) throw new Error(state.lastError || "browserControl could not connect remotely");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("browserControl enrollment succeeded, but the secure relay connection did not come online");
}

$("connect").dataset.defaultLabel = $("connect").textContent;
$("probeLocal").dataset.defaultLabel = $("probeLocal").textContent;
$("reviewApproval").dataset.defaultLabel = $("reviewApproval").textContent;

$("connect").addEventListener("click", async () => {
  const button = $("connect");
  setError();
  setBusy(button, true, "Connecting…");
  try {
    const result = await call({ type: "connectProduction" });
    if (!result?.ok) throw new Error(result?.error || "Could not enable remote access");
    await waitForRemoteConnected();
    setError("Remote access enabled. Local agents will still connect directly when available.");
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    setBusy(button, false, "Connecting…");
    await refresh();
    if (remoteReady) await refreshGrants();
  }
});

$("probeLocal").addEventListener("click", async () => {
  const button = $("probeLocal");
  setError();
  setBusy(button, true, "Checking…");
  try {
    const result = await call({ type: "probeLocal" });
    if (!result?.ok) throw new Error(result?.error || "Could not probe the local browserControl process");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = await readState();
    setError(state.localConnected
      ? "Local browserControl process connected."
      : "No local browserControl process found yet. Start your local MCP client and try again.");
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    setBusy(button, false, "Checking…");
    await refresh();
  }
});

$("copyConnector").addEventListener("click", async () => {
  setError();
  try {
    await navigator.clipboard.writeText(PRODUCTION_MCP_URL);
    setError("Remote MCP URL copied.");
  } catch {
    setError(PRODUCTION_MCP_URL);
  }
});

$("reviewApproval").addEventListener("click", async () => {
  const button = $("reviewApproval");
  setError();
  clearApprovalReview();
  setBusy(button, true, "Checking…");
  try {
    const result = await lookupRemoteApproval($("approvalCode").value);
    pendingApproval = { code: result.code, ...result.request };
    $("approvalClient").textContent = result.request.clientName || "MCP client";
    $("approvalMeta").textContent = `Callback ${result.request.callback} • Scope ${result.request.scope} • expires ${new Date(result.request.expiresAt).toLocaleTimeString()}`;
    $("approvalReview").hidden = false;
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    setBusy(button, false, "Checking…");
  }
});

async function submitApprovalDecision(decision) {
  if (!pendingApproval) return;
  const allow = $("allowApproval");
  const deny = $("denyApproval");
  allow.disabled = true;
  deny.disabled = true;
  setError();
  try {
    await decideRemoteApproval({
      code: pendingApproval.code,
      requestId: pendingApproval.requestId,
      decision,
    });
    const name = pendingApproval.clientName || "The app";
    clearApprovalReview();
    $("approvalCode").value = "";
    setError(decision === "approve"
      ? `${name} was approved for this browser device. The phone must finish the PKCE OAuth exchange before access becomes active.`
      : `${name} was denied.`);
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    allow.disabled = false;
    deny.disabled = false;
  }
}

$("allowApproval").addEventListener("click", () => void submitApprovalDecision("approve"));
$("denyApproval").addEventListener("click", () => void submitApprovalDecision("deny"));
$("refreshGrants").addEventListener("click", () => void refreshGrants());

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
  if (!result?.ok) setError(result?.error || "Could not disable remote access");
  else setError("Remote access disabled. Local agents can continue using browserControl directly.");
  clearApprovalReview();
  await refresh();
});

void refresh()
  .then(() => call({ type: "probeLocal" }))
  .then(() => refresh())
  .then(() => remoteReady ? refreshGrants() : undefined)
  .catch(() => undefined);
