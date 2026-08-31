import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import WebSocket from "ws";
import { runRemoteGateway } from "../../src/remote/gateway.js";
import { RedisClient } from "../../src/remote/redis-client.js";

const REDIS_URL = process.env.BROWSERCONTROL_TEST_REDIS_URL || "";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Credential = { deviceId: string; deviceToken: string; mcpToken: string };

type MockExtension = {
  socket: WebSocket;
  observationId: string;
  calls: Array<{ method: string; params: any }>;
};

async function pairAcross(createPort: number, claimPort: number, name: string): Promise<Credential> {
  const created = await fetch(`http://127.0.0.1:${createPort}/pairing/create`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(created.status).toBe(201);
  const pairing = await created.json() as { code: string };

  const claimed = await fetch(`http://127.0.0.1:${claimPort}/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairing.code }),
  });
  expect(claimed.status).toBe(200);
  return claimed.json() as Promise<Credential>;
}

async function connectMockExtension(port: number, credential: Credential, tabId: number, label: string): Promise<MockExtension> {
  const observationId = `${tabId}:9:${label}`;
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
      result = { connected: true, attachedTabId: tabId, visualEpoch: 9, paused: false };
    } else if (request.method === "observe") {
      result = {
        observationId,
        visualEpoch: 9,
        targetId: String(tabId),
        url: `https://${label}.example/`,
        title: label,
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
      result = { success: true, visualEpoch: 10, label };
    }
    socket.send(JSON.stringify({ id: request.id, ok: true, result }));
  });

  return { socket, observationId, calls };
}

function createClient(port: number, token: string, clientId: string) {
  const client = new Client(
    { name: "horizontal-relay-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-BrowserControl-Client-Id": clientId,
      },
    },
  });
  return { client, transport };
}

const suite = REDIS_URL ? describe : describe.skip;

