import net from "node:net";
import tls from "node:tls";
import WebSocket, { type WebSocketServer } from "ws";
import { runRemoteGateway, type RemoteGatewayOptions } from "./gateway.js";

export interface GatewayRuntimeOptions extends RemoteGatewayOptions {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  tlsKey?: string | Buffer;
  tlsCert?: string | Buffer;
}

export interface GatewayRuntimeHandle {
  httpServer: net.Server;
  wss: WebSocketServer;
  stopHeartbeat: () => void;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "::";
}

export function installExtensionHeartbeat(
  wss: WebSocketServer,
  options: Pick<GatewayRuntimeOptions, "heartbeatIntervalMs" | "heartbeatTimeoutMs"> = {}
): () => void {
  const intervalMs = options.heartbeatIntervalMs ?? 20_000;
  const timeoutMs = Math.max(options.heartbeatTimeoutMs ?? 45_000, intervalMs + 1_000);
  const lastSeen = new WeakMap<object, number>();

  const markAlive = (ws: WebSocket) => lastSeen.set(ws, Date.now());
  const onConnection = (ws: WebSocket) => {
    markAlive(ws);
    ws.on("pong", () => markAlive(ws));
    ws.on("message", () => markAlive(ws));
  };

  wss.on("connection", onConnection);
  for (const ws of wss.clients) onConnection(ws);

  const timer = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const seenAt = lastSeen.get(ws) ?? now;
      if (now - seenAt > timeoutMs) {
        ws.terminate();
        continue;
      }
      try {
        ws.send(JSON.stringify({ type: "keepalive", timestamp: now }));
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    wss.off("connection", onConnection);
  };
}

async function listen(server: net.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function runGatewayRuntime(options: GatewayRuntimeOptions = {}): Promise<GatewayRuntimeHandle> {
  const wantsTls = options.tlsKey != null || options.tlsCert != null;
  if (wantsTls && (!options.tlsKey || !options.tlsCert)) {
    throw new Error("Both tlsKey and tlsCert are required when TLS is enabled");
  }

  if (!wantsTls) {
    const gateway = await runRemoteGateway(options);
    const stopHeartbeat = installExtensionHeartbeat(gateway.wss, options);
    gateway.httpServer.once("close", stopHeartbeat);
    return { httpServer: gateway.httpServer, wss: gateway.wss, stopHeartbeat };
  }

  const publicHost = options.host ?? process.env.BROWSERCONTROL_GATEWAY_HOST ?? "127.0.0.1";
  const publicPort = options.port ?? Number(process.env.BROWSERCONTROL_GATEWAY_PORT || 8787);
  const localPublicListener = isLoopbackHost(publicHost);
  const configuredMcpToken = options.mcpBearerToken ?? process.env.BROWSERCONTROL_MCP_TOKEN ?? "";
  const configuredAdminToken = options.adminBearerToken ?? process.env.BROWSERCONTROL_ADMIN_TOKEN ?? "";
  const configuredDeviceToken = options.extensionToken ?? process.env.BROWSERCONTROL_DEVICE_TOKEN ?? "";

  if (!localPublicListener && !configuredAdminToken) {
    throw new Error("BROWSERCONTROL_ADMIN_TOKEN is required when the TLS relay is publicly bound");
  }
  if (!localPublicListener && configuredDeviceToken) {
    throw new Error("BROWSERCONTROL_DEVICE_TOKEN is only supported for loopback development; public TLS relays must use revocable device pairing");
  }
  if (!localPublicListener && configuredMcpToken) {
    throw new Error("BROWSERCONTROL_MCP_TOKEN is only supported for loopback development; public TLS relays use device-scoped MCP credentials from pairing");
  }

  // Keep the routed MCP/WebSocket relay on a private ephemeral loopback port and
  // put a transparent TLS terminator in front. The public relay still routes MCP
  // requests by per-device connector credentials; the private hop is not a
  // separate trust boundary.
  const internalGateway = await runRemoteGateway({
    ...options,
    mcpBearerToken: localPublicListener ? configuredMcpToken : "",
    adminBearerToken: configuredAdminToken,
    extensionToken: localPublicListener ? configuredDeviceToken : "",
    host: "127.0.0.1",
    port: 0,
  });
  const internalAddress = internalGateway.httpServer.address();
  if (!internalAddress || typeof internalAddress === "string") {
    await closeServer(internalGateway.httpServer);
    throw new Error("Could not determine internal browserControl relay port");
  }

  const stopHeartbeat = installExtensionHeartbeat(internalGateway.wss, options);
  const tlsServer = tls.createServer(
    { key: options.tlsKey!, cert: options.tlsCert! },
    (secureSocket) => {
      const upstream = net.connect(internalAddress.port, "127.0.0.1");
      secureSocket.pipe(upstream).pipe(secureSocket);

      const closePeer = () => {
        if (!secureSocket.destroyed) secureSocket.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };
      secureSocket.on("error", closePeer);
      upstream.on("error", closePeer);
    }
  );

  try {
    await listen(tlsServer, publicPort, publicHost);
  } catch (error) {
    stopHeartbeat();
    internalGateway.wss.close();
    await closeServer(internalGateway.httpServer);
    throw error;
  }

  tlsServer.once("close", () => {
    stopHeartbeat();
    internalGateway.wss.close();
    void closeServer(internalGateway.httpServer);
  });

  const address = tlsServer.address();
  const actualPort = typeof address === "object" && address ? address.port : publicPort;
  console.log(`[browserControl] Secure routed relay listening on https://${publicHost}:${actualPort}`);
  console.log(`[browserControl] MCP endpoint: https://${publicHost}:${actualPort}/mcp`);
  console.log(`[browserControl] Extension endpoint: wss://${publicHost}:${actualPort}/extension`);

  return { httpServer: tlsServer, wss: internalGateway.wss, stopHeartbeat };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGatewayRuntime({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
