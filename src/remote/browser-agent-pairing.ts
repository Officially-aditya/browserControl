import http from "node:http";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DeviceIdentity } from "./device-auth.js";
import type { RelayDeviceRecord, RelayState } from "./relay-state.js";
import {
  MemoryOAuthState,
  RedisOAuthState,
  type OAuthState,
} from "./oauth-state.js";
import { normalizePublicBaseUrl } from "./oauth.js";

const BROWSER_SCOPE = "browser:control";
const PAIRING_TTL_MS = 2 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const GRANT_TTL_MS = 365 * 24 * 60 * 60_000;
const MAX_BODY_BYTES = 32 * 1024;
const APPROVAL_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const APPROVAL_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
const PAIRING_ID_PATTERN = /^bp_[A-Za-z0-9_-]{20,128}$/;
const GRANT_ID_PATTERN = /^bgrant_[A-Za-z0-9_-]{20,128}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

type BrowserPairingRecord = {
  pairingId: string;
  approvalCode: string;
  agentId: string;
  agentName: string;
  requester: "Cuppet";
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  deviceId?: string;
  deviceVersion?: number;
};

type BrowserPairCodeRecord = {
  pairingId: string;
  expiresAt: number;
};

type BrowserGrantRecord = {
  grantId: string;
  agentId: string;
  agentName: string;
  requester: "Cuppet";
  deviceId: string;
  deviceVersion: number;
  scope: string;
  resource: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
};

type BrowserTokenRecord = {
  grantId: string;
  agentId: string;
  deviceId: string;
  deviceVersion: number;
  scope: string;
  resource: string;
  expiresAt: number;
};

type BrowserGrantIndexRecord = { grantIds: string[] };

export interface BrowserAgentPrincipal extends DeviceIdentity {
  agentId: string;
  grantId: string;
}

export interface BrowserAgentPairingServiceOptions {
  baseUrl: string;
  serviceToken: string;
  relayState: RelayState;
  state?: OAuthState;
  redisUrl?: string;
  redisPrefix?: string;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function randomApprovalCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += APPROVAL_ALPHABET[randomInt(APPROVAL_ALPHABET.length)];
  return code;
}

function normalizeApprovalCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

function deviceVersion(device: RelayDeviceRecord): number {
  return device.mcpRotatedAt ?? device.createdAt;
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue, "utf8");
  const right = Buffer.from(rightValue, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request: http.IncomingMessage): string {
  const raw = request.headers.authorization || "";
  return raw.match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

function writeJson(response: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume();
    throw Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" });
    chunks.push(chunk);
  }
  try {
    const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Body must be an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid JSON payload"), { code: "INVALID_JSON" });
  }
}

function validVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function verifyChallenge(verifier: string, challenge: string): boolean {
  if (!validVerifier(verifier) || !PKCE_VALUE_PATTERN.test(challenge)) return false;
  return safeEqual(createHash("sha256").update(verifier).digest("base64url"), challenge);
}

export class BrowserAgentPairingService {
  public readonly resourceUrl: string;
  private readonly relayState: RelayState;
  private readonly serviceToken: string;
  private readonly state: OAuthState;
  private readonly ownsState: boolean;

  constructor(options: BrowserAgentPairingServiceOptions) {
    const origin = normalizePublicBaseUrl(options.baseUrl);
    if (!options.serviceToken || options.serviceToken.length < 32) {
      throw new Error("Browser Agent service token must be at least 32 characters");
    }
    this.resourceUrl = `${origin}/mcp`;
    this.serviceToken = options.serviceToken;
    this.relayState = options.relayState;
    this.ownsState = !options.state;
    this.state = options.state ?? (
      options.redisUrl
        ? RedisOAuthState.fromUrl(options.redisUrl, { prefix: options.redisPrefix })
        : new MemoryOAuthState()
    );
  }

  public async close(): Promise<void> {
    if (this.ownsState) await this.state.close();
  }

  public async authenticateAccessToken(token: string): Promise<BrowserAgentPrincipal | null> {
    if (!token) return null;
    const record = await this.state.get<BrowserTokenRecord>("browser_access", token);
    if (!record || record.expiresAt <= Date.now() || record.resource !== this.resourceUrl) return null;
    const grant = await this.state.get<BrowserGrantRecord>("browser_grant", record.grantId);
    const device = await this.relayState.getDevice(record.deviceId);
    if (!grant || !device || device.revokedAt || !this.grantMatches(grant, device, record.agentId)) {
      await this.state.delete("browser_access", token).catch(() => undefined);
      return null;
    }
    return {
      deviceId: device.deviceId,
      name: device.name,
      agentId: record.agentId,
      grantId: record.grantId,
    };
  }

