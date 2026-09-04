export const LOCAL_BRIDGE_HTTP_ORIGIN = "http://127.0.0.1:8765";
export const LOCAL_BRIDGE_WS_ORIGIN = "ws://127.0.0.1:8765";
export const LOCAL_PROBE_ALARM = "browsercontrol-local-probe";

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 10_000;

export function createLocalConnection({ handleRpc, onStateChange }) {
  let socket = null;
  let connectInFlight = false;
  let retryTimer = null;
  let retryAttempt = 0;
  let stopped = false;

  const extensionId = chrome.runtime.id;

  const notify = (connected, error = "") => {
    try { onStateChange?.({ connected, error }); } catch {}
  };

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer || socket?.readyState === WebSocket.OPEN) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * (2 ** Math.min(retryAttempt++, 4)));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  async function handshake() {
    const response = await fetch(`${LOCAL_BRIDGE_HTTP_ORIGIN}/handshake`, {
      method: "POST",
      headers: {
        "X-BrowserControl-Extension-Id": extensionId,
      },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Local bridge handshake returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload?.challenge) throw new Error("Local bridge handshake did not return a challenge");
    return payload.challenge;
  }

  async function connect() {
    clearRetry();
    if (stopped || connectInFlight) return;
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;

    connectInFlight = true;
    try {
      const challenge = await handshake();
      if (stopped) return;

      const url = new URL(`${LOCAL_BRIDGE_WS_ORIGIN}/extension`);
      url.searchParams.set("extensionId", extensionId);
      url.searchParams.set("challenge", challenge);
      const currentSocket = new WebSocket(url.toString());
      socket = currentSocket;

      currentSocket.onopen = () => {
        if (socket !== currentSocket) return;
        retryAttempt = 0;
        notify(true);
        currentSocket.send(JSON.stringify({ type: "hello", version: 1, transport: "local", userAgent: navigator.userAgent }));
      };

      currentSocket.onmessage = async (event) => {
        if (socket !== currentSocket) return;
        let request;
        try { request = JSON.parse(event.data); } catch { return; }

        if (request?.type === "keepalive") {
          if (currentSocket.readyState === WebSocket.OPEN) {
            currentSocket.send(JSON.stringify({ type: "keepalive_ack", ts: Date.now() }));
          }
          return;
        }

        if (!request?.id || !request?.method) return;
        try {
          const result = await handleRpc(request, "local");
          if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
            currentSocket.send(JSON.stringify({ id: request.id, ok: true, result }));
          }
        } catch (error) {
          if (socket === currentSocket && currentSocket.readyState === WebSocket.OPEN) {
            currentSocket.send(JSON.stringify({
              id: request.id,
              ok: false,
              error: {
                code: error?.code || "RPC_ERROR",
                message: error?.message || String(error),
              },
            }));
          }
        }
      };

      currentSocket.onclose = () => {
        if (socket !== currentSocket) return;
        socket = null;
        notify(false);
        scheduleRetry();
      };

      currentSocket.onerror = () => {
        if (socket === currentSocket) notify(false);
      };
    } catch (error) {
      socket = null;
      notify(false, error?.message || String(error));
      scheduleRetry();
    } finally {
      connectInFlight = false;
    }
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LOCAL_PROBE_ALARM) void connect();
  });
  chrome.alarms.create(LOCAL_PROBE_ALARM, { periodInMinutes: 0.5 });

  void connect();

  return {
    get connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
    connect,
    stop() {
      stopped = true;
      clearRetry();
      void chrome.alarms.clear(LOCAL_PROBE_ALARM);
      const currentSocket = socket;
      socket = null;
      if (currentSocket && currentSocket.readyState !== WebSocket.CLOSED) {
        try { currentSocket.close(1000, "browserControl local connection stopped"); } catch {}
      }
      notify(false);
    },
  };
}
