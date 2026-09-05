import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { launchRealChrome, type LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, type TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";

const canaryConfigured = Boolean(process.env.CHROME_PATH);

async function waitForLocalExtension(client: Client): Promise<any> {
  const deadline = Date.now() + 10_000;
  let lastStatus: any = null;
  while (Date.now() < deadline) {
    const status = await client.callTool({ name: "browser_status", arguments: {} });
    if (!status.isError) {
      lastStatus = JSON.parse((status.content[0] as any).text);
      if (lastStatus.extension?.connected) return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the browserControl extension to connect to local stdio MCP: ${JSON.stringify(lastStatus)}`);
}

describe.skipIf(!canaryConfigured)("Real Chrome extension -> local stdio MCP canary", () => {
  let chrome: LaunchedChrome;
  let fixture: TestServer;
  let controller: ChromeController;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    client = new Client({ name: "local-extension-canary", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(process.cwd(), "dist/local/runtime.js")],
    });
    await client.connect(transport);

    fixture = await startTestServer(0);
    const extensionDir = path.resolve(process.cwd(), "extension");
    chrome = await launchRealChrome({
      windowSize: "1280,800",
      headless: false,
      disableBackgroundNetworking: false,
      extraArgs: [
        "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets",
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });

    controller = new ChromeController({ mode: "ws-endpoint", wsEndpoint: chrome.wsUrl });
    await controller.connect();
    await controller.executeBrowserAction({ type: "navigate", url: `${fixture.url}/interactive.html` });
    await waitForLocalExtension(client);
  }, 30_000);

  afterAll(async () => {
    try { await client?.callTool({ name: "browser_release_control", arguments: {} }); } catch {}
    try { await client?.close(); } catch {}
    try { await controller?.disconnect(); } catch {}
    try { await chrome?.close(); } catch {}
    try { await fixture?.close(); } catch {}
  });

  it("exposes the canonical browserControl tool surface over stdio", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("browser_observe");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_tabs");
    expect(names).not.toContain("computer_action");
    expect(names).not.toContain("browser_action");
  });

  it("observes and clicks the existing Chrome tab without using the relay", async () => {
    const status = await client.callTool({ name: "browser_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    const statusPayload = JSON.parse((status.content[0] as any).text);
    expect(statusPayload.extension.connected).toBe(true);
    expect(statusPayload.extension.localConnected).toBe(true);
    expect(statusPayload.extension.remoteConnected).toBe(false);

    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "png", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    expect((observation.content[1] as any).type).toBe("image");
    const metadata = JSON.parse((observation.content[0] as any).text);
    expect(metadata.coordinateSpace).toBe("normalized_1000");
    expect(Math.max(metadata.imageWidth, metadata.imageHeight)).toBeLessThanOrEqual(640);

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

  it("keeps observations usable across passive DOM churn", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    await controller.session.send("Runtime.evaluate", {
      expression: `(() => {
        const marker = document.createElement("div");
        marker.id = "passive-local-change-marker";
        marker.textContent = "passive app render";
        document.body.appendChild(marker);
      })()`,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

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
  });

  it("still rejects an observation after a user-originated interaction", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    await controller.session.send("Runtime.evaluate", {
      expression: `document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 300 }))`,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const stale = await client.callTool({
      name: "browser_click",
      arguments: {
        observationId: metadata.observationId,
        x: 68,
        y: 151,
        button: "left",
      },
    });
    expect(stale.isError).toBe(true);
    expect((stale.content[0] as any).text).toContain("STALE_OBSERVATION");
  });

  it("bootstraps an http(s) navigation directly from a fresh blank tab", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    const blank = await client.callTool({
      name: "browser_new_tab",
      arguments: { observationId: metadata.observationId },
    });
    expect(blank.isError).toBeFalsy();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const status = await client.callTool({ name: "browser_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    const statusPayload = JSON.parse((status.content[0] as any).text);
    expect(statusPayload.extension.activeTab?.bootstrap).toBe(true);

    const navigated = await client.callTool({
      name: "browser_navigate",
      arguments: { url: `${fixture.url}/interactive.html` },
    });
    expect(navigated.isError).toBeFalsy();

    const after = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(after.isError).toBeFalsy();
    const afterMetadata = JSON.parse((after.content[0] as any).text);
    expect(afterMetadata.url).toContain("/interactive.html");
  });
});