suite("horizontal relay scaling with shared Redis state", () => {
  let redis: RedisClient;
  let gatewayA: Awaited<ReturnType<typeof runRemoteGateway>>;
  let gatewayB: Awaited<ReturnType<typeof runRemoteGateway>>;
  let portA: number;
  let portB: number;
  let alice: Credential;
  let bob: Credential;
  let aliceExtension: MockExtension;
  let bobExtension: MockExtension;

  async function waitForOwner(deviceId: string, replicaId: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const presence = await gatewayA.relayState.getPresence(deviceId);
      if (presence?.replicaId === replicaId) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${deviceId} to be owned by ${replicaId}`);
  }

  beforeAll(async () => {
    redis = new RedisClient(REDIS_URL);
    await redis.command("FLUSHDB");
    [portA, portB] = await Promise.all([reservePort(), reservePort()]);

    gatewayA = await runRemoteGateway({
      host: "127.0.0.1",
      port: portA,
      adminBearerToken: "admin-secret",
      redisUrl: REDIS_URL,
      redisPrefix: "browsercontrol-horizontal-test",
      clusterToken: "cluster-secret",
      replicaId: "relay-a",
      relayInternalUrl: `http://127.0.0.1:${portA}`,
      allowLoopbackDevelopment: false,
      presenceTtlMs: 15_000,
      leaseTtlMs: 5_000,
    });
    gatewayB = await runRemoteGateway({
      host: "127.0.0.1",
      port: portB,
      adminBearerToken: "admin-secret",
      redisUrl: REDIS_URL,
      redisPrefix: "browsercontrol-horizontal-test",
      clusterToken: "cluster-secret",
      replicaId: "relay-b",
      relayInternalUrl: `http://127.0.0.1:${portB}`,
      allowLoopbackDevelopment: false,
      presenceTtlMs: 15_000,
      leaseTtlMs: 5_000,
    });

    alice = await pairAcross(portA, portB, "Alice Chrome");
    bob = await pairAcross(portB, portA, "Bob Chrome");
    aliceExtension = await connectMockExtension(portA, alice, 301, "alice");
    bobExtension = await connectMockExtension(portB, bob, 302, "bob");
    await waitForOwner(alice.deviceId, "relay-a");
    await waitForOwner(bob.deviceId, "relay-b");
  });

  afterAll(async () => {
    try { aliceExtension?.socket.close(); } catch {}
    try { bobExtension?.socket.close(); } catch {}
    try { gatewayA?.wss.close(); } catch {}
    try { gatewayB?.wss.close(); } catch {}
    if (gatewayA?.httpServer) await new Promise<void>((resolve) => gatewayA.httpServer.close(() => resolve()));
    if (gatewayB?.httpServer) await new Promise<void>((resolve) => gatewayB.httpServer.close(() => resolve()));
    try { await redis?.command("FLUSHDB"); } catch {}
    try { await redis?.close(); } catch {}
  });

  it("shares pairing and identity state across replicas", async () => {
    const devices = await fetch(`http://127.0.0.1:${portA}/devices`, {
      headers: { Authorization: "Bearer admin-secret" },
    }).then((response) => response.json()) as any;
    expect(devices.devices).toHaveLength(2);
    expect(devices.devices.find((device: any) => device.deviceId === alice.deviceId)?.relayReplicaId).toBe("relay-a");
    expect(devices.devices.find((device: any) => device.deviceId === bob.deviceId)?.relayReplicaId).toBe("relay-b");
  });

  it("routes MCP entering the wrong replica directly to the owning WebSocket replica", async () => {
    const aliceClient = createClient(portB, alice.mcpToken, "alice-cloud-client");
    const bobClient = createClient(portA, bob.mcpToken, "bob-cloud-client");
    try {
      await aliceClient.client.connect(aliceClient.transport);
      await bobClient.client.connect(bobClient.transport);

      const aliceStatus = await aliceClient.client.callTool({ name: "browser_status", arguments: {} });
      const bobStatus = await bobClient.client.callTool({ name: "browser_status", arguments: {} });
      const alicePayload = JSON.parse((aliceStatus.content[0] as any).text);
      const bobPayload = JSON.parse((bobStatus.content[0] as any).text);
      expect(alicePayload.deviceId).toBe(alice.deviceId);
      expect(alicePayload.extension.attachedTabId).toBe(301);
      expect(bobPayload.deviceId).toBe(bob.deviceId);
      expect(bobPayload.extension.attachedTabId).toBe(302);

      const aliceObserved = await aliceClient.client.callTool({ name: "browser_observe", arguments: { format: "png" } });
      const bobObserved = await bobClient.client.callTool({ name: "browser_observe", arguments: { format: "png" } });
      expect((aliceObserved.content[0] as any).text).toContain(aliceExtension.observationId);
      expect((bobObserved.content[0] as any).text).toContain(bobExtension.observationId);

      await aliceClient.client.callTool({
        name: "browser_click",
        arguments: { observationId: aliceExtension.observationId, x: 111, y: 222 },
      });
      await bobClient.client.callTool({
        name: "browser_click",
        arguments: { observationId: bobExtension.observationId, x: 777, y: 888 },
      });
      expect(aliceExtension.calls.some((call) => call.method === "click" && call.params.x === 111)).toBe(true);
      expect(aliceExtension.calls.some((call) => call.method === "click" && call.params.x === 777)).toBe(false);
      expect(bobExtension.calls.some((call) => call.method === "click" && call.params.x === 777)).toBe(true);

      await aliceClient.client.callTool({ name: "browser_release_control", arguments: {} });
      await bobClient.client.callTool({ name: "browser_release_control", arguments: {} });
    } finally {
      await aliceClient.client.close();
      await bobClient.client.close();
    }
  });

  it("keeps one device lease consistent even when clients enter through different replicas", async () => {
    const first = createClient(portA, alice.mcpToken, "alice-client-a");
    const second = createClient(portB, alice.mcpToken, "alice-client-b");
    try {
      await first.client.connect(first.transport);
      await second.client.connect(second.transport);
      const acquired = await first.client.callTool({
        name: "browser_type",
        arguments: { observationId: aliceExtension.observationId, text: "first" },
      });
      expect(acquired.isError).toBeFalsy();
      const blocked = await second.client.callTool({
        name: "browser_type",
        arguments: { observationId: aliceExtension.observationId, text: "second" },
      });
      expect(blocked.isError).toBe(true);
      expect((blocked.content[0] as any).text).toContain("DEVICE_BUSY");
      await first.client.callTool({ name: "browser_release_control", arguments: {} });
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });

  it("moves routing when the same device reconnects on another replica", async () => {
    const replacement = await connectMockExtension(portB, alice, 401, "alice-moved");
    await waitForOwner(alice.deviceId, "relay-b");
    const client = createClient(portA, alice.mcpToken, "alice-after-move");
    try {
      await client.client.connect(client.transport);
      const status = await client.client.callTool({ name: "browser_status", arguments: {} });
      const payload = JSON.parse((status.content[0] as any).text);
      expect(payload.extension.attachedTabId).toBe(401);
    } finally {
      await client.client.close();
      aliceExtension.socket.close();
      aliceExtension = replacement;
    }
  });

  it("revokes a device from one replica and disconnects it on another", async () => {
    const closed = new Promise<number>((resolve) => bobExtension.socket.once("close", (code) => resolve(code)));
    const response = await fetch(`http://127.0.0.1:${portA}/devices/${bob.deviceId}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer admin-secret" },
    });
    expect(response.status).toBe(200);
    expect(await closed).toBe(4003);

    const rejected = await fetch(`http://127.0.0.1:${portB}/mcp?token=${encodeURIComponent(bob.mcpToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(rejected.status).toBe(401);
  });
});
