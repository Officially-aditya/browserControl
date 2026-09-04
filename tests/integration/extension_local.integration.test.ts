import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { launchRealChrome, type LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, type TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { ControlLease, type BrowserRoute } from "../../src/browser-control/bridge.js";
import { handleBrowserToolCall } from "../../src/browser-control/tools.js";
import { startLocalExtensionServer, type LocalExtensionServer } from "../../src/local/extension-server.js";

const canaryConfigured = Boolean(process.env.CHROME_PATH);

async function waitForLocalExtension(server: LocalExtensionServer): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((response) => response.json()) as any;
    if (health.extensionConnected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the browserControl extension to connect to the localhost bridge");
}

describe.skipIf(!canaryConfigured)("Real Chrome extension -> local bridge -> browser tools canary", () => {
  let chrome: LaunchedChrome;
  let fixture: TestServer;
  let controller: ChromeController;
  let local: LocalExtensionServer;
  let route: BrowserRoute;

  beforeAll(async () => {
    local = await startLocalExtensionServer({ port: 8765 });
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

    await waitForLocalExtension(local);
    route = {
      deviceId: "local-canary",
      bridge: local.bridge,
      lease: new ControlLease(60_000),
    };
  }, 30_000);

  afterAll(async () => {
    try { await handleBrowserToolCall(route, "local-canary", "browser_release_control", {}); } catch {}
    try { await controller?.disconnect(); } catch {}
    try { await chrome?.close(); } catch {}
    try { await fixture?.close(); } catch {}
    try { await local?.close(); } catch {}
  });

  it("observes and clicks the existing Chrome tab without using the relay", async () => {
    const status = await handleBrowserToolCall(route, "local-canary", "browser_status", {});
    expect(status.isError).toBeFalsy();
    const statusPayload = JSON.parse((status.content[0] as any).text);
    expect(statusPayload.extension.connected).toBe(true);
    expect(statusPayload.extension.localConnected).toBe(true);
    expect(statusPayload.extension.remoteConnected).toBe(false);

    const observation = await handleBrowserToolCall(route, "local-canary", "browser_observe", {
      format: "png",
      maxLongEdge: 640,
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

    const clicked = await handleBrowserToolCall(route, "local-canary", "browser_click", {
      observationId: metadata.observationId,
      x: 68,
      y: 151,
      button: "left",
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

  it("rejects stale observations locally with the same semantics as remote", async () => {
    const observation = await handleBrowserToolCall(route, "local-canary", "browser_observe", {
      format: "jpeg",
      maxLongEdge: 640,
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    await controller.session.send("Runtime.evaluate", {
      expression: `(() => {
        const marker = document.createElement("div");
        marker.id = "external-local-change-marker";
        marker.textContent = "changed outside local browserControl";
        document.body.appendChild(marker);
      })()`,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const stale = await handleBrowserToolCall(route, "local-canary", "browser_click", {
      observationId: metadata.observationId,
      x: 68,
      y: 151,
      button: "left",
    });
    expect(stale.isError).toBe(true);
    expect((stale.content[0] as any).text).toContain("STALE_OBSERVATION");
  });
});
