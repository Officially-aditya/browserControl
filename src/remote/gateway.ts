import http from "node:http";
import os from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { DeviceRegistry, PairingManager, type DeviceIdentity } from "./device-auth.js";
import { DeviceRouter } from "./device-router.js";
import { createDeviceMcpServer } from "./browser-tools.js";
import { loadDeviceRegistry, persistDeviceRegistry, type DeviceRegistryPersistence } from "./device-store.js";
import {
  MemoryRelayState,
  RedisRelayState,
  type RelayPresence,
  type RelayState,
} from "./relay-state.js";

const LOCAL_DEVICE_ID = "local-development";
const ROUTED_DEVICE_HEADER = "x-browsercontrol-routed-device";
const CLIENT_ID_HEADER = "x-browsercontrol-client-id";
const MOVED_HEADER = "x-browsercontrol-device-moved";

function safeTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function bearerToken(request: http.IncomingMessage): string {
  const value = request.headers.authorization || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  // NOTE: "::" is the IPv6 unspecified address (equiv. 0.0.0.0), NOT loopback.
  // Only ::1 (plus IPv4 loopback) grants local-development trust.
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function requestAddress(request: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    // Only accept plausible IP/host values to avoid log injection and
    // trivial rate-limit key manipulation. Operators must only enable
    // trustProxy behind a proxy that overwrites XFF.
    if (first && /^[A-Za-z0-9.:_%-]{1,128}$/.test(first)) return first.slice(0, 128);
  }
  return request.socket.remoteAddress || "unknown";
}

function writeJson(response: http.ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function safeDecodeDeviceId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded || decoded.length > 256) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function readRawBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" });
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        settled = true;
        request.resume();
        reject(Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" }));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function readJsonBody(request: http.IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const body = await readRawBody(request, maxBytes);
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : "Invalid JSON body"), { code: "INVALID_JSON" });
  }
}

function requestClientId(request: http.IncomingMessage, principalToken: string): string {
  const explicit = request.headers[CLIENT_ID_HEADER];
  const explicitValue = Array.isArray(explicit) ? explicit[0] : explicit;
  if (explicitValue?.trim()) return `client:${explicitValue.trim().slice(0, 160)}`;

  const legacy = request.headers["mcp-session-id"];
  const legacyValue = Array.isArray(legacy) ? legacy[0] : legacy;
  if (legacyValue?.trim()) return `legacy-session:${legacyValue.trim().slice(0, 160)}`;

  const digest = createHash("sha256").update(principalToken || "anonymous").digest("hex").slice(0, 32);
  return `principal:${digest}`;
}