  public async handleHttp(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (path === "/browser-agents/pair/start" && request.method === "POST") {
      await this.handleStart(request, response);
      return true;
    }
    if (path === "/browser-agents/pair/status" && request.method === "GET") {
      await this.handleStatus(request, response, url.searchParams);
      return true;
    }
    if (path === "/browser-agents/pair/claim" && request.method === "POST") {
      await this.handleClaim(request, response);
      return true;
    }
    if (path === "/browser-agents/token" && request.method === "POST") {
      await this.handleRefresh(request, response);
      return true;
    }
    if (path === "/browser-agents/grants/revoke" && request.method === "POST") {
      await this.handleServiceRevoke(request, response);
      return true;
    }
    if (path === "/browser-agents/pair/lookup" && request.method === "POST") {
      await this.handleDeviceLookup(request, response);
      return true;
    }
    if (path === "/browser-agents/pair/decision" && request.method === "POST") {
      await this.handleDeviceDecision(request, response);
      return true;
    }
    if (path === "/browser-agents/device-grants" && request.method === "GET") {
      await this.handleDeviceGrants(request, response);
      return true;
    }
    if (path === "/browser-agents/device-grants/revoke" && request.method === "POST") {
      await this.handleDeviceRevoke(request, response);
      return true;
    }
    return false;
  }

  private serviceAuthorized(request: http.IncomingMessage): boolean {
    const token = bearerToken(request);
    return !!token && safeEqual(token, this.serviceToken);
  }

  private async deviceIdentity(request: http.IncomingMessage): Promise<DeviceIdentity | null> {
    return this.relayState.authenticateDevice(bearerToken(request));
  }

  private async handleStart(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.serviceAuthorized(request)) {
      writeJson(response, 401, { error: "Unauthorized Browser Agent service" });
      request.resume();
      return;
    }
    const limit = await this.relayState.consumeRateLimit("browser-agent-start", "cuppet", 120, 60_000);
    if (!limit.allowed) {
      writeJson(response, 429, { error: "Too many Browser Agent pairing requests" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      request.resume();
      return;
    }
    const body = await readJson(request);
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const agentName = typeof body.agentName === "string" ? body.agentName.trim().slice(0, 120) : "";
    const codeChallenge = typeof body.codeChallenge === "string" ? body.codeChallenge.trim() : "";
    if (!AGENT_ID_PATTERN.test(agentId) || !agentName || !PKCE_VALUE_PATTERN.test(codeChallenge) || body.codeChallengeMethod !== "S256") {
      writeJson(response, 400, { error: "Invalid Browser Agent pairing request" });
      return;
    }

    const pairingId = `bp_${randomToken(24)}`;
    const createdAt = Date.now();
    const expiresAt = createdAt + PAIRING_TTL_MS;
    let approvalCode = "";
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidate = randomApprovalCode();
      const reserved = await this.state.putIfAbsent<BrowserPairCodeRecord>(
        "browser_pair_code",
        candidate,
        { pairingId, expiresAt },
        PAIRING_TTL_MS
      );
      if (reserved) {
        approvalCode = candidate;
        break;
      }
    }
    if (!approvalCode) throw new Error("Could not allocate a Browser Agent pairing code");

    const pair: BrowserPairingRecord = {
      pairingId,
      approvalCode,
      agentId,
      agentName,
      requester: "Cuppet",
      codeChallenge,
      createdAt,
      expiresAt,
      status: "pending",
    };
    try {
      await this.state.put("browser_pair", pairingId, pair, PAIRING_TTL_MS);
    } catch (error) {
      await this.state.delete("browser_pair_code", approvalCode).catch(() => undefined);
      throw error;
    }
    writeJson(response, 201, { pairingId, code: approvalCode, expiresAt, status: "pending" });
  }

