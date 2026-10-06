import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startLocalExtensionServer, type LocalExtensionServer } from "../../src/local/extension-server.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function openSocket(server: Pick<LocalExtensionServer, "port">): Promise<WebSocket> {
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

  it("disconnects pending RPCs and frees the port for a new agent", async () => {
    const onDisconnect = vi.fn();
    const server = await startLocalExtensionServer({ port: 0, onDisconnect });
    servers.push(server);
    const socket = await openSocket(server);
    const pending = expect(server.bridge.call("observe", {}, 2_000)).rejects.toThrow(/Disconnected by user/);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    socket.send(JSON.stringify({ type: "disconnect" }));
    expect(await closed).toBe(4000);
    await pending;
    await server.close();
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
    expect(server.bridge.connected).toBe(false);

    const next = await startLocalExtensionServer({ port: server.port });
    servers.push(next);
    const nextSocket = await openSocket(next);
    expect(next.bridge.connected).toBe(true);
    nextSocket.close();
  });

  it("keeps the listening port when the extension closes normally", async () => {
    const onDisconnect = vi.fn();
    const server = await startLocalExtensionServer({ port: 0, onDisconnect });
    servers.push(server);
    const socket = await openSocket(server);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
    expect(onDisconnect).not.toHaveBeenCalled();
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
  });

  it("exits the local MCP process on disconnect and lets another process use its port", async () => {
    const reservation = await startLocalExtensionServer({ port: 0 });
    const port = reservation.port;
    await reservation.close();
    const child = spawn(process.execPath, ["--import", "tsx", "src/local/runtime.ts"], {
      env: { ...process.env, BROWSERCONTROL_LOCAL_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Local MCP did not start")), 5_000);
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          if (stderr.includes("Local extension bridge listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Local MCP exited before ready (${code}): ${stderr}`));
        });
      });
      const socket = await openSocket({ port });
      socket.send(JSON.stringify({ type: "disconnect" }));
      expect(await exited).toBe(0);
      const next = await startLocalExtensionServer({ port });
      servers.push(next);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    }
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
