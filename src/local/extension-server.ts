import http from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { ExtensionBridge } from "../browser-control/bridge.js";

export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_PORT = 8765;
export const LOCAL_EXTENSION_PATH = "/extension";
export const LOCAL_HANDSHAKE_PATH = "/handshake";

const EXTENSION_ID_RE = /^[a-p]{32}$/;
const CHALLENGE_TTL_MS = 15_000;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024 * 1024;
const KEEPALIVE_MS = 20_000;

type ChallengeRecord = {
  extensionId: string;
  expiresAt: number;
};

export interface LocalExtensionServerOptions {
  host?: string;
  port?: number;
  bridge?: ExtensionBridge;
}

export interface LocalExtensionServer {
  host: string;
  port: number;
  bridge: ExtensionBridge;
  close(): Promise<void>;
}

function extensionOriginFor(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}

function writeJson(response: http.ServerResponse, status: number, payload: unknown, origin?: string): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });
  response.end(body);
}

export async function startLocalExtensionServer(
  options: LocalExtensionServerOptions = {},
): Promise<LocalExtensionServer> {
  const host = options.host || DEFAULT_LOCAL_HOST;
  const requestedPort = options.port ?? DEFAULT_LOCAL_PORT;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("browserControl local extension bridge must bind to loopback only");
  }

  const bridge = options.bridge || new ExtensionBridge("local");
  const challenges = new Map<string, ChallengeRecord>();

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `${host}:${requestedPort}`}`);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "browsercontrol-local",
        extensionConnected: bridge.connected,
      });
      return;
    }

    if (request.method !== "POST" || requestUrl.pathname !== LOCAL_HANDSHAKE_PATH) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const extensionId = String(request.headers["x-browsercontrol-extension-id"] || "");
    if (!EXTENSION_ID_RE.test(extensionId)) {
      writeJson(response, 403, { error: "Invalid browserControl extension identity" });
      return;
    }

    const expectedOrigin = extensionOriginFor(extensionId);
    const origin = String(request.headers.origin || "");
    if (origin && origin !== expectedOrigin) {
      writeJson(response, 403, { error: "Extension origin mismatch" });
      return;
    }

    const now = Date.now();
    for (const [challenge, record] of challenges) {
      if (record.expiresAt <= now) challenges.delete(challenge);
    }

    const challenge = randomBytes(32).toString("base64url");
    challenges.set(challenge, {
      extensionId,
      expiresAt: now + CHALLENGE_TTL_MS,
    });

    writeJson(response, 200, {
      challenge,
      expiresInMs: CHALLENGE_TTL_MS,
    }, origin || expectedOrigin);
  });

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });

  server.on("upgrade", (request, socket, head) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url || "/", `http://${request.headers.host || `${host}:${requestedPort}`}`);
    } catch {
      socket.destroy();
      return;
    }

    if (requestUrl.pathname !== LOCAL_EXTENSION_PATH) {
      socket.destroy();
      return;
    }

    const extensionId = requestUrl.searchParams.get("extensionId") || "";
    const challenge = requestUrl.searchParams.get("challenge") || "";
    const record = challenges.get(challenge);
    const origin = String(request.headers.origin || "");

    if (
      !EXTENSION_ID_RE.test(extensionId) ||
      !record ||
      record.extensionId !== extensionId ||
      record.expiresAt <= Date.now() ||
      origin !== extensionOriginFor(extensionId)
    ) {
      challenges.delete(challenge);
      socket.destroy();
      return;
    }

    challenges.delete(challenge);
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (socket: WebSocket) => {
    bridge.attach(socket);

    const keepAlive = setInterval(() => {
      if (socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify({ type: "keepalive", ts: Date.now() }));
      } catch {
        // The bridge close handler will clean up pending work.
      }
    }, KEEPALIVE_MS);
    keepAlive.unref?.();

    socket.once("close", () => clearInterval(keepAlive));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not resolve browserControl local bridge address");
  }

  return {
    host,
    port: address.port,
    bridge,
    close: async () => {
      bridge.disconnect(1001, "browserControl local process stopped");
      for (const client of webSocketServer.clients) {
        try { client.close(1001, "browserControl local process stopped"); } catch { client.terminate(); }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      webSocketServer.close();
    },
  };
}