function copyMcpHeaders(request: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (["authorization", "host", "connection", "content-length", "transfer-encoding"].includes(lower)) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function writeWebResponse(response: Response, nodeResponse: http.ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  nodeResponse.writeHead(response.status, headers);
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  Readable.fromWeb(response.body as any).pipe(nodeResponse);
}

function isBodyMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function normalizeInternalUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("BROWSERCONTROL_RELAY_INTERNAL_URL must use http:// or https://");
  if (url.username || url.password) throw new Error("BROWSERCONTROL_RELAY_INTERNAL_URL must not contain credentials");
  if (!url.hostname) throw new Error("BROWSERCONTROL_RELAY_INTERNAL_URL must include a hostname");
  // Defense-in-depth: never allow cluster credentials to be sent to cloud metadata.
  if (url.hostname === "169.254.169.254" || url.hostname === "[169.254.169.254]") {
    throw new Error("BROWSERCONTROL_RELAY_INTERNAL_URL must not point at instance metadata");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isAllowedForwardTarget(internalUrl: string): boolean {
  try {
    const url = new URL(internalUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.hostname === "169.254.169.254") return false;
    return true;
  } catch {
    return false;
  }
}

interface RoutedMcpPrincipal extends DeviceIdentity {
  token: string;
  localDevelopment?: boolean;
}

type LocalConnection = {
  connectionId: string;
  socket: WebSocket;
};

export interface RemoteGatewayOptions {
  port?: number;
  host?: string;
  extensionToken?: string;
  /** Loopback development only. Public relays use per-device MCP tokens issued by pairing. */
  mcpBearerToken?: string;
  adminBearerToken?: string;
  deviceRegistry?: DeviceRegistry;
  pairingManager?: PairingManager;
  deviceStorePath?: string;
  relayState?: RelayState;
  redisUrl?: string;
  redisPrefix?: string;
  replicaId?: string;
  relayInternalUrl?: string;
  clusterToken?: string;
  presenceTtlMs?: number;
  leaseTtlMs?: number;
  maxMcpBodySize?: number;
  trustProxy?: boolean;
  pairingAttemptsPerMinute?: number;
  /** Internal runtimes can bind loopback without inheriting localhost trust semantics. */
  allowLoopbackDevelopment?: boolean;
}

export interface RemoteGatewayHandle {
  httpServer: http.Server;
  wss: WebSocketServer;
  deviceRegistry: DeviceRegistry;
  deviceRouter: DeviceRouter;
  pairingManager: PairingManager;
  relayState: RelayState;
  replicaId: string;
  clustered: boolean;
  /** Loopback development credential. Empty on a public relay. */
  mcpBearerToken: string;
  adminBearerToken: string;
  devicePersistence?: DeviceRegistryPersistence;
}

export async function runRemoteGateway(options: RemoteGatewayOptions = {}): Promise<RemoteGatewayHandle> {
  const port = options.port ?? Number(process.env.BROWSERCONTROL_GATEWAY_PORT || 8787);
  const host = options.host ?? process.env.BROWSERCONTROL_GATEWAY_HOST ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const localDevelopment = loopback && (options.allowLoopbackDevelopment ?? true);
  const extensionToken = options.extensionToken ?? process.env.BROWSERCONTROL_DEVICE_TOKEN ?? "";
  const configuredMcpBearerToken = options.mcpBearerToken ?? process.env.BROWSERCONTROL_MCP_TOKEN ?? "";
  const configuredAdminBearerToken = options.adminBearerToken ?? process.env.BROWSERCONTROL_ADMIN_TOKEN ?? "";
  const deviceStorePath = options.deviceStorePath ?? process.env.BROWSERCONTROL_DEVICE_STORE_PATH ?? "";
  const redisUrl = options.redisUrl ?? process.env.BROWSERCONTROL_REDIS_URL ?? "";
  const redisPrefix = options.redisPrefix ?? process.env.BROWSERCONTROL_REDIS_PREFIX ?? "browsercontrol";
  const clusterToken = options.clusterToken ?? process.env.BROWSERCONTROL_RELAY_CLUSTER_TOKEN ?? "";
  const replicaId = options.replicaId ?? process.env.BROWSERCONTROL_RELAY_REPLICA_ID ?? `${os.hostname()}-${process.pid}`;
  const configuredInternalUrl = options.relayInternalUrl ?? process.env.BROWSERCONTROL_RELAY_INTERNAL_URL ?? "";
  const trustProxy = options.trustProxy ?? process.env.BROWSERCONTROL_TRUST_PROXY === "1";
  const presenceTtlMs = Math.max(15_000, options.presenceTtlMs ?? Number(process.env.BROWSERCONTROL_PRESENCE_TTL_MS || 60_000));
  const clustered = !!redisUrl || (!!options.relayState && !!clusterToken);

  if (!configuredAdminBearerToken && !localDevelopment) {
    throw new Error("BROWSERCONTROL_ADMIN_TOKEN is required when the relay is not in loopback development mode");
  }
  if (extensionToken && !localDevelopment) {
    throw new Error("BROWSERCONTROL_DEVICE_TOKEN is only supported for loopback development; deployed relays must use revocable device pairing");
  }
  if (configuredMcpBearerToken && !localDevelopment) {
    throw new Error("BROWSERCONTROL_MCP_TOKEN is only supported for loopback development; deployed relays use device-scoped MCP credentials from pairing");
  }
  if (redisUrl && deviceStorePath) {
    throw new Error("BROWSERCONTROL_DEVICE_STORE_PATH cannot be combined with BROWSERCONTROL_REDIS_URL; Redis is the shared credential store in clustered mode");
  }
  if (clustered && !clusterToken) {
    throw new Error("BROWSERCONTROL_RELAY_CLUSTER_TOKEN is required for horizontally scaled relay routing");
  }
  if (clustered && !configuredInternalUrl && !loopback) {
    throw new Error("BROWSERCONTROL_RELAY_INTERNAL_URL is required for clustered non-loopback relays");
  }

  const mcpBearerToken = localDevelopment ? (configuredMcpBearerToken || randomBytes(32).toString("base64url")) : "";
  const adminBearerToken = configuredAdminBearerToken || randomBytes(32).toString("base64url");
  const maxMcpBodySize = options.maxMcpBodySize ?? 2 * 1024 * 1024;

  const localRegistry = options.deviceRegistry ?? (deviceStorePath ? await loadDeviceRegistry(deviceStorePath) : new DeviceRegistry());
  const localPairing = options.pairingManager ?? new PairingManager(localRegistry);
  const devicePersistence = deviceStorePath ? persistDeviceRegistry(localRegistry, deviceStorePath) : undefined;
  const ownsRelayState = !options.relayState;
  const relayState = options.relayState ?? (
    redisUrl
      ? RedisRelayState.fromUrl(redisUrl, { prefix: redisPrefix, pairingDigits: localPairing.digits })
      : new MemoryRelayState(localRegistry, localPairing)
  );
  const deviceRouter = new DeviceRouter(options.leaseTtlMs ?? 60_000);
  const localConnections = new Map<string, LocalConnection>();
  let effectiveInternalUrl = configuredInternalUrl ? normalizeInternalUrl(configuredInternalUrl) : "";

  if (localDevelopment && !configuredMcpBearerToken) {
    console.warn(`[browserControl] Generated temporary local MCP bearer token (fingerprint ${mcpBearerToken.slice(0, 8)}…). Set BROWSERCONTROL_MCP_TOKEN to persist it.`);
  }
  if (!configuredAdminBearerToken) {
    console.warn(`[browserControl] Generated temporary admin bearer token (fingerprint ${adminBearerToken.slice(0, 8)}…). Set BROWSERCONTROL_ADMIN_TOKEN to persist it.`);
  }

  const mcpHandler = createMcpHandler(({ requestInfo }) => {
    const deviceId = requestInfo?.headers.get(ROUTED_DEVICE_HEADER)?.trim();
    if (!deviceId) throw new Error("Missing authenticated browserControl device route");
    const clientId = requestInfo?.headers.get(CLIENT_ID_HEADER)?.trim() || "relay-client";
    return createDeviceMcpServer(deviceRouter.route(deviceId), clientId);
  }, { legacy: "stateless" });

  const authorizedAdminRequest = (req: http.IncomingMessage) => safeTokenEqual(bearerToken(req), adminBearerToken);
  const authorizedClusterRequest = (req: http.IncomingMessage) => !!clusterToken && safeTokenEqual(bearerToken(req), clusterToken);

  const authenticateExtensionRequest = async (token: string): Promise<DeviceIdentity | null> => {
    const pairedDevice = await relayState.authenticateDevice(token);
    if (pairedDevice) return pairedDevice;
    if (localDevelopment && ((!extensionToken && !token) || (extensionToken && safeTokenEqual(token, extensionToken)))) {
      return { deviceId: LOCAL_DEVICE_ID, name: "Local development" };
    }
    return null;
  };

  const authenticateMcpRequest = async (req: http.IncomingMessage): Promise<RoutedMcpPrincipal | null> => {
    // Header-only auth. Query-string tokens are intentionally not accepted:
    // URLs persist in proxy/access logs, history, and connector configs.
    const token = bearerToken(req);
    if (!token) return null;
    const device = await relayState.authenticateMcp(token);
    if (device) return { ...device, token };
    if (localDevelopment && mcpBearerToken && safeTokenEqual(token, mcpBearerToken)) {
      return { deviceId: LOCAL_DEVICE_ID, name: "Local development", token, localDevelopment: true };
    }
    return null;
  };

  const invokeMcp = async (
    deviceId: string,
    clientId: string,
    method: string,
    incomingHeaders: Headers,
    body: Buffer,
    requestUrl = "http://relay.internal/mcp"
  ): Promise<Response> => {
    const headers = new Headers(incomingHeaders);
    headers.delete("authorization");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.set(ROUTED_DEVICE_HEADER, deviceId);
    headers.set(CLIENT_ID_HEADER, clientId);
    const request = new Request(requestUrl, {
      method,
      headers,
      body: isBodyMethod(method) && body.length ? body.toString("utf8") : undefined,
    });
    return mcpHandler.fetch(request);
  };

  const forwardMcp = async (
    presence: RelayPresence,
    deviceId: string,
    clientId: string,
    method: string,
    headers: Headers,
    body: Buffer
  ): Promise<Response> => {
    if (!isAllowedForwardTarget(presence.internalUrl)) {
      throw Object.assign(new Error("Refusing to forward to untrusted relay origin"), { code: "UNTRUSTED_RELAY_ORIGIN" });
    }
    const target = new URL("/internal/mcp", `${presence.internalUrl}/`);
    const forwarded = new Headers(headers);
    forwarded.set("Authorization", `Bearer ${clusterToken}`);
    forwarded.set(ROUTED_DEVICE_HEADER, deviceId);
    forwarded.set(CLIENT_ID_HEADER, clientId);
    forwarded.delete("host");
    forwarded.delete("content-length");
    forwarded.delete("transfer-encoding");
    return fetch(target, {
      method,
      headers: forwarded,
      body: isBodyMethod(method) && body.length ? body.toString("utf8") : undefined,
      signal: AbortSignal.timeout(35_000),
    });
  };

  const disconnectLocalDevice = async (deviceId: string, code: number, reason: string): Promise<boolean> => {
    const connection = localConnections.get(deviceId);
    if (!connection) return false;
    localConnections.delete(deviceId);
    deviceRouter.disconnect(deviceId, code, reason);
    try { await relayState.clearPresence(deviceId, connection.connectionId); } catch {}
    return true;
  };

  const disconnectDeviceWhereverItLives = async (deviceId: string, reason: string): Promise<boolean> => {
    if (await disconnectLocalDevice(deviceId, 4003, reason)) return true;
    if (!clustered) return false;
    const presence = await relayState.getPresence(deviceId);
    if (!presence) return false;
    if (presence.replicaId === replicaId) return disconnectLocalDevice(deviceId, 4003, reason);
    if (!isAllowedForwardTarget(presence.internalUrl)) return false;
    try {
      const target = new URL("/internal/device/disconnect", `${presence.internalUrl}/`);
      const response = await fetch(target, {
        method: "POST",
        headers: { Authorization: `Bearer ${clusterToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, reason }),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  const handleInternalMcp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!authorizedClusterRequest(req)) {
      writeJson(res, 401, { error: "Unauthorized" });
      req.resume();
      return;
    }
    const deviceHeader = req.headers[ROUTED_DEVICE_HEADER];
    const deviceId = (Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader)?.trim() || "";
    if (!deviceId || !deviceRouter.isConnected(deviceId)) {
      writeJson(res, 409, { error: "Device moved to another relay" }, { [MOVED_HEADER]: "1" });
      req.resume();
      return;
    }
    const body = await readRawBody(req, maxMcpBodySize);
    const clientHeader = req.headers[CLIENT_ID_HEADER];
    const clientId = (Array.isArray(clientHeader) ? clientHeader[0] : clientHeader)?.trim() || "relay-client";
    const response = await invokeMcp(deviceId, clientId, req.method || "POST", copyMcpHeaders(req), body);
    await writeWebResponse(response, res);
  };

  const handleExternalMcp = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const principal = await authenticateMcpRequest(req);
    if (!principal) {
      writeJson(res, 401, { error: "Unauthorized: use Authorization: Bearer <mcpToken>" });
      req.resume();
      return;
    }

    const limit = await relayState.consumeRateLimit(
      "mcp", `${principal.deviceId}:${requestAddress(req, trustProxy)}`, 600, 60_000
    );
    if (!limit.allowed) {
      writeJson(res, 429, { error: "Too many MCP requests" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      req.resume();
      return;
    }

    const body = await readRawBody(req, maxMcpBodySize);
    const headers = copyMcpHeaders(req);
    const clientId = requestClientId(req, principal.token);
    const method = req.method || "POST";

    if (clustered && principal.deviceId !== LOCAL_DEVICE_ID) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const presence = await relayState.getPresence(principal.deviceId);
        if (!presence || presence.replicaId === replicaId) break;
        const response = await forwardMcp(presence, principal.deviceId, clientId, method, headers, body);
        if (response.status !== 409 || response.headers.get(MOVED_HEADER) !== "1") {
          await writeWebResponse(response, res);
          return;
        }
      }
    }

    const response = await invokeMcp(principal.deviceId, clientId, method, headers, body, url.toString());
    await writeWebResponse(response, res);
  };

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      const connectedDevices = deviceRouter.connectedCount();
      writeJson(res, 200, {
        ok: true,
        replicaId,
        clustered,
        connectedDevices,
        extensionConnected: connectedDevices > 0,
      });
      return;
    }

    if (url.pathname === "/internal/mcp") {
      await handleInternalMcp(req, res);
      return;
    }

    if (url.pathname === "/internal/device/disconnect" && req.method === "POST") {
      if (!authorizedClusterRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        req.resume();
        return;
      }
      const body = await readJsonBody(req, maxMcpBodySize);
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      if (!deviceId) {
        writeJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const disconnected = await disconnectLocalDevice(
        deviceId, 4003, typeof body.reason === "string" ? body.reason : "Device credential revoked"
      );
      writeJson(res, disconnected ? 200 : 404, { success: disconnected, deviceId });
      return;
    }

    if (url.pathname === "/pairing/create" && req.method === "POST") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        req.resume();
        return;
      }
      const body = await readJsonBody(req, maxMcpBodySize);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) || undefined : undefined;
      writeJson(res, 201, await relayState.createPairing(name));
      return;
    }

    if (url.pathname === "/pairing/claim" && req.method === "POST") {
      const address = requestAddress(req, trustProxy);
      const [perIp, global] = await Promise.all([
        relayState.consumeRateLimit("pairing-ip", address, options.pairingAttemptsPerMinute ?? 12, 60_000),
        relayState.consumeRateLimit("pairing-global", "global", 120, 60_000),
      ]);
      if (!perIp.allowed || !global.allowed) {
        const retryAfterMs = Math.max(perIp.retryAfterMs, global.retryAfterMs);
        writeJson(res, 429, { error: "Too many pairing attempts" }, { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) });
        req.resume();
        return;
      }

      const body = await readJsonBody(req, maxMcpBodySize);
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const codePattern = new RegExp(`^\\d{${relayState.pairingDigits}}$`);
      if (!codePattern.test(code)) {
        writeJson(res, 400, { error: `Pairing code must be ${relayState.pairingDigits} digits` });
        return;
      }
      const credential = await relayState.claimPairing(code);
      if (!credential) {
        writeJson(res, 404, { error: "Pairing code is invalid or expired" });
        return;
      }
      writeJson(res, 200, credential);
      return;
    }

    if (url.pathname === "/devices" && req.method === "GET") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const devices = await relayState.listDevices();
      const enriched = await Promise.all(devices.map(async (device) => {
        const presence = device.revokedAt ? null : await relayState.getPresence(device.deviceId);
        return {
          ...device,
          connected: !!presence,
          relayReplicaId: presence?.replicaId,
        };
      }));
      writeJson(res, 200, { devices: enriched });
      return;
    }

    const rotateMatch = url.pathname.match(/^\/devices\/([^/]+)\/connector\/rotate$/);
    if (rotateMatch && req.method === "POST") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        req.resume();
        return;
      }
      const deviceId = safeDecodeDeviceId(rotateMatch[1]);
      if (!deviceId) {
        writeJson(res, 400, { error: "Invalid device ID" });
        return;
      }
      const rotated = await relayState.rotateMcpToken(deviceId);
      if (!rotated) {
        writeJson(res, 404, { error: "Device not found" });
        return;
      }
      writeJson(res, 200, rotated);
      return;
    }

    if (url.pathname.startsWith("/devices/") && req.method === "DELETE") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const deviceId = safeDecodeDeviceId(url.pathname.slice("/devices/".length));
      if (!deviceId || !await relayState.revoke(deviceId)) {
        writeJson(res, 404, { error: "Device not found" });
        return;
      }
      const disconnected = await disconnectDeviceWhereverItLives(deviceId, "Device credential revoked");
      writeJson(res, 200, { success: true, deviceId, disconnected });
      return;
    }

    if (url.pathname === "/mcp") {
      await handleExternalMcp(req, res, url);
      return;
    }

    writeJson(res, 404, { error: "Not found" });
  };

  const httpServer = http.createServer((req, res) => {
    void handleHttp(req, res).catch((error: any) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const status = error?.code === "PAYLOAD_TOO_LARGE" ? 413 : error?.code === "INVALID_JSON" ? 400 : 500;
      if (status === 500) {
        console.error("[browserControl] Relay request failed:", error);
        writeJson(res, 500, { error: "Internal error" });
      } else {
        writeJson(res, status, { error: error?.message || "Relay request failed" });
      }
    });
  });

  const extensionTokenFromUpgrade = (request: http.IncomingMessage, url: URL): { token: string; via: string } => {
    // Preferred: Sec-WebSocket-Protocol carries the bearer without touching URLs
    // (browser WebSocket cannot set Authorization headers). The extension sends
    // `new WebSocket(endpoint, ["browsercontrol.<token>"])` when available.
    const protocols = request.headers["sec-websocket-protocol"];
    const offered = (Array.isArray(protocols) ? protocols.join(",") : protocols || "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const proto of offered) {
      const candidate = proto.startsWith("browsercontrol.") ? proto.slice("browsercontrol.".length) : proto;
      if (candidate && candidate.length >= 16) return { token: candidate, via: "subprotocol" };
    }
    // Legacy fallback: ?token= query param. Supported for backwards compat but
    // deprecated — URLs leak into logs. New extension versions use subprotocol.
    return { token: url.searchParams.get("token") || "", via: "query" };
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const unregisterRevocation = localRegistry.onRevoked((deviceId) => {
    void disconnectLocalDevice(deviceId, 4003, "Device credential revoked");
  });

  let presenceTimer: NodeJS.Timeout | null = null;
  let presenceRefreshRunning = false;

  httpServer.once("close", () => {
    unregisterRevocation();
    if (presenceTimer) clearInterval(presenceTimer);
    void mcpHandler.close();
    void devicePersistence?.close();
    if (ownsRelayState) void relayState.close();
  });

  httpServer.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (url.pathname !== "/extension") {
        socket.destroy();
        return;
      }
      // Per-IP upgrade bucket stops unauthenticated flood/token-oracle attempts.
      try {
        const upgradeLimit = await relayState.consumeRateLimit(
          "ws-upgrade",
          requestAddress(request, trustProxy),
          20,
          60_000
        );
        if (!upgradeLimit.allowed) {
          socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch {
        // Fail open on rate-limiter errors; auth still applies below.
      }
      const { token: extensionTokenFromRequest } = extensionTokenFromUpgrade(request, url);
      const identity = await authenticateExtensionRequest(extensionTokenFromRequest);
      if (!identity) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        void (async () => {
          const connectionId = randomUUID();
          const previous = localConnections.get(identity.deviceId);
          deviceRouter.attach(identity.deviceId, ws);
          // New physical connection invalidates any stale exclusive-control lease
          // so a legitimate re-pair cannot be starved by the displaced holder.
          deviceRouter.route(identity.deviceId).lease.clear();
          if (previous && previous.socket !== ws && previous.socket.readyState === 1) {
            try { previous.socket.close(4001, "Replaced by newer browserControl connection for this device"); } catch {}
          }
          localConnections.set(identity.deviceId, { connectionId, socket: ws });
          if (clustered && identity.deviceId !== LOCAL_DEVICE_ID) {
            const presence: RelayPresence = {
              deviceId: identity.deviceId,
              replicaId,
              internalUrl: effectiveInternalUrl,
              connectionId,
              expiresAt: Date.now() + presenceTtlMs,
            };
            try {
              await relayState.setPresence(presence, presenceTtlMs);
            } catch (error) {
              localConnections.delete(identity.deviceId);
              deviceRouter.disconnect(identity.deviceId, 1011, "Could not register relay presence");
              return;
            }
          }

          ws.once("close", () => {
            const current = localConnections.get(identity.deviceId);
            if (!current || current.connectionId !== connectionId) return;
            localConnections.delete(identity.deviceId);
            if (clustered && identity.deviceId !== LOCAL_DEVICE_ID) {
              void relayState.clearPresence(identity.deviceId, connectionId).catch(() => undefined);
            }
          });
          wss.emit("connection", ws, request);
        })();
      });
    })().catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (!effectiveInternalUrl) effectiveInternalUrl = `http://${loopback ? "127.0.0.1" : host}:${actualPort}`;

  if (clustered) {
    const refreshEvery = Math.max(5_000, Math.floor(presenceTtlMs / 3));
    presenceTimer = setInterval(() => {
      if (presenceRefreshRunning) return;
      presenceRefreshRunning = true;
      void (async () => {
        for (const [deviceId, connection] of [...localConnections]) {
          if (deviceId === LOCAL_DEVICE_ID) continue;
          try {
            const device = await relayState.getDevice(deviceId);
            if (device?.revokedAt) {
              await disconnectLocalDevice(deviceId, 4003, "Device credential revoked");
              continue;
            }
            const presence: RelayPresence = {
              deviceId,
              replicaId,
              internalUrl: effectiveInternalUrl,
              connectionId: connection.connectionId,
              expiresAt: Date.now() + presenceTtlMs,
            };
            const stillOwner = await relayState.refreshPresence(presence, presenceTtlMs);
            if (!stillOwner) await disconnectLocalDevice(deviceId, 4001, "Device moved to another relay replica");
          } catch (error) {
            console.warn(`[browserControl] Could not refresh presence for ${deviceId}:`, error);
          }
        }
      })().finally(() => { presenceRefreshRunning = false; });
    }, refreshEvery);
    presenceTimer.unref?.();
  }

  console.log(`[browserControl] Routed relay listening on http://${host}:${actualPort}`);
  console.log(`[browserControl] Relay replica: ${replicaId}${clustered ? " (clustered)" : ""}`);
  console.log(`[browserControl] MCP endpoint: http://${host}:${actualPort}/mcp`);
  console.log(`[browserControl] Extension endpoint: ws://${host}:${actualPort}/extension`);

  return {
    httpServer,
    wss,
    deviceRegistry: localRegistry,
    deviceRouter,
    pairingManager: localPairing,
    relayState,
    replicaId,
    clustered,
    mcpBearerToken,
    adminBearerToken,
    devicePersistence,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRemoteGateway({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
