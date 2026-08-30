import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import path from "node:path";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { runGatewayRuntime } from "../../src/remote/runtime.js";

async function sendCdp(wsUrl: string, method: string, params: any = {}): Promise<any> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const id = Math.floor(Math.random() * 1_000_000) + 1;
  const response = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  });
  ws.send(JSON.stringify({ id, method, params }));
  try {
    return await response;
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

describe("Real Chrome extension -> gateway -> MCP canary", () => {
  let chrome: LaunchedChrome;
  let fixture: TestServer;
  let controller: ChromeController;
  let gateway: Awaited<ReturnType<typeof runGatewayRuntime>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    gateway = await runGatewayRuntime({
      host: "127.0.0.1",
      port: 8787,
      extensionToken: "",
      mcpBearerToken: "extension-canary-token",
      heartbeatIntervalMs: 2_000,
      heartbeatTimeoutMs: 8_000,
    });

    fixture = await startTestServer(0);
    const extensionDir = path.resolve(process.cwd(), "extension");
    chrome = await launchRealChrome({
      windowSize: "1280,800",
      headless: false,
      disableBackgroundNetworking: false,
      extraArgs: [
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
        (target.type === "service_worker" || target.type === "background_page") &&
        typeof target.url === "string" &&
        target.url.startsWith("chrome-extension://"),
      "browserControl extension service worker"
    );
    const extensionId = new URL(worker.url).host;
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;

    const popupCreated = await sendCdp(chrome.wsUrl, "Target.createTarget", {
      url: popupUrl,
      background: true,
    });
    const popup = await waitForTarget(
      chrome.port,
      (target) => target.url === popupUrl,
      "browserControl popup target"
    );
    await sendCdp(popup.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: `chrome.runtime.sendMessage({type:"shareActiveTab"})`,
      awaitPromise: true,
      returnByValue: true,
    });
    await sendCdp(chrome.wsUrl, "Target.closeTarget", { targetId: popupCreated.targetId });

    const deadline = Date.now() + 8000;
    let extensionConnected = false;
    while (Date.now() < deadline) {
      const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json()) as any;
      if (health.extensionConnected) {
        extensionConnected = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(extensionConnected).toBe(true);

    client = new Client({ name: "extension-canary", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      requestInit: { headers: { Authorization: "Bearer extension-canary-token" } },
    });
    await client.connect(transport);
  }, 35_000);

  afterAll(async () => {
    try { await client?.callTool({ name: "browser_release_control", arguments: {} }); } catch {}
    try { await client?.close(); } catch {}
    try { await controller?.disconnect(); } catch {}
    try { await chrome?.close(); } catch {}
    try { await fixture?.close(); } catch {}
    try { gateway?.wss.close(); } catch {}
    if (gateway?.httpServer) {
      await new Promise<void>((resolve) => gateway.httpServer.close(() => resolve()));
    }
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
      arguments: {
        observationId: metadata.observationId,
        x: 68,
        y: 151,
        button: "left",
      },
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
