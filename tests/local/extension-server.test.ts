import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startLocalExtensionServer, type LocalExtensionServer } from "../../src/local/extension-server.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function openSocket(server: LocalExtensionServer): Promise<WebSocket> {
  const handshake = await fetch(`http://127.0.0.1:${server.port}/handshake`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "X-BrowserControl-Extension-Id": EXTENSION_ID,
    },
  });
  expect(handshake.status).toBe(200);
  const { challenge } = await handshake.json() as { challenge: string };

  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/extension?extensionId=${EXTENSION_ID}&challenge=${encodeURIComponent(challenge)}`,
    { origin: ORIGIN },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

describe("local extension server", () => {
  const servers: LocalExtensionServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("binds only to loopback", async () => {
    await expect(startLocalExtensionServer({ host: "0.0.0.0", port: 0 }))
      .rejects.toThrow(/loopback only/);
  });

  it("rejects handshakes without an extension identity", async () => {
    const server = await startLocalExtensionServer({ port: 0 });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/handshake`, { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("routes RPC directly between the local bridge and extension socket", async () => {
    const server = await startLocalExtensionServer({ port: 0 });
    servers.push(server);
    const socket = await openSocket(server);

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message?.id || message?.method !== "status") return;
      socket.send(JSON.stringify({
        id: message.id,
        ok: true,
        result: { connected: true, transport: "local" },
      }));
    });

    await expect(server.bridge.call("status", {}, 2_000)).resolves.toEqual({
      connected: true,
      transport: "local",
    });
    socket.close();
  });

  it("makes handshake challenges single use", async () => {
    const server = await startLocalExtensionServer({ port: 0 });
    servers.push(server);
    const handshake = await fetch(`http://127.0.0.1:${server.port}/handshake`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "X-BrowserControl-Extension-Id": EXTENSION_ID,
      },
    });
    const { challenge } = await handshake.json() as { challenge: string };
    const url = `ws://127.0.0.1:${server.port}/extension?extensionId=${EXTENSION_ID}&challenge=${encodeURIComponent(challenge)}`;

    const first = new WebSocket(url, { origin: ORIGIN });
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });

    const second = new WebSocket(url, { origin: ORIGIN });
    await expect(new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
      second.once("close", () => reject(new Error("rejected")));
    })).rejects.toThrow();

    first.close();
    second.close();
  });
});
