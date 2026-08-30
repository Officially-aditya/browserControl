import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { runRemoteGateway } from "../../src/remote/gateway.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("Remote web-control gateway", () => {
  let gateway: Awaited<ReturnType<typeof runRemoteGateway>>;
  let port: number;
  let extension: WebSocket;
  const calls: Array<{ method: string; params: any }> = [];
  const observationId = "42:3:test-observation";

  beforeAll(async () => {
    gateway = await runRemoteGateway({
      host: "127.0.0.1",
      port: 0,
      extensionToken: "device-secret",
      mcpBearerToken: "mcp-secret",
      leaseTtlMs: 5_000,
    });
    port = (gateway.httpServer.address() as any).port;

    extension = new WebSocket(`ws://127.0.0.1:${port}/extension?token=device-secret`);
    await new Promise<void>((resolve, reject) => {
      extension.once("open", () => resolve());
      extension.once("error", reject);
    });

    extension.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (!request.id || !request.method) return;
      calls.push({ method: request.method, params: request.params });
      let result: any;
      switch (request.method) {
        case "status":
          result = { connected: true, attachedTabId: 42, visualEpoch: 3, paused: false };
          break;
        case "observe":
          result = {
            observationId,
            visualEpoch: 3,
            targetId: "42",
            url: "https://example.test/",
            title: "Example",
            viewportWidth: 1200,
            viewportHeight: 800,
            coordinateSpace: "normalized_1000",
            mimeType: "image/png",
            image: ONE_PIXEL_PNG,
          };
          break;
        default:
          result = { success: true, visualEpoch: 4 };
      }
      extension.send(JSON.stringify({ id: request.id, ok: true, result }));
    });
  });

  afterAll(async () => {
    extension?.close();
    gateway?.wss.close();
    if (gateway?.httpServer) {
      await new Promise<void>((resolve) => gateway.httpServer.close(() => resolve()));
    }
  });

  function createClient() {
    const client = new Client({ name: "remote-gateway-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer mcp-secret" } },
    });
    return { client, transport };
  }

  it("lists model-facing browser tools and returns screenshot image content", async () => {
    const { client, transport } = createClient();
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("browser_observe");
      expect(names).toContain("browser_click");
      expect(names).toContain("browser_tabs");

      const result = await client.callTool({ name: "browser_observe", arguments: { format: "png" } });
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(2);
      expect((result.content[0] as any).text).toContain(observationId);
      expect((result.content[1] as any).type).toBe("image");
      expect((result.content[1] as any).data).toBe(ONE_PIXEL_PNG);
    } finally {
      await client.close();
    }
  });

  it("routes normalized observation-bound actions to the extension", async () => {
    calls.length = 0;
    const { client, transport } = createClient();
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "browser_click",
        arguments: { observationId, x: 625, y: 410, button: "left" },
      });
      expect(result.isError).toBeFalsy();
      const click = calls.find((call) => call.method === "click");
      expect(click).toBeDefined();
      expect(click!.params).toMatchObject({ observationId, x: 625, y: 410, button: "left" });
      await client.callTool({ name: "browser_release_control", arguments: {} });
    } finally {
      await client.close();
    }
  });

  it("enforces a single interactive control lease across MCP sessions", async () => {
    const first = createClient();
    const second = createClient();
    try {
      await first.client.connect(first.transport);
      await second.client.connect(second.transport);

      const firstAction = await first.client.callTool({ name: "browser_type", arguments: { text: "first" } });
      expect(firstAction.isError).toBeFalsy();

      const blocked = await second.client.callTool({ name: "browser_type", arguments: { text: "second" } });
      expect(blocked.isError).toBe(true);
      expect((blocked.content[0] as any).text).toContain("DEVICE_BUSY");

      await first.client.callTool({ name: "browser_release_control", arguments: {} });
      const afterRelease = await second.client.callTool({ name: "browser_type", arguments: { text: "second" } });
      expect(afterRelease.isError).toBeFalsy();
      await second.client.callTool({ name: "browser_release_control", arguments: {} });
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });
});
