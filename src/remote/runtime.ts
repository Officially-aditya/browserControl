import type http from "node:http";
import WebSocket, { type WebSocketServer } from "ws";
import { runRemoteGateway, type RemoteGatewayOptions } from "./gateway.js";

export interface GatewayRuntimeOptions extends RemoteGatewayOptions {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface GatewayRuntimeHandle {
  httpServer: http.Server;
  wss: WebSocketServer;
  stopHeartbeat: () => void;
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
        // A real application message is intentional: Chrome MV3 counts
        // WebSocket message traffic as extension service-worker activity.
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

export async function runGatewayRuntime(options: GatewayRuntimeOptions = {}): Promise<GatewayRuntimeHandle> {
  const gateway = await runRemoteGateway(options);
  const stopHeartbeat = installExtensionHeartbeat(gateway.wss, options);
  gateway.httpServer.once("close", stopHeartbeat);
  return { httpServer: gateway.httpServer, wss: gateway.wss, stopHeartbeat };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGatewayRuntime({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