  private async handleStatus(request: http.IncomingMessage, response: http.ServerResponse, params: URLSearchParams): Promise<void> {
    if (!this.serviceAuthorized(request)) {
      writeJson(response, 401, { error: "Unauthorized Browser Agent service" });
      return;
    }
    const pairingId = params.get("id") || "";
    if (!PAIRING_ID_PATTERN.test(pairingId)) {
      writeJson(response, 400, { error: "Invalid pairing ID" });
      return;
    }
    const pair = await this.state.get<BrowserPairingRecord>("browser_pair", pairingId);
    if (!pair || pair.expiresAt <= Date.now()) {
      writeJson(response, 410, { status: "expired" });
      return;
    }
    const device = pair.deviceId ? await this.relayState.getDevice(pair.deviceId) : null;
    writeJson(response, 200, {
      pairingId,
      status: pair.status,
      expiresAt: pair.expiresAt,
      ...(pair.status === "approved" && device ? { deviceId: device.deviceId, deviceName: device.name } : {}),
    });
  }

  private async handleDeviceLookup(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.deviceIdentity(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized browser device" });
      request.resume();
      return;
    }
    const limit = await this.relayState.consumeRateLimit("browser-agent-lookup", identity.deviceId, 12, 60_000);
    if (!limit.allowed) {
      writeJson(response, 429, { error: "Too many pairing-code attempts" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      request.resume();
      return;
    }
    const body = await readJson(request);
    const code = normalizeApprovalCode(typeof body.code === "string" ? body.code : "");
    if (!APPROVAL_CODE_PATTERN.test(code)) {
      writeJson(response, 400, { error: "Pairing code must be 8 characters" });
      return;
    }
    const codeRecord = await this.state.get<BrowserPairCodeRecord>("browser_pair_code", code);
    const pair = codeRecord ? await this.state.get<BrowserPairingRecord>("browser_pair", codeRecord.pairingId) : null;
    if (!codeRecord || !pair || pair.expiresAt <= Date.now() || pair.status !== "pending") {
      writeJson(response, 404, { error: "Pairing code is invalid, expired, or already used" });
      return;
    }
    writeJson(response, 200, {
      pairingId: pair.pairingId,
      requester: pair.requester,
      agentName: pair.agentName,
      scope: BROWSER_SCOPE,
      expiresAt: pair.expiresAt,
    });
  }

  private async handleDeviceDecision(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.deviceIdentity(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized browser device" });
      request.resume();
      return;
    }
    const limit = await this.relayState.consumeRateLimit("browser-agent-decision", identity.deviceId, 12, 60_000);
    if (!limit.allowed) {
      writeJson(response, 429, { error: "Too many pairing decisions" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      request.resume();
      return;
    }
    const body = await readJson(request);
    const code = normalizeApprovalCode(typeof body.code === "string" ? body.code : "");
    const pairingId = typeof body.pairingId === "string" ? body.pairingId : "";
    const decision = body.decision === "approve" ? "approve" : body.decision === "deny" ? "deny" : "";
    if (!APPROVAL_CODE_PATTERN.test(code) || !PAIRING_ID_PATTERN.test(pairingId) || !decision) {
      writeJson(response, 400, { error: "Invalid Browser Agent pairing decision" });
      return;
    }

    // Validate the supplied pairingId before consuming the human code. A typo or
    // malicious mismatched request cannot burn another user's valid pairing code.
    const codeRecord = await this.state.get<BrowserPairCodeRecord>("browser_pair_code", code);
    if (!codeRecord || codeRecord.pairingId !== pairingId || codeRecord.expiresAt <= Date.now()) {
      writeJson(response, 409, { error: "Pairing code does not match this request" });
      return;
    }
    const pair = await this.state.get<BrowserPairingRecord>("browser_pair", pairingId);
    const device = await this.relayState.getDevice(identity.deviceId);
    if (!pair || pair.status !== "pending" || pair.expiresAt <= Date.now() || !device || device.revokedAt) {
      writeJson(response, 409, { error: "Pairing request is no longer available" });
      return;
    }
    const consumed = await this.state.take<BrowserPairCodeRecord>("browser_pair_code", code);
    if (!consumed || consumed.pairingId !== pairingId) {
      writeJson(response, 409, { error: "Pairing code was already claimed" });
      return;
    }
    const remaining = Math.max(1, pair.expiresAt - Date.now());
    const updated: BrowserPairingRecord = decision === "approve"
      ? { ...pair, status: "approved", deviceId: device.deviceId, deviceVersion: deviceVersion(device) }
      : { ...pair, status: "denied" };
    await this.state.put("browser_pair", pairingId, updated, remaining);
    writeJson(response, 200, { success: true, decision, pairingId, ...(decision === "approve" ? { deviceId: device.deviceId } : {}) });
  }

  private async handleClaim(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.serviceAuthorized(request)) {
      writeJson(response, 401, { error: "Unauthorized Browser Agent service" });
      request.resume();
      return;
    }
    const body = await readJson(request);
    const pairingId = typeof body.pairingId === "string" ? body.pairingId : "";
    const verifier = typeof body.verifier === "string" ? body.verifier : "";
    if (!PAIRING_ID_PATTERN.test(pairingId) || !validVerifier(verifier)) {
      writeJson(response, 400, { error: "Invalid Browser Agent claim" });
      return;
    }
    const current = await this.state.get<BrowserPairingRecord>("browser_pair", pairingId);
    if (!current || current.expiresAt <= Date.now()) {
      writeJson(response, 410, { error: "Pairing expired or was already claimed" });
      return;
    }
    if (current.status === "denied") {
      writeJson(response, 403, { error: "Browser Agent pairing was denied" });
      return;
    }
    if (current.status !== "approved" || !current.deviceId || current.deviceVersion == null) {
      writeJson(response, 409, { error: "Browser Agent pairing has not been approved yet" });
      return;
    }
    if (!verifyChallenge(verifier, current.codeChallenge)) {
      writeJson(response, 401, { error: "Browser Agent pairing proof did not match" });
      return;
    }

    const pair = await this.state.take<BrowserPairingRecord>("browser_pair", pairingId);
    if (!pair || pair.status !== "approved" || !pair.deviceId || pair.deviceVersion == null) {
      writeJson(response, 409, { error: "Browser Agent pairing was already claimed" });
      return;
    }
    const device = await this.relayState.getDevice(pair.deviceId);
    if (!device || device.revokedAt || deviceVersion(device) !== pair.deviceVersion) {
      writeJson(response, 409, { error: "Approved browser device is no longer valid" });
      return;
    }

    const grant = await this.createGrant(pair, device);
    await this.issueTokens(response, grant, device);
  }

  private async handleRefresh(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.serviceAuthorized(request)) {
      writeJson(response, 401, { error: "Unauthorized Browser Agent service" });
      request.resume();
      return;
    }
    const body = await readJson(request);
    const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
    if (refreshToken.length < 32) {
      writeJson(response, 400, { error: "refreshToken is required" });
      return;
    }
    const record = await this.state.take<BrowserTokenRecord>("browser_refresh", refreshToken);
    if (!record || record.expiresAt <= Date.now()) {
      writeJson(response, 400, { error: "Browser Agent refresh token is invalid or expired" });
      return;
    }
    const grant = await this.state.get<BrowserGrantRecord>("browser_grant", record.grantId);
    const device = await this.relayState.getDevice(record.deviceId);
    if (!grant || !device || device.revokedAt || !this.grantMatches(grant, device, record.agentId)) {
      writeJson(response, 400, { error: "Browser Agent authorization was revoked or expired" });
      return;
    }
    await this.issueTokens(response, grant, device);
  }

  private async createGrant(pair: BrowserPairingRecord, device: RelayDeviceRecord): Promise<BrowserGrantRecord> {
    const index = await this.state.get<BrowserGrantIndexRecord>("browser_grant_index", device.deviceId) ?? { grantIds: [] };
    for (const grantId of index.grantIds) {
      const existing = await this.state.get<BrowserGrantRecord>("browser_grant", grantId);
      if (existing?.agentId === pair.agentId) await this.state.delete("browser_grant", grantId);
    }
    const now = Date.now();
    const grant: BrowserGrantRecord = {
      grantId: `bgrant_${randomToken(24)}`,
      agentId: pair.agentId,
      agentName: pair.agentName,
      requester: "Cuppet",
      deviceId: device.deviceId,
      deviceVersion: deviceVersion(device),
      scope: BROWSER_SCOPE,
      resource: this.resourceUrl,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + GRANT_TTL_MS,
    };
    await Promise.all([
      this.state.put("browser_grant", grant.grantId, grant, GRANT_TTL_MS),
      this.state.put("browser_grant_index", device.deviceId, { grantIds: [grant.grantId] }, GRANT_TTL_MS),
    ]);
    return grant;
  }

  private grantMatches(grant: BrowserGrantRecord, device: RelayDeviceRecord, agentId: string): boolean {
    return grant.expiresAt > Date.now()
      && grant.agentId === agentId
      && grant.deviceId === device.deviceId
      && grant.deviceVersion === deviceVersion(device)
      && grant.scope === BROWSER_SCOPE
      && grant.resource === this.resourceUrl;
  }

  private async issueTokens(response: http.ServerResponse, grant: BrowserGrantRecord, device: RelayDeviceRecord): Promise<void> {
    const now = Date.now();
    const updated = { ...grant, lastUsedAt: now, expiresAt: now + GRANT_TTL_MS };
    await this.state.put("browser_grant", updated.grantId, updated, GRANT_TTL_MS);
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const base = {
      grantId: updated.grantId,
      agentId: updated.agentId,
      deviceId: device.deviceId,
      deviceVersion: deviceVersion(device),
      scope: BROWSER_SCOPE,
      resource: this.resourceUrl,
    };
    await Promise.all([
      this.state.put<BrowserTokenRecord>("browser_access", accessToken, { ...base, expiresAt: now + ACCESS_TOKEN_TTL_MS }, ACCESS_TOKEN_TTL_MS),
      this.state.put<BrowserTokenRecord>("browser_refresh", refreshToken, { ...base, expiresAt: now + REFRESH_TOKEN_TTL_MS }, REFRESH_TOKEN_TTL_MS),
    ]);
    writeJson(response, 200, {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: BROWSER_SCOPE,
      grantId: updated.grantId,
      agentId: updated.agentId,
      deviceId: device.deviceId,
      deviceName: device.name,
      endpoint: this.resourceUrl,
    });
  }

  private async handleDeviceGrants(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.deviceIdentity(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized browser device" });
      return;
    }
    const device = await this.relayState.getDevice(identity.deviceId);
    if (!device || device.revokedAt) {
      writeJson(response, 403, { error: "Browser device is revoked" });
      return;
    }
    const index = await this.state.get<BrowserGrantIndexRecord>("browser_grant_index", device.deviceId) ?? { grantIds: [] };
    const grants: BrowserGrantRecord[] = [];
    for (const id of index.grantIds) {
      const grant = await this.state.get<BrowserGrantRecord>("browser_grant", id);
      if (grant && this.grantMatches(grant, device, grant.agentId)) grants.push(grant);
    }
    grants.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    writeJson(response, 200, {
      grants: grants.map((grant) => ({
        grantId: grant.grantId,
        requester: grant.requester,
        agentId: grant.agentId,
        agentName: grant.agentName,
        scope: grant.scope,
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        expiresAt: grant.expiresAt,
      })),
    });
  }

  private async handleDeviceRevoke(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.deviceIdentity(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized browser device" });
      request.resume();
      return;
    }
    const body = await readJson(request);
    const grantId = typeof body.grantId === "string" ? body.grantId : "";
    if (!GRANT_ID_PATTERN.test(grantId)) {
      writeJson(response, 400, { error: "Invalid Browser Agent grant ID" });
      return;
    }
    const grant = await this.state.get<BrowserGrantRecord>("browser_grant", grantId);
    if (!grant || grant.deviceId !== identity.deviceId) {
      writeJson(response, 404, { error: "Browser Agent grant not found for this device" });
      return;
    }
    await this.state.delete("browser_grant", grantId);
    writeJson(response, 200, { success: true, grantId });
  }

  private async handleServiceRevoke(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.serviceAuthorized(request)) {
      writeJson(response, 401, { error: "Unauthorized Browser Agent service" });
      request.resume();
      return;
    }
    const body = await readJson(request);
    const grantId = typeof body.grantId === "string" ? body.grantId : "";
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    if (!GRANT_ID_PATTERN.test(grantId) || !AGENT_ID_PATTERN.test(agentId)) {
      writeJson(response, 400, { error: "Invalid Browser Agent revocation" });
      return;
    }
    const grant = await this.state.get<BrowserGrantRecord>("browser_grant", grantId);
    if (!grant || grant.agentId !== agentId) {
      writeJson(response, 404, { error: "Browser Agent grant not found" });
      return;
    }
    await this.state.delete("browser_grant", grantId);
    writeJson(response, 200, { success: true, grantId, agentId });
  }
}
