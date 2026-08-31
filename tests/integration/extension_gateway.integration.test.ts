import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import WebSocket from "ws";
import fs from "node:fs/promises";
import path from "node:path";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { runGatewayRuntime } from "../../src/remote/runtime.js";

async function openWebSocket(wsUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function sendCdp(wsUrl: string, method: string, params: any = {}): Promise<any> {
  const ws = await openWebSocket(wsUrl);
  let nextId = 1;
  const call = (callMethod: string, callParams: any = {}) => {
    const id = nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${callMethod}`)), 5000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString());
        if (message.id !== id) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ id, method: callMethod, params: callParams }));
    });
  };
  try {
    if (method === "Runtime.evaluate") await call("Runtime.enable");
    return await call(method, params);
  } finally {
    ws.close();
  }
}

async function runtimeMessage(wsUrl: string, message: any): Promise<any> {
  const result = await sendCdp(wsUrl, "Runtime.evaluate", {
    expression: `chrome.runtime.sendMessage(${JSON.stringify(message)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`Extension runtime message threw: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

async function evaluateWebSocketProbe(wsUrl: string, targetUrl: string): Promise<{ value: any; events: any[] }> {
  const ws = await openWebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const events: any[] = [];

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("Network.webSocket")) {
      events.push({ method: message.method, params: message.params });
    }
  });

  const call = (method: string, params: any = {}) => {
    const id = nextId++;
    const promise = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method, params }));
    return promise;
  };

  try {
    await call("Network.enable");
    const result = await call("Runtime.evaluate", {
      expression: `new Promise((resolve) => {
        const probeSocket = new WebSocket(${JSON.stringify(targetUrl)});
        const timer = setTimeout(() => resolve({ok:false, timeout:true, readyState:probeSocket.readyState}), 3000);
        probeSocket.onopen = () => { clearTimeout(timer); probeSocket.close(1000, "probe"); resolve({ok:true}); };
        probeSocket.onerror = () => { clearTimeout(timer); resolve({ok:false, error:true, readyState:probeSocket.readyState}); };
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { value: result.result?.value, events };
  } finally {
    ws.close();
  }
}

async function listTargets(port: number): Promise<any[]> {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()) as Promise<any[]>;
}

async function waitForTarget(port: number, predicate: (target: any) => boolean, label: string): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const target = (await listTargets(port)).find(predicate);
    if (target?.webSocketDebuggerUrl) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const canaryConfigured = Boolean(
  process.env.CHROME_PATH &&
  process.env.BROWSERCONTROL_TEST_TLS_KEY &&
  process.env.BROWSERCONTROL_TEST_TLS_CERT &&
  process.env.BROWSERCONTROL_TEST_TLS_SPKI
);

describe.skipIf(!canaryConfigured)("Real Chrome extension -> WSS gateway -> MCP canary", () => {
  let chrome: LaunchedChrome;
  let fixture: TestServer;
  let controller: ChromeController;
  let gateway: Awaited<ReturnType<typeof runGatewayRuntime>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let popupTargetId: string | undefined;

  beforeAll(async () => {
    const keyPath = process.env.BROWSERCONTROL_TEST_TLS_KEY;
    const certPath = process.env.BROWSERCONTROL_TEST_TLS_CERT;
    const certSpki = process.env.BROWSERCONTROL_TEST_TLS_SPKI;
    if (!keyPath || !certPath || !certSpki) throw new Error("TLS canary certificate paths and SPKI are required");
    const [tlsKey, tlsCert] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.readFile(certPath, "utf8"),
    ]);

    gateway = await runGatewayRuntime({
      host: "localhost",
      port: 8787,
      extensionToken: "extension-canary-device-token",
      mcpBearerToken: "extension-canary-token",
      heartbeatIntervalMs: 2_000,
      heartbeatTimeoutMs: 8_000,
      tlsKey,
      tlsCert,
    });

    fixture = await startTestServer(0);
    const extensionDir = path.resolve(process.cwd(), "extension");
    chrome = await launchRealChrome({
      windowSize: "1280,800",
      headless: false,
      disableBackgroundNetworking: false,
      extraArgs: [
        `--ignore-certificate-errors-spki-list=${certSpki}`,
        "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets",
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });

    controller = new ChromeController({ mode: "ws-endpoint", wsEndpoint: chrome.wsUrl });
    await controller.connect();
    await controller.executeBrowserAction({ type: "navigate", url: `${fixture.url}/interactive.html` });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const worker = await waitForTarget(
      chrome.port,
      (target) =>
        target.type === "service_worker" &&
        typeof target.url === "string" &&
        target.url.startsWith("chrome-extension://") &&
        target.url.endsWith("/service-worker.js"),
      "browserControl extension service worker"
    );
    const extensionId = new URL(worker.url).host;
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;

    const opened = await sendCdp(worker.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: "chrome.action.openPopup()",
      awaitPromise: true,
      returnByValue: true,
    });
    if (opened.exceptionDetails) {
      throw new Error(`chrome.action.openPopup failed: ${JSON.stringify(opened.exceptionDetails)}`);
    }

    const popup = await waitForTarget(chrome.port, (target) => target.url === popupUrl, "real browserControl action popup");
    popupTargetId = popup.id;

    const probe = await evaluateWebSocketProbe(
      popup.webSocketDebuggerUrl,
      "wss://localhost:8787/extension?token=extension-canary-device-token"
    );
    if (!probe.value?.ok) {
      throw new Error(`Extension-page secure WebSocket probe failed: ${JSON.stringify(probe)}`);
    }

    const saved = await runtimeMessage(popup.webSocketDebuggerUrl, {
      type: "saveConfig",
      config: { gatewayUrl: "wss://localhost:8787/extension", deviceToken: "extension-canary-device-token", autoReconnect: true },
    });
    if (!saved?.ok) {
      throw new Error(`Extension saveConfig failed: ${JSON.stringify(saved)}`);
    }

    const connectDeadline = Date.now() + 8000;
    let extensionConnected = false;
    while (Date.now() < connectDeadline) {
      const health = await fetch("https://localhost:8787/health").then((r) => r.json()) as any;
      if (health.extensionConnected) {
        extensionConnected = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!extensionConnected) {
      const state = await runtimeMessage(popup.webSocketDebuggerUrl, { type: "getStatus" });
      throw new Error(`Extension worker received config but never connected: ${JSON.stringify({ saved, state })}`);
    }

    const shared = await runtimeMessage(popup.webSocketDebuggerUrl, { type: "shareActiveTab" });
    if (!shared?.ok) throw new Error(`Extension shareActiveTab failed: ${JSON.stringify(shared)}`);

    client = new Client(
      { name: "extension-canary", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    transport = new StreamableHTTPClientTransport(new URL("https://localhost:8787/mcp"), {
      requestInit: {
        headers: {
          Authorization: "Bearer extension-canary-token",
          "X-BrowserControl-Client-Id": "extension-canary",
        },
      },
    });
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
  }, 35_000);

  afterAll(async () => {
    try { await client?.callTool({ name: "browser_release_control", arguments: {} }); } catch {}
    try { await client?.close(); } catch {}
    if (popupTargetId) {
      try { await sendCdp(chrome.wsUrl, "Target.closeTarget", { targetId: popupTargetId }); } catch {}
    }
    try { await controller?.disconnect(); } catch {}
    try { await chrome?.close(); } catch {}
    try { await fixture?.close(); } catch {}
    try { gateway?.wss.close(); } catch {}
    if (gateway?.httpServer) await new Promise<void>((resolve) => gateway.httpServer.close(() => resolve()));
  });

  it("captures the shared tab through chrome.debugger and executes an observation-bound click", async () => {
    const status = await client.callTool({ name: "browser_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    const statusPayload = JSON.parse((status.content[0] as any).text);
    expect(statusPayload.extension.connected).toBe(true);
    expect(statusPayload.extension.attachedTabId).not.toBeNull();
    expect(statusPayload.extension.attachedTabId).toBeDefined();

    const observation = await client.callTool({ name: "browser_observe", arguments: { format: "png" } });
    expect(observation.isError).toBeFalsy();
    expect((observation.content[1] as any).type).toBe("image");
    const metadata = JSON.parse((observation.content[0] as any).text);
    expect(metadata.coordinateSpace).toBe("normalized_1000");

    const before = await controller.session.send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__STATE__ || {clicks:0})",
      returnByValue: true,
    });
    const beforeClicks = JSON.parse(before.result.value).clicks || 0;

    const clicked = await client.callTool({
      name: "browser_click",
      arguments: { observationId: metadata.observationId, x: 68, y: 151, button: "left" },
    });
    expect(clicked.isError).toBeFalsy();

    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await controller.session.send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__STATE__ || {clicks:0})",
      returnByValue: true,
    });
    const afterClicks = JSON.parse(after.result.value).clicks || 0;
    expect(afterClicks).toBeGreaterThan(beforeClicks);
  });
});
