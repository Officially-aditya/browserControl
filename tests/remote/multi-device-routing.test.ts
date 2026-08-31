import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import WebSocket from "ws";
import { runRemoteGateway } from "../../src/remote/gateway.js";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type PairedDevice = {
  deviceId: string;
  deviceToken: string;
  mcpToken: string;
  socket: WebSocket;
  observationId: string;
  calls: Array<{ method: string; params: any }>;
};

describe("multi-device relay routing", () => {
  let gateway: Awaited<ReturnType<typeof runRemoteGateway>>;
  let port: number;
  const devices: PairedDevice[] = [];

  beforeAll(async () => {
    gateway = await runRemoteGateway({
      host: "127.0.0.1",
      port: 0,
      adminBearerToken: "admin-secret",
      leaseTtlMs: 5_000,
    });
    port = (gateway.httpServer.address() as any).port;

    for (const [index, name] of ["Alice Chrome", "Bob Chrome"].entries()) {
      const created = await fetch(`http://127.0.0.1:${port}/pairing/create`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const pairing = await created.json() as { code: string };
      const claimed = await fetch(`http://127.0.0.1:${port}/pairing/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairing.code }),
      });
      expect(claimed.status).toBe(200);
      const credential = await claimed.json() as { deviceId: string; deviceToken: string; mcpToken: string };
      const observationId = `${index + 1}:7:device-${index + 1}`;
      const calls: Array<{ method: string; params: any }> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(credential.deviceToken)}`);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        if (!request.id || !request.method) return;
        calls.push({ method: request.method, params: request.params });
        let result: any;
        if (request.method === "status") {
          result = { connected: true, attachedTabId: 100 + index, visualEpoch: 7, paused: false };
        } else if (request.method === "observe") {
          result = {
            observationId,
            visualEpoch: 7,
            targetId: String(100 + index),
            url: `https://device-${index + 1}.example/`,
            title: name,
            viewportWidth: 1200,
            viewportHeight: 800,
            imageWidth: 1200,
            imageHeight: 800,
            imageScale: 1,
            sourceRegion: { x: 0, y: 0, width: 1200, height: 800 },
            kind: "overview",
            coordinateSpace: "normalized_1000",
            mimeType: "image/png",
            image: ONE_PIXEL_PNG,
          };
        } else {
          result = { success: true, visualEpoch: 8, device: index + 1 };
        }
        socket.send(JSON.stringify({ id: request.id, ok: true, result }));
      });
      devices.push({ ...credential, socket, observationId, calls });
    }
  });

  afterAll(async () => {
    for (const device of devices) device.socket.close();
    gateway?.wss.close();
    if (gateway?.httpServer) await new Promise<void>((resolve) => gateway.httpServer.close(() => resolve()));
  });

  function clientFor(device: PairedDevice, clientId: string) {
    const client = new Client(
      { name: "multi-device-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${device.mcpToken}`,
          "X-BrowserControl-Client-Id": clientId,
        },
      },
    });
    return { client, transport };
  }

  it("keeps multiple extension sockets connected simultaneously", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()) as any;
    expect(health.connectedDevices).toBe(2);
    expect(gateway.deviceRouter.isConnected(devices[0].deviceId)).toBe(true);
    expect(gateway.deviceRouter.isConnected(devices[1].deviceId)).toBe(true);
  });

  it("routes each MCP credential only to its paired extension", async () => {
    const alice = clientFor(devices[0], "alice-client");
    const bob = clientFor(devices[1], "bob-client");
    try {
      await alice.client.connect(alice.transport);
      await bob.client.connect(bob.transport);

      const aliceStatus = await alice.client.callTool({ name: "browser_status", arguments: {} });
      const bobStatus = await bob.client.callTool({ name: "browser_status", arguments: {} });
      const alicePayload = JSON.parse((aliceStatus.content[0] as any).text);
      const bobPayload = JSON.parse((bobStatus.content[0] as any).text);
      expect(alicePayload.deviceId).toBe(devices[0].deviceId);
      expect(bobPayload.deviceId).toBe(devices[1].deviceId);
      expect(alicePayload.extension.attachedTabId).toBe(100);
      expect(bobPayload.extension.attachedTabId).toBe(101);

      const aliceObservation = await alice.client.callTool({ name: "browser_observe", arguments: { format: "png" } });
      const bobObservation = await bob.client.callTool({ name: "browser_observe", arguments: { format: "png" } });
      expect((aliceObservation.content[0] as any).text).toContain(devices[0].observationId);
      expect((bobObservation.content[0] as any).text).toContain(devices[1].observationId);

      await alice.client.callTool({ name: "browser_click", arguments: { observationId: devices[0].observationId, x: 100, y: 100 } });
      await bob.client.callTool({ name: "browser_click", arguments: { observationId: devices[1].observationId, x: 900, y: 900 } });

      expect(devices[0].calls.some((call) => call.method === "click" && call.params.x === 100)).toBe(true);
      expect(devices[0].calls.some((call) => call.method === "click" && call.params.x === 900)).toBe(false);
      expect(devices[1].calls.some((call) => call.method === "click" && call.params.x === 900)).toBe(true);
      expect(devices[1].calls.some((call) => call.method === "click" && call.params.x === 100)).toBe(false);
    } finally {
      await alice.client.close();
      await bob.client.close();
    }
  });

  it("keeps interactive leases independent per device", async () => {
    const alice = clientFor(devices[0], "shared-client-a");
    const bob = clientFor(devices[1], "shared-client-b");
    try {
      await alice.client.connect(alice.transport);
      await bob.client.connect(bob.transport);
      const aliceAction = await alice.client.callTool({ name: "browser_type", arguments: { observationId: devices[0].observationId, text: "alice" } });
      const bobAction = await bob.client.callTool({ name: "browser_type", arguments: { observationId: devices[1].observationId, text: "bob" } });
      expect(aliceAction.isError).toBeFalsy();
      expect(bobAction.isError).toBeFalsy();
    } finally {
      await alice.client.close();
      await bob.client.close();
    }
  });

  it("rotates one connector credential without disconnecting its extension or affecting another device", async () => {
    const oldAliceToken = devices[0].mcpToken;
    const response = await fetch(`http://127.0.0.1:${port}/devices/${devices[0].deviceId}/connector/rotate`, {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret" },
    });
    expect(response.status).toBe(200);
    const rotated = await response.json() as { deviceId: string; mcpToken: string };
    devices[0].mcpToken = rotated.mcpToken;

    const rejected = await fetch(`http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(oldAliceToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {}, _meta: { protocolVersion: "2026-07-28" } }),
    });
    expect(rejected.status).toBe(401);
    expect(gateway.deviceRouter.isConnected(devices[0].deviceId)).toBe(true);
    expect(gateway.deviceRouter.isConnected(devices[1].deviceId)).toBe(true);
  });
});
