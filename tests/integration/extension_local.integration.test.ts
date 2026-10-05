import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { PNG } from "pngjs";
import { launchRealChrome, type LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, type TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { decodeImageDimensions } from "../../src/screen/image-decoder.js";

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

  it("resizes and crops screenshots without changing the live viewport or scroll position", async () => {
    const initial = await client.callTool({ name: "browser_observe", arguments: {} });
    expect(initial.isError).toBeFalsy();
    // Let Chrome's initial debugger notification finish its viewport animation.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const targets = await controller.connection.send("Target.getTargets");
    const worker = targets.targetInfos.find((target: any) => target.type === "service_worker" && target.url.endsWith("/service-worker.js"));
    expect(worker).toBeTruthy();
    const { sessionId } = await controller.connection.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
    await controller.connection.send("Runtime.evaluate", {
      expression: `(() => {
        globalThis.__CAPTURE_REQUESTS__ = [];
        globalThis.__CAPTURE_SEND__ = chrome.debugger.sendCommand;
        chrome.debugger.sendCommand = (...args) => {
          if (args[1] === "Page.captureScreenshot") __CAPTURE_REQUESTS__.push(args[2]);
          return __CAPTURE_SEND__.apply(chrome.debugger, args);
        };
      })()`,
    }, sessionId);
    await controller.session.send("Runtime.evaluate", {
      expression: `(() => {
        const spacer = document.createElement("div");
        spacer.id = "capture-spacer";
        spacer.style.height = "300vh";
        document.body.appendChild(spacer);
        scrollTo(0, 321);
        const marker = document.createElement("div");
        marker.id = "capture-marker";
        marker.style.cssText = "position:fixed;background:rgb(230,20,40);z-index:999999;pointer-events:none;";
        marker.style.left = visualViewport.width / 4 + "px";
        marker.style.top = visualViewport.height / 4 + "px";
        marker.style.width = visualViewport.width / 4 + "px";
        marker.style.height = visualViewport.height / 4 + "px";
        document.body.appendChild(marker);
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const geometry = () => [innerWidth, innerHeight, visualViewport.width, visualViewport.height, scrollX, scrollY];
          const baseline = JSON.stringify(geometry());
          window.__CAPTURE_CHANGES__ = [];
          window.__CAPTURE_WATCH__ = () => {
            const current = JSON.stringify(geometry());
            if (current !== baseline) window.__CAPTURE_CHANGES__.push(current);
          };
          addEventListener("resize", window.__CAPTURE_WATCH__);
          addEventListener("scroll", window.__CAPTURE_WATCH__);
          visualViewport.addEventListener("resize", window.__CAPTURE_WATCH__);
          resolve();
        })));
      })()`,
      awaitPromise: true,
    });
    try {
      let metadata: any;
      for (const format of ["jpeg", "webp", "png"]) {
        const observation = await client.callTool({
          name: "browser_observe",
          arguments: { format, maxLongEdge: 640 },
        });
        expect(observation.isError).toBeFalsy();
        metadata = JSON.parse((observation.content[0] as any).text);
        const image = Buffer.from((observation.content[1] as any).data, "base64");
        expect(decodeImageDimensions(image)).toMatchObject({ width: metadata.imageWidth, height: metadata.imageHeight });
        expect(Math.max(metadata.imageWidth, metadata.imageHeight)).toBeLessThanOrEqual(640);
      }

      for (let level = 0; level < 2; level++) {
        const region = await client.callTool({
          name: "browser_inspect",
          arguments: {
            observationId: metadata.observationId,
            x: 250, y: 250,
            width: level === 0 ? 250 : 500,
            height: level === 0 ? 250 : 500,
          },
        });
        expect(region.isError).toBeFalsy();
        metadata = JSON.parse((region.content[0] as any).text);
        const png = PNG.sync.read(Buffer.from((region.content[1] as any).data, "base64"));
        expect(png.width).toBe(metadata.imageWidth);
        expect(png.height).toBe(metadata.imageHeight);
        const center = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
        expect([...png.data.subarray(center, center + 4)]).toEqual([230, 20, 40, 255]);
      }

      const changes = await controller.session.send("Runtime.evaluate", {
        expression: "(__CAPTURE_WATCH__(), __CAPTURE_CHANGES__)",
        returnByValue: true,
      });
      expect(changes.result.value).toEqual([]);
      const captures = await controller.connection.send("Runtime.evaluate", {
        expression: "__CAPTURE_REQUESTS__",
        returnByValue: true,
      }, sessionId);
      expect(captures.result.value).toHaveLength(5);
      for (const capture of captures.result.value) {
        expect(capture.clip).toBeUndefined();
        expect(capture.captureBeyondViewport).toBe(false);
      }
    } finally {
      await controller.connection.send("Runtime.evaluate", {
        expression: "chrome.debugger.sendCommand = __CAPTURE_SEND__",
      }, sessionId);
      await controller.connection.send("Target.detachFromTarget", { sessionId });
      await controller.session.send("Runtime.evaluate", {
        expression: `(() => {
          removeEventListener("resize", window.__CAPTURE_WATCH__);
          removeEventListener("scroll", window.__CAPTURE_WATCH__);
          visualViewport.removeEventListener("resize", window.__CAPTURE_WATCH__);
          document.getElementById("capture-marker")?.remove();
          document.getElementById("capture-spacer")?.remove();
          scrollTo(0, 0);
        })()`,
      });
    }
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

  it("ignores background child-frame navigation churn when visible geometry is unchanged", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    await controller.session.send("Runtime.evaluate", {
      expression: `(() => {
        const frame = document.createElement("iframe");
        frame.id = "background-media-frame";
        frame.style.display = "none";
        frame.src = ${JSON.stringify("about:blank")};
        document.body.appendChild(frame);
        setTimeout(() => { frame.src = ${JSON.stringify("data:text/html,<p>media churn</p>")}; }, 25);
      })()`,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const status = await client.callTool({ name: "browser_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    const statusPayload = JSON.parse((status.content[0] as any).text);

    const clicked = await client.callTool({
      name: "browser_click",
      arguments: {
        observationId: metadata.observationId,
        x: 68,
        y: 151,
        button: "left",
      },
    });
    if (clicked.isError) {
      throw new Error(`background frame churn unexpectedly invalidated observation: ${(clicked.content[0] as any)?.text}; last reason=${statusPayload.extension?.lastInvalidationReason}`);
    }
    expect(clicked.isError).toBeFalsy();
  });

  it("still rejects an observation after a trusted user-like interaction", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

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

  it("lets deterministic recovery commands escape a stale observation", async () => {
    const observation = await client.callTool({
      name: "browser_observe",
      arguments: { format: "jpeg", maxLongEdge: 640 },
    });
    expect(observation.isError).toBeFalsy();
    const metadata = JSON.parse((observation.content[0] as any).text);

    await controller.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 450,
      y: 320,
      button: "left",
      clickCount: 1,
    });
    await controller.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 450,
      y: 320,
      button: "left",
      clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const staleClick = await client.callTool({
      name: "browser_click",
      arguments: { observationId: metadata.observationId, x: 68, y: 151, button: "left" },
    });
    expect(staleClick.isError).toBe(true);

    const reload = await client.callTool({
      name: "browser_reload",
      arguments: { observationId: metadata.observationId },
    });
    expect(reload.isError).toBeFalsy();
  });

  it("bootstraps an http(s) navigation directly from a fresh blank tab", async () => {
    const blank = await client.callTool({
      name: "browser_new_tab",
      arguments: {},
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
