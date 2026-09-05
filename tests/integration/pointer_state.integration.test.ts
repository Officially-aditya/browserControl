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
  throw new Error(`Timed out waiting for browserControl extension: ${JSON.stringify(lastStatus)}`);
}

describe.skipIf(!canaryConfigured)("Real Chrome logical pointer state", () => {
  let chrome: LaunchedChrome;
  let fixture: TestServer;
  let controller: ChromeController;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    client = new Client({ name: "pointer-state-canary", version: "1.0.0" });
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

  it("tracks agent hover position and renders a visible operator cursor", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    const moved = await client.callTool({
      name: "browser_move",
      arguments: { observationId: metadata.observationId, x: 300, y: 400 },
    });
    expect(moved.isError).toBeFalsy();
    const movePayload = JSON.parse((moved.content[0] as any).text);
    expect(movePayload.pointer.known).toBe(true);
    expect(movePayload.pointer.source).toBe("agent");
    expect(movePayload.pointer.coordinateSpace).toBe("viewport_normalized_1000");
    expect(movePayload.pointer.x).toBeCloseTo(300, 0);
    expect(movePayload.pointer.y).toBeCloseTo(400, 0);

    const visibleCursor = await controller.session.send("Runtime.evaluate", {
      expression: `(() => {
        const pointer = document.querySelector("[data-browsercontrol-pointer]");
        if (!pointer) return null;
        return {
          visibility: getComputedStyle(pointer).visibility,
          x: Number(pointer.getAttribute("data-x")),
          y: Number(pointer.getAttribute("data-y")),
          width: innerWidth,
          height: innerHeight,
          pointerEvents: getComputedStyle(pointer).pointerEvents,
        };
      })()`,
      returnByValue: true,
    });
    const cursor = visibleCursor.result.value as any;
    expect(cursor).toBeTruthy();
    expect(cursor.visibility).toBe("visible");
    expect(cursor.pointerEvents).toBe("none");
    expect((cursor.x / cursor.width) * 1000).toBeCloseTo(300, 0);
    expect((cursor.y / cursor.height) * 1000).toBeCloseTo(400, 0);

    const status = await client.callTool({ name: "browser_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    const statusPayload = JSON.parse((status.content[0] as any).text);
    expect(statusPayload.extension.pointer.source).toBe("agent");
    expect(statusPayload.extension.pointer.x).toBeCloseTo(300, 0);
    expect(statusPayload.extension.pointer.y).toBeCloseTo(400, 0);

    const after = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(after.isError).toBeFalsy();
    const afterMetadata = JSON.parse((after.content[0] as any).text);
    expect(afterMetadata.pointer.source).toBe("agent");
    expect(afterMetadata.pointer.x).toBeCloseTo(300, 0);
    expect(afterMetadata.pointer.y).toBeCloseTo(400, 0);

    const restoredCursor = await controller.session.send("Runtime.evaluate", {
      expression: `(() => {
        const pointer = document.querySelector("[data-browsercontrol-pointer]");
        return pointer ? getComputedStyle(pointer).visibility : null;
      })()`,
      returnByValue: true,
    });
    expect(restoredCursor.result.value).toBe("visible");
  });

  it("tracks real user pointer movement without staling the observation, while pointerdown still does", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    await controller.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 600,
      y: 350,
      button: "none",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const movedStatus = await client.callTool({ name: "browser_status", arguments: {} });
    expect(movedStatus.isError).toBeFalsy();
    const movedStatusPayload = JSON.parse((movedStatus.content[0] as any).text);
    expect(movedStatusPayload.extension.pointer.known).toBe(true);
    expect(movedStatusPayload.extension.pointer.source).toBe("user");

    const stillFresh = await client.callTool({
      name: "browser_click",
      arguments: {
        observationId: metadata.observationId,
        x: 68,
        y: 151,
        button: "left",
      },
    });
    expect(stillFresh.isError).toBeFalsy();

    const nextObservation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(nextObservation.isError).toBeFalsy();
    const nextMetadata = JSON.parse((nextObservation.content[0] as any).text);

    await controller.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 400,
      y: 300,
      button: "left",
      clickCount: 1,
    });
    await controller.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 400,
      y: 300,
      button: "left",
      clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const userStatus = await client.callTool({ name: "browser_status", arguments: {} });
    expect(userStatus.isError).toBeFalsy();
    const userStatusPayload = JSON.parse((userStatus.content[0] as any).text);
    expect(userStatusPayload.extension.pointer.source).toBe("user");

    const stale = await client.callTool({
      name: "browser_click",
      arguments: {
        observationId: nextMetadata.observationId,
        x: 68,
        y: 151,
        button: "left",
      },
    });
    expect(stale.isError).toBe(true);
    expect((stale.content[0] as any).text).toContain("STALE_OBSERVATION");
  });
});