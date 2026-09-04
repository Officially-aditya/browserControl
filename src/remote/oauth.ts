import http from "node:http";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { DeviceIdentity } from "./device-auth.js";
import type { RelayDeviceRecord, RelayState } from "./relay-state.js";
import {
  MemoryOAuthState,
  RedisOAuthState,
  type OAuthState,
} from "./oauth-state.js";

const BROWSER_SCOPE = "browser:control";
const CLIENT_TTL_MS = 180 * 24 * 60 * 60_000;
const AUTH_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const GRANT_TTL_MS = 365 * 24 * 60 * 60_000;
const ENROLLMENT_TTL_MS = 60_000;
const DEVICE_APPROVAL_TTL_MS = 2 * 60_000;
const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const ENROLLMENT_HEADER = "x-browsercontrol-enrollment";
const ENROLLMENT_HEADER_VALUE = "extension-v1";
const REVERSE_DOMAIN_NATIVE_SCHEME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/i;
const APPROVAL_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const APPROVAL_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

type OAuthClientRecord = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  applicationType: "web" | "native";
  createdAt: number;
};

type OAuthAuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  deviceId: string;
  deviceVersion: number;
  scope: string;
  resource: string;
  codeChallenge: string;
  grantId?: string;
  expiresAt: number;
};

type OAuthTokenRecord = {
  clientId: string;
  deviceId: string;
  deviceVersion: number;
  scope: string;
  resource: string;
  grantId?: string;
  expiresAt: number;
};

type OAuthGrantRecord = {
  grantId: string;
  clientId: string;
  clientName: string;
  deviceId: string;
  deviceVersion: number;
  scope: string;
  resource: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
};

type OAuthGrantIndexRecord = {
  grantIds: string[];
};

type PendingDeviceApprovalRecord = {
  requestId: string;
  approvalCode: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  deviceId?: string;
  deviceVersion?: number;
};

type ApprovalCodeRecord = {
  requestId: string;
  expiresAt: number;
};

type EnrollmentRecord = {
  pairingCode: string;
  nonceHash: string;
  expiresAt: number;
};

export interface OAuthPrincipal extends DeviceIdentity {
  clientId: string;
}

export interface RelayOAuthServiceOptions {
  baseUrl: string;
  relayState: RelayState;
  state?: OAuthState;
  redisUrl?: string;
  redisPrefix?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("OAuth public base URL must not include credentials");
  if (url.search || url.hash) throw new Error("OAuth public base URL must not include query parameters or a fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("OAuth public base URL must be an origin without a path");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("OAuth public base URL must use https:// (http:// is allowed only for loopback tests)");
  }
  return url.origin;
}

function deviceVersion(device: RelayDeviceRecord): number {
  return device.mcpRotatedAt ?? device.createdAt;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function randomApprovalCode(): string {
  let code = "";
  for (let index = 0; index < 8; index++) code += APPROVAL_ALPHABET[randomInt(APPROVAL_ALPHABET.length)];
  return code;
}

function normalizeApprovalCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`;
}

function authorizationFormAction(redirectUri?: string): string {
  if (!redirectUri) return "'self'";
  const url = new URL(redirectUri);
  const callbackSource = url.protocol === "http:" || url.protocol === "https:"
    ? url.origin
    : url.protocol.toLowerCase();
  return `'self' ${callbackSource}`;
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function writeHtml(
  response: http.ServerResponse,
  status: number,
  html: string,
  redirectUri?: string,
  extraHeaders: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${authorizationFormAction(redirectUri)}; base-uri 'none'; frame-ancestors 'none'`,
    ...extraHeaders,
  });
  response.end(html);
}

function redirect(response: http.ServerResponse, location: string, status = 302): void {
  response.writeHead(status, {
    Location: location,
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

async function readBody(request: http.IncomingMessage, maxBytes = MAX_OAUTH_BODY_BYTES): Promise<string> {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw Object.assign(new Error("OAuth request body too large"), { code: "PAYLOAD_TOO_LARGE" });
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
        reject(Object.assign(new Error("OAuth request body too large"), { code: "PAYLOAD_TOO_LARGE" }));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

async function readJsonObject(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { code: "INVALID_JSON" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("JSON body must be an object"), { code: "INVALID_JSON" });
  }
  return parsed as Record<string, unknown>;
}

async function readForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request));
}

function normalizeScope(raw: string | undefined | null): string {
  const values = (raw || BROWSER_SCOPE).split(/\s+/).filter(Boolean);
  if (values.length === 0) return BROWSER_SCOPE;
  if (values.some((scope) => scope !== BROWSER_SCOPE)) {
    throw Object.assign(new Error("Unsupported OAuth scope"), { oauthError: "invalid_scope" });
  }
  return BROWSER_SCOPE;
}

function parseRegisteredRedirect(raw: string): URL | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function isNativePrivateUseRedirect(raw: string): boolean {
  const url = parseRegisteredRedirect(raw);
  if (!url || url.protocol === "http:" || url.protocol === "https:") return false;
  const scheme = url.protocol.slice(0, -1);
  return REVERSE_DOMAIN_NATIVE_SCHEME.test(scheme);
}

function isAllowedRegisteredRedirect(raw: string, applicationType: "web" | "native"): boolean {
  const url = parseRegisteredRedirect(raw);
  if (!url) return false;
  if (url.toString() === CLAUDE_CALLBACK) return true;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return true;
  return applicationType === "native" && isNativePrivateUseRedirect(raw);
}

function redirectsMatch(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  try {
    const req = new URL(requested);
    const reg = new URL(registered);
    if (
      req.protocol !== "http:" ||
      reg.protocol !== "http:" ||
      !isLoopbackHostname(req.hostname) ||
      !isLoopbackHostname(reg.hostname)
    ) {
      return false;
    }
    return (
      req.hostname.toLowerCase() === reg.hostname.toLowerCase() &&
      req.pathname === reg.pathname &&
      req.search === reg.search &&
      !reg.port
    );
  } catch {
    return false;
  }
}

function validPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function validCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!validCodeVerifier(verifier) || !validPkceChallenge(challenge)) return false;
  const derived = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(derived, challenge);
}

function requestAddress(request: http.IncomingMessage): string {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const raw = request.headers["x-real-ip"];
    const value = (Array.isArray(raw) ? raw[0] : raw || "").trim();
    if (value && isIP(value)) return value;
  }
  return request.socket.remoteAddress || "unknown";
}

function bearerToken(request: http.IncomingMessage): string {
  const raw = request.headers.authorization || "";
  return raw.match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

function enrollmentRequest(request: http.IncomingMessage): boolean {
  const raw = request.headers[ENROLLMENT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === ENROLLMENT_HEADER_VALUE;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function oauthError(
  response: http.ServerResponse,
  status: number,
  error: string,
  description: string
): void {
  writeJson(response, status, { error, error_description: description }, {
    "Access-Control-Allow-Origin": "*",
  });
}

export class RelayOAuthService {
  public readonly issuer: string;
  public readonly resourceUrl: string;
  public readonly resourceMetadataUrl: string;
  public readonly authorizationEndpoint: string;
  public readonly tokenEndpoint: string;
  public readonly registrationEndpoint: string;

  private readonly relayState: RelayState;
  private readonly state: OAuthState;
  private readonly ownsState: boolean;

  constructor(options: RelayOAuthServiceOptions) {
    this.issuer = normalizePublicBaseUrl(options.baseUrl);
    this.resourceUrl = `${this.issuer}/mcp`;
    this.resourceMetadataUrl = `${this.issuer}/.well-known/oauth-protected-resource/mcp`;
    this.authorizationEndpoint = `${this.issuer}/authorize`;
    this.tokenEndpoint = `${this.issuer}/token`;
    this.registrationEndpoint = `${this.issuer}/register`;
    this.relayState = options.relayState;
    this.ownsState = !options.state;
    this.state = options.state ?? (
      options.redisUrl
        ? RedisOAuthState.fromUrl(options.redisUrl, { prefix: options.redisPrefix })
        : new MemoryOAuthState()
    );
  }

  public get challengeHeader(): string {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}", scope="${BROWSER_SCOPE}"`;
  }

  public async authenticateAccessToken(token: string): Promise<OAuthPrincipal | null> {
    if (!token) return null;
    const record = await this.state.get<OAuthTokenRecord>("access", token);
    if (!record || record.expiresAt <= Date.now() || record.resource !== this.resourceUrl) return null;
    const device = await this.relayState.getDevice(record.deviceId);
    if (!device || device.revokedAt || deviceVersion(device) !== record.deviceVersion) {
      await this.state.delete("access", token).catch(() => undefined);
      return null;
    }
    if (record.grantId) {
      const grant = await this.state.get<OAuthGrantRecord>("grant", record.grantId);
      if (!grant || !this.grantMatches(grant, record.clientId, device)) {
        await this.state.delete("access", token).catch(() => undefined);
        return null;
      }
    }
    return { deviceId: device.deviceId, name: device.name, clientId: record.clientId };
  }

  public async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): Promise<boolean> {
    const pathname = url.pathname;

    if (pathname === "/enroll/start" && request.method === "POST") {
      await this.handleEnrollmentStart(request, response);
      return true;
    }

    if (pathname === "/enroll/claim" && request.method === "POST") {
      await this.handleEnrollmentClaim(request, response);
      return true;
    }

    if (pathname === "/device-approvals/lookup" && request.method === "POST") {
      await this.handleDeviceApprovalLookup(request, response);
      return true;
    }

    if (pathname === "/device-approvals/decision" && request.method === "POST") {
      await this.handleDeviceApprovalDecision(request, response);
      return true;
    }

    if (pathname === "/device-approvals/grants" && request.method === "GET") {
      await this.handleListDeviceGrants(request, response);
      return true;
    }

    if (pathname === "/device-approvals/grants/revoke" && request.method === "POST") {
      await this.handleRevokeDeviceGrant(request, response);
      return true;
    }

    if (pathname === "/authorize/device-status" && request.method === "GET") {
      await this.handleDeviceApprovalStatus(response, url.searchParams);
      return true;
    }

    if (
      request.method === "GET" &&
      (pathname === "/.well-known/oauth-protected-resource/mcp" || pathname === "/.well-known/oauth-protected-resource")
    ) {
      writeJson(response, 200, {
        resource: this.resourceUrl,
        authorization_servers: [this.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: [BROWSER_SCOPE],
      }, { "Access-Control-Allow-Origin": "*" });
      return true;
    }

    if (
      request.method === "GET" &&
      (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/openid-configuration")
    ) {
      writeJson(response, 200, {
        issuer: this.issuer,
        authorization_endpoint: this.authorizationEndpoint,
        token_endpoint: this.tokenEndpoint,
        registration_endpoint: this.registrationEndpoint,
        scopes_supported: [BROWSER_SCOPE],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      }, { "Access-Control-Allow-Origin": "*" });
      return true;
    }

    if ((pathname === "/register" || pathname === "/oauth/register") && request.method === "POST") {
      await this.handleRegistration(request, response);
      return true;
    }

    if ((pathname === "/authorize" || pathname === "/oauth/authorize") && request.method === "GET") {
      await this.handleAuthorizeGet(request, response, url.searchParams);
      return true;
    }

    if ((pathname === "/authorize" || pathname === "/oauth/authorize") && request.method === "POST") {
      await this.handleAuthorizePost(request, response);
      return true;
    }

    if ((pathname === "/token" || pathname === "/oauth/token") && request.method === "POST") {
      await this.handleToken(request, response);
      return true;
    }

    return false;
  }

  public async close(): Promise<void> {
    if (this.ownsState) await this.state.close();
  }

  private async authenticateDeviceRequest(request: http.IncomingMessage): Promise<DeviceIdentity | null> {
    return this.relayState.authenticateDevice(bearerToken(request));
  }

  private grantMatches(grant: OAuthGrantRecord, clientId: string, device: RelayDeviceRecord): boolean {
    return (
      grant.expiresAt > Date.now() &&
      grant.clientId === clientId &&
      grant.deviceId === device.deviceId &&
      grant.deviceVersion === deviceVersion(device) &&
      grant.scope === BROWSER_SCOPE &&
      grant.resource === this.resourceUrl
    );
  }

  private async grantIndex(deviceId: string): Promise<OAuthGrantIndexRecord> {
    return await this.state.get<OAuthGrantIndexRecord>("grant_index", deviceId) ?? { grantIds: [] };
  }

  private async storeGrantIndex(deviceId: string, grantIds: string[]): Promise<void> {
    await this.state.put("grant_index", deviceId, { grantIds: [...new Set(grantIds)].slice(-100) }, GRANT_TTL_MS);
  }

  private async createGrant(
    client: OAuthClientRecord,
    device: RelayDeviceRecord,
    scope: string,
    resource: string
  ): Promise<OAuthGrantRecord> {
    const index = await this.grantIndex(device.deviceId);
    const retained: string[] = [];
    for (const grantId of index.grantIds) {
      const existing = await this.state.get<OAuthGrantRecord>("grant", grantId);
      if (!existing) continue;
      if (existing.clientId === client.clientId) {
        await this.state.delete("grant", grantId);
        continue;
      }
      retained.push(grantId);
    }

    const now = Date.now();
    const grant: OAuthGrantRecord = {
      grantId: `grant_${randomToken(24)}`,
      clientId: client.clientId,
      clientName: client.clientName,
      deviceId: device.deviceId,
      deviceVersion: deviceVersion(device),
      scope,
      resource,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + GRANT_TTL_MS,
    };
    await Promise.all([
      this.state.put("grant", grant.grantId, grant, GRANT_TTL_MS),
      this.storeGrantIndex(device.deviceId, [...retained, grant.grantId]),
    ]);
    return grant;
  }

  private async touchGrant(grant: OAuthGrantRecord): Promise<void> {
    const now = Date.now();
    const updated: OAuthGrantRecord = {
      ...grant,
      lastUsedAt: now,
      expiresAt: now + GRANT_TTL_MS,
    };
    await Promise.all([
      this.state.put("grant", updated.grantId, updated, GRANT_TTL_MS),
      this.grantIndex(updated.deviceId).then((index) => this.storeGrantIndex(updated.deviceId, [...index.grantIds, updated.grantId])),
    ]);
  }

  private async handleEnrollmentStart(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!enrollmentRequest(request)) {
      writeJson(response, 403, { error: "Enrollment is available only to the browserControl extension" });
      request.resume();
      return;
    }

    const address = requestAddress(request);
    const [perAddress, global] = await Promise.all([
      this.relayState.consumeRateLimit("enroll-start-ip", address, 6, 10 * 60_000),
      this.relayState.consumeRateLimit("enroll-start-global", "global", 240, 60_000),
    ]);
    if (!perAddress.allowed || !global.allowed) {
      const retryAfterMs = Math.max(perAddress.retryAfterMs, global.retryAfterMs);
      writeJson(response, 429, { error: "Too many enrollment attempts" }, {
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      });
      request.resume();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch (error: any) {
      writeJson(response, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: "Invalid enrollment payload" });
      return;
    }

    const nonceHash = typeof body.nonceHash === "string" ? body.nonceHash.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/.test(nonceHash)) {
      writeJson(response, 400, { error: "nonceHash must be a SHA-256 hex digest" });
      return;
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) || undefined : undefined;
    const pairing = await this.relayState.createPairing(name, ENROLLMENT_TTL_MS);
    const ticket = randomToken(32);
    const expiresAt = Date.now() + ENROLLMENT_TTL_MS;
    await this.state.put<EnrollmentRecord>("enroll", ticket, {
      pairingCode: pairing.code,
      nonceHash,
      expiresAt,
    }, ENROLLMENT_TTL_MS);
    writeJson(response, 201, { ticket, expiresAt });
  }

  private async handleEnrollmentClaim(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!enrollmentRequest(request)) {
      writeJson(response, 403, { error: "Enrollment is available only to the browserControl extension" });
      request.resume();
      return;
    }

    const address = requestAddress(request);
    const [perAddress, global] = await Promise.all([
      this.relayState.consumeRateLimit("enroll-claim-ip", address, 30, 60_000),
      this.relayState.consumeRateLimit("enroll-claim-global", "global", 600, 60_000),
    ]);
    if (!perAddress.allowed || !global.allowed) {
      const retryAfterMs = Math.max(perAddress.retryAfterMs, global.retryAfterMs);
      writeJson(response, 429, { error: "Too many enrollment claims" }, {
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      });
      request.resume();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch (error: any) {
      writeJson(response, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: "Invalid enrollment claim" });
      return;
    }

    const ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
    const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(ticket) || !/^[A-Za-z0-9_-]{43,128}$/.test(nonce)) {
      writeJson(response, 400, { error: "Invalid enrollment ticket or nonce" });
      return;
    }

    const enrollment = await this.state.take<EnrollmentRecord>("enroll", ticket);
    if (!enrollment || enrollment.expiresAt <= Date.now()) {
      writeJson(response, 404, { error: "Enrollment ticket is invalid or expired" });
      return;
    }
    if (!safeEqual(sha256Hex(nonce), enrollment.nonceHash)) {
      writeJson(response, 401, { error: "Enrollment proof did not match" });
      return;
    }

    const credential = await this.relayState.claimPairing(enrollment.pairingCode);
    if (!credential) {
      writeJson(response, 410, { error: "Enrollment expired before device credentials could be issued" });
      return;
    }
    writeJson(response, 200, credential);
  }

  private async handleRegistration(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const address = requestAddress(request);
    const [perAddress, global] = await Promise.all([
      this.relayState.consumeRateLimit("oauth-register-ip", address, 30, 10 * 60_000),
      this.relayState.consumeRateLimit("oauth-register-global", "global", 600, 60_000),
    ]);
    if (!perAddress.allowed || !global.allowed) {
      const retryAfterMs = Math.max(perAddress.retryAfterMs, global.retryAfterMs);
      oauthError(response, 429, "temporarily_unavailable", `Too many client registrations. Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`);
      request.resume();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch (error: any) {
      oauthError(response, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, "invalid_client_metadata", "Invalid client registration payload");
      return;
    }

    if (
      body.application_type != null &&
      body.application_type !== "web" &&
      body.application_type !== "native"
    ) {
      oauthError(response, 400, "invalid_client_metadata", "application_type must be web or native when provided");
      return;
    }

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    const declaredApplicationType = body.application_type === "native"
      ? "native"
      : body.application_type === "web"
        ? "web"
        : null;
    const applicationType: "web" | "native" = declaredApplicationType ?? (
      redirectUris.some(isNativePrivateUseRedirect) ? "native" : "web"
    );
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      redirectUris.some((uri) => !isAllowedRegisteredRedirect(uri, applicationType))
    ) {
      oauthError(
        response,
        400,
        "invalid_redirect_uri",
        "Register the Claude callback, an RFC 8252 loopback redirect URI, or a reverse-domain private-use URI scheme for a native client"
      );
      return;
    }

    if (body.token_endpoint_auth_method != null && body.token_endpoint_auth_method !== "none") {
      oauthError(response, 400, "invalid_client_metadata", "browserControl DCR supports public clients with token_endpoint_auth_method=none");
      return;
    }

    const grantTypes = Array.isArray(body.grant_types)
      ? body.grant_types.filter((value): value is string => typeof value === "string")
      : ["authorization_code", "refresh_token"];
    if (!grantTypes.includes("authorization_code") || grantTypes.some((value) => !["authorization_code", "refresh_token"].includes(value))) {
      oauthError(response, 400, "invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
      return;
    }

    const responseTypes = Array.isArray(body.response_types)
      ? body.response_types.filter((value): value is string => typeof value === "string")
      : ["code"];
    if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
      oauthError(response, 400, "invalid_client_metadata", "Only response_type=code is supported");
      return;
    }

    try {
      normalizeScope(typeof body.scope === "string" ? body.scope : undefined);
    } catch {
      oauthError(response, 400, "invalid_client_metadata", "Only browser:control scope is supported");
      return;
    }

    const clientName = typeof body.client_name === "string"
      ? body.client_name.trim().slice(0, 120) || "MCP client"
      : "MCP client";
    const clientId = `bc_${randomToken(24)}`;
    const createdAt = Date.now();
    const client: OAuthClientRecord = {
      clientId,
      clientName,
      redirectUris: [...new Set(redirectUris)],
      applicationType,
      createdAt,
    };
    await this.state.put("client", clientId, client, CLIENT_TTL_MS);

    writeJson(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1000),
      client_name: clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: applicationType,
      scope: BROWSER_SCOPE,
    }, { "Access-Control-Allow-Origin": "*" });
  }

  private async validateAuthorization(params: URLSearchParams): Promise<{
    client: OAuthClientRecord;
    clientId: string;
    redirectUri: string;
    state: string;
    scope: string;
    resource: string;
    codeChallenge: string;
  } | null> {
    if (params.get("response_type") !== "code") return null;
    const clientId = params.get("client_id") || "";
    const client = await this.state.get<OAuthClientRecord>("client", clientId);
    if (!client) return null;

    const redirectUri = params.get("redirect_uri") || "";
    if (!redirectUri || !client.redirectUris.some((registered) => redirectsMatch(redirectUri, registered))) return null;

    const codeChallenge = params.get("code_challenge") || "";
    if (params.get("code_challenge_method") !== "S256" || !validPkceChallenge(codeChallenge)) return null;

    let scope: string;
    try {
      scope = normalizeScope(params.get("scope"));
    } catch {
      return null;
    }

    const resource = params.get("resource") || this.resourceUrl;
    if (resource !== this.resourceUrl) return null;

    const state = (params.get("state") || "").slice(0, 2048);
    return { client, clientId, redirectUri, state, scope, resource, codeChallenge };
  }

  private async handleAuthorizeGet(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    params: URLSearchParams
  ): Promise<void> {
    const validated = await this.validateAuthorization(params);
    if (!validated) {
      writeHtml(response, 400, this.authorizationPage(null, "Invalid or unsupported OAuth authorization request."));
      return;
    }

    if (isNativePrivateUseRedirect(validated.redirectUri)) {
      const address = requestAddress(request);
      const [perAddress, global] = await Promise.all([
        this.relayState.consumeRateLimit("oauth-device-approval-start-ip", address, 20, 10 * 60_000),
        this.relayState.consumeRateLimit("oauth-device-approval-start-global", "global", 600, 60_000),
      ]);
      if (!perAddress.allowed || !global.allowed) {
        writeHtml(response, 429, this.authorizationPage(validated, "Too many device authorization attempts. Try again shortly."), validated.redirectUri);
        return;
      }
      const pending = await this.createPendingDeviceApproval(validated);
      writeHtml(response, 200, this.deviceApprovalPage(pending), validated.redirectUri, {
        Refresh: `2; url=/authorize/device-status?request_id=${encodeURIComponent(pending.requestId)}`,
      });
      return;
    }

    writeHtml(response, 200, this.authorizationPage(validated), validated.redirectUri);
  }

  private async createPendingDeviceApproval(
    validated: NonNullable<Awaited<ReturnType<RelayOAuthService["validateAuthorization"]>>>
  ): Promise<PendingDeviceApprovalRecord> {
    const requestId = randomToken(24);
    let approvalCode = "";
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = randomApprovalCode();
      if (!await this.state.get<ApprovalCodeRecord>("approval_code", candidate)) {
        approvalCode = candidate;
        break;
      }
    }
    if (!approvalCode) throw new Error("Could not allocate a device approval code");

    const createdAt = Date.now();
    const expiresAt = createdAt + DEVICE_APPROVAL_TTL_MS;
    const pending: PendingDeviceApprovalRecord = {
      requestId,
      approvalCode,
      clientId: validated.clientId,
      clientName: validated.client.clientName,
      redirectUri: validated.redirectUri,
      state: validated.state,
      scope: validated.scope,
      resource: validated.resource,
      codeChallenge: validated.codeChallenge,
      createdAt,
      expiresAt,
      status: "pending",
    };
    await Promise.all([
      this.state.put("approval", requestId, pending, DEVICE_APPROVAL_TTL_MS),
      this.state.put<ApprovalCodeRecord>("approval_code", approvalCode, { requestId, expiresAt }, DEVICE_APPROVAL_TTL_MS),
    ]);
    return pending;
  }

  private deviceApprovalPage(pending: PendingDeviceApprovalRecord, message = ""): string {
    const callback = new URL(pending.redirectUri);
    const callbackLabel = callback.protocol;
    const code = htmlEscape(pending.approvalCode);
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="2;url=/authorize/device-status?request_id=${encodeURIComponent(pending.requestId)}">
<title>Connect browserControl</title>
<style>body{font:15px system-ui,sans-serif;max-width:520px;margin:56px auto;padding:0 20px;color:#1f1f1f}h1{font-size:24px}.card{border:1px solid #ddd;border-radius:12px;padding:18px}.muted{color:#666;font-size:13px;line-height:1.5}.code{font:700 28px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;padding:12px 14px;background:#f3f3f3;border-radius:10px;text-align:center;margin:16px 0}.warning{color:#9a3412;background:#fff7ed;padding:10px;border-radius:8px}.ok{color:#137333;background:#e7f4ea;padding:10px;border-radius:8px}a{color:#111}</style>
</head><body><h1>Connect browserControl</h1>
<div class="card">
<p><strong>${htmlEscape(pending.clientName)}</strong> is requesting access to one of your browserControl Chrome devices.</p>
<p class="muted">Native callback: <code>${htmlEscape(callbackLabel)}</code><br>Requested access: view and control browser tabs through <code>${BROWSER_SCOPE}</code>.</p>
<div id="approval-code" class="code">${code}</div>
<p><strong>On the Mac whose Chrome you want to connect:</strong></p>
<ol class="muted"><li>Open the browserControl extension.</li><li>Under Remote agents, choose <strong>Approve app connection</strong>.</li><li>Enter the code above.</li><li>Verify the app name and callback, then press <strong>Allow</strong>.</li></ol>
<p class="warning">Do not share this code. It expires in about two minutes and can authorize only one browser device.</p>
${message ? `<p class="ok">${htmlEscape(message)}</p>` : ""}
<p class="muted">This page checks automatically. <a href="/authorize/device-status?request_id=${encodeURIComponent(pending.requestId)}">Check now</a>.</p>
</div></body></html>`;
  }

  private async handleDeviceApprovalStatus(response: http.ServerResponse, params: URLSearchParams): Promise<void> {
    const requestId = params.get("request_id") || "";
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      writeHtml(response, 400, this.simplePage("Invalid approval request", "Restart the browserControl connector flow from your app."));
      return;
    }

    const current = await this.state.get<PendingDeviceApprovalRecord>("approval", requestId);
    if (!current || current.expiresAt <= Date.now()) {
      writeHtml(response, 410, this.simplePage("Approval expired", "Return to your app and start the browserControl connection again."));
      return;
    }

    if (current.status === "pending") {
      writeHtml(response, 200, this.deviceApprovalPage(current), current.redirectUri, {
        Refresh: `2; url=/authorize/device-status?request_id=${encodeURIComponent(current.requestId)}`,
      });
      return;
    }

    const pending = await this.state.take<PendingDeviceApprovalRecord>("approval", requestId);
    if (!pending) {
      writeHtml(response, 410, this.simplePage("Approval already completed", "Return to your app to continue."));
      return;
    }
    await this.state.delete("approval_code", pending.approvalCode).catch(() => undefined);

    const callback = new URL(pending.redirectUri);
    if (pending.status === "denied") {
      callback.searchParams.set("error", "access_denied");
      if (pending.state) callback.searchParams.set("state", pending.state);
      callback.searchParams.set("iss", this.issuer);
      redirect(response, callback.toString(), 303);
      return;
    }

    const device = pending.deviceId ? await this.relayState.getDevice(pending.deviceId) : null;
    if (
      !device ||
      device.revokedAt ||
      pending.deviceVersion == null ||
      deviceVersion(device) !== pending.deviceVersion
    ) {
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "The approved browser device is no longer valid");
      if (pending.state) callback.searchParams.set("state", pending.state);
      callback.searchParams.set("iss", this.issuer);
      redirect(response, callback.toString(), 303);
      return;
    }

    const client = await this.state.get<OAuthClientRecord>("client", pending.clientId);
    if (!client) {
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "The OAuth client registration expired");
      if (pending.state) callback.searchParams.set("state", pending.state);
      callback.searchParams.set("iss", this.issuer);
      redirect(response, callback.toString(), 303);
      return;
    }

    const grant = await this.createGrant(client, device, pending.scope, pending.resource);
    const code = randomToken(32);
    const record: OAuthAuthorizationCodeRecord = {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      deviceId: device.deviceId,
      deviceVersion: deviceVersion(device),
      scope: pending.scope,
      resource: pending.resource,
      codeChallenge: pending.codeChallenge,
      grantId: grant.grantId,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    };
    await this.state.put("code", code, record, AUTH_CODE_TTL_MS);

    callback.searchParams.set("code", code);
    if (pending.state) callback.searchParams.set("state", pending.state);
    callback.searchParams.set("iss", this.issuer);
    redirect(response, callback.toString(), 303);
  }

  private async handleDeviceApprovalLookup(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.authenticateDeviceRequest(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized device" });
      request.resume();
      return;
    }
    const limit = await this.relayState.consumeRateLimit("oauth-device-approval-lookup", identity.deviceId, 12, 60_000);
    if (!limit.allowed) {
      writeJson(response, 429, { error: "Too many approval-code attempts" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      request.resume();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch {
      writeJson(response, 400, { error: "Invalid approval lookup payload" });
      return;
    }
    const code = normalizeApprovalCode(typeof body.code === "string" ? body.code : "");
    if (!APPROVAL_CODE_PATTERN.test(code)) {
      writeJson(response, 400, { error: "Approval code must be 8 characters" });
      return;
    }

    const codeRecord = await this.state.get<ApprovalCodeRecord>("approval_code", code);
    const pending = codeRecord ? await this.state.get<PendingDeviceApprovalRecord>("approval", codeRecord.requestId) : null;
    if (!codeRecord || !pending || pending.expiresAt <= Date.now() || pending.status !== "pending") {
      writeJson(response, 404, { error: "Approval code is invalid, expired, or already used" });
      return;
    }

    const callback = new URL(pending.redirectUri);
    writeJson(response, 200, {
      requestId: pending.requestId,
      clientName: pending.clientName,
      callback: callback.protocol,
      scope: pending.scope,
      expiresAt: pending.expiresAt,
    });
  }

  private async handleDeviceApprovalDecision(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.authenticateDeviceRequest(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized device" });
      request.resume();
      return;
    }
    const limit = await this.relayState.consumeRateLimit("oauth-device-approval-decision", identity.deviceId, 12, 60_000);
    if (!limit.allowed) {
      writeJson(response, 429, { error: "Too many approval decisions" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      request.resume();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch {
      writeJson(response, 400, { error: "Invalid approval decision payload" });
      return;
    }
    const code = normalizeApprovalCode(typeof body.code === "string" ? body.code : "");
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const decision = body.decision === "approve" ? "approve" : body.decision === "deny" ? "deny" : "";
    if (!APPROVAL_CODE_PATTERN.test(code) || !REQUEST_ID_PATTERN.test(requestId) || !decision) {
      writeJson(response, 400, { error: "Invalid approval decision" });
      return;
    }

    const codeRecord = await this.state.take<ApprovalCodeRecord>("approval_code", code);
    if (!codeRecord || codeRecord.requestId !== requestId || codeRecord.expiresAt <= Date.now()) {
      writeJson(response, 409, { error: "Approval code is invalid, expired, or already claimed" });
      return;
    }
    const pending = await this.state.get<PendingDeviceApprovalRecord>("approval", requestId);
    if (!pending || pending.expiresAt <= Date.now() || pending.status !== "pending") {
      writeJson(response, 409, { error: "Approval request is no longer pending" });
      return;
    }

    const device = await this.relayState.getDevice(identity.deviceId);
    if (!device || device.revokedAt) {
      writeJson(response, 403, { error: "This browserControl device is revoked" });
      return;
    }

    const remaining = Math.max(1, pending.expiresAt - Date.now());
    const updated: PendingDeviceApprovalRecord = decision === "approve"
      ? {
          ...pending,
          status: "approved",
          deviceId: device.deviceId,
          deviceVersion: deviceVersion(device),
        }
      : { ...pending, status: "denied" };
    await this.state.put("approval", requestId, updated, remaining);
    writeJson(response, 200, {
      success: true,
      decision,
      requestId,
      deviceId: decision === "approve" ? device.deviceId : undefined,
    });
  }

  private async handleListDeviceGrants(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.authenticateDeviceRequest(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized device" });
      return;
    }
    const device = await this.relayState.getDevice(identity.deviceId);
    if (!device || device.revokedAt) {
      writeJson(response, 403, { error: "This browserControl device is revoked" });
      return;
    }

    const index = await this.grantIndex(device.deviceId);
    const grants: OAuthGrantRecord[] = [];
    const retained: string[] = [];
    for (const grantId of index.grantIds) {
      const grant = await this.state.get<OAuthGrantRecord>("grant", grantId);
      if (!grant || !this.grantMatches(grant, grant.clientId, device)) continue;
      retained.push(grantId);
      grants.push(grant);
    }
    if (retained.length !== index.grantIds.length) await this.storeGrantIndex(device.deviceId, retained);
    grants.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    writeJson(response, 200, {
      grants: grants.map((grant) => ({
        grantId: grant.grantId,
        clientName: grant.clientName,
        clientId: grant.clientId,
        scope: grant.scope,
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        expiresAt: grant.expiresAt,
      })),
    });
  }

  private async handleRevokeDeviceGrant(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const identity = await this.authenticateDeviceRequest(request);
    if (!identity) {
      writeJson(response, 401, { error: "Unauthorized device" });
      request.resume();
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch {
      writeJson(response, 400, { error: "Invalid grant revocation payload" });
      return;
    }
    const grantId = typeof body.grantId === "string" ? body.grantId : "";
    if (!/^grant_[A-Za-z0-9_-]{20,128}$/.test(grantId)) {
      writeJson(response, 400, { error: "Invalid grant ID" });
      return;
    }
    const grant = await this.state.get<OAuthGrantRecord>("grant", grantId);
    if (!grant || grant.deviceId !== identity.deviceId) {
      writeJson(response, 404, { error: "Grant not found for this browser device" });
      return;
    }
    await this.state.delete("grant", grantId);
    const index = await this.grantIndex(identity.deviceId);
    await this.storeGrantIndex(identity.deviceId, index.grantIds.filter((value) => value !== grantId));
    writeJson(response, 200, { success: true, grantId });
  }

  private async handleAuthorizePost(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch {
      writeHtml(response, 400, this.authorizationPage(null, "Invalid OAuth authorization form."));
      return;
    }

    const validated = await this.validateAuthorization(form);
    if (!validated) {
      writeHtml(response, 400, this.authorizationPage(null, "Invalid or expired OAuth authorization request."));
      return;
    }

    if (isNativePrivateUseRedirect(validated.redirectUri)) {
      writeHtml(response, 400, this.authorizationPage(validated, "Native apps must complete authorization through the short-lived device approval flow."), validated.redirectUri);
      return;
    }

    if (form.get("decision") === "deny") {
      const callback = new URL(validated.redirectUri);
      callback.searchParams.set("error", "access_denied");
      if (validated.state) callback.searchParams.set("state", validated.state);
      callback.searchParams.set("iss", this.issuer);
      redirect(response, callback.toString(), 303);
      return;
    }

    const mcpToken = form.get("device_token") || "";
    const identity = await this.relayState.authenticateMcp(mcpToken);
    const device = identity ? await this.relayState.getDevice(identity.deviceId) : null;
    if (!identity || !device || device.revokedAt) {
      writeHtml(response, 401, this.authorizationPage(validated, "browserControl could not verify this Chrome device. Reconnect the extension and restart authorization."), validated.redirectUri);
      return;
    }

    const grant = await this.createGrant(validated.client, device, validated.scope, validated.resource);
    const code = randomToken(32);
    const expiresAt = Date.now() + AUTH_CODE_TTL_MS;
    const record: OAuthAuthorizationCodeRecord = {
      clientId: validated.clientId,
      redirectUri: validated.redirectUri,
      deviceId: identity.deviceId,
      deviceVersion: deviceVersion(device),
      scope: validated.scope,
      resource: validated.resource,
      codeChallenge: validated.codeChallenge,
      grantId: grant.grantId,
      expiresAt,
    };
    await this.state.put("code", code, record, AUTH_CODE_TTL_MS);

    const callback = new URL(validated.redirectUri);
    callback.searchParams.set("code", code);
    if (validated.state) callback.searchParams.set("state", validated.state);
    callback.searchParams.set("iss", this.issuer);
    redirect(response, callback.toString(), 303);
  }

  private authorizationPage(
    validated: Awaited<ReturnType<RelayOAuthService["validateAuthorization"]>>,
    error = ""
  ): string {
    const hidden = validated
      ? [
          hiddenInput("response_type", "code"),
          hiddenInput("client_id", validated.clientId),
          hiddenInput("redirect_uri", validated.redirectUri),
          hiddenInput("code_challenge", validated.codeChallenge),
          hiddenInput("code_challenge_method", "S256"),
          hiddenInput("state", validated.state),
          hiddenInput("scope", validated.scope),
          hiddenInput("resource", validated.resource),
        ].join("\n")
      : "";
    const redirectUrl = validated ? new URL(validated.redirectUri) : null;
    const redirectTarget = redirectUrl ? (redirectUrl.host || redirectUrl.protocol) : "unknown client";
    const clientName = validated?.client.clientName || "Unknown MCP client";
    const loopbackWarning = redirectUrl && isLoopbackHostname(redirectUrl.hostname)
      ? "<p class=\"warning\">This client redirects to your local computer. Only continue if you deliberately started a local MCP login.</p>"
      : "";
    const nativeWarning = validated?.client.applicationType === "native" && redirectUrl?.protocol !== "http:"
      ? `<p class="muted">After approval, browserControl will return to the native app through <code>${htmlEscape(redirectUrl?.protocol || "")}</code>.</p>`
      : "";

    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize browserControl</title>
<style>body{font:15px system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;color:#1f1f1f}h1{font-size:24px}code,input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #bbb;border-radius:8px}.card{border:1px solid #ddd;border-radius:12px;padding:18px}.muted{color:#666;font-size:13px;line-height:1.5}.error,.warning{color:#9a3412;background:#fff7ed;padding:10px;border-radius:8px}.row{display:flex;gap:10px;margin-top:16px}button{padding:10px 14px;border:1px solid #aaa;border-radius:8px;background:#fff;cursor:pointer}button.primary{background:#111;color:#fff;border-color:#111;flex:1}</style>
</head><body><h1>Authorize browserControl</h1>
<div class="card"><p><strong>${htmlEscape(clientName)}</strong> wants access to your Chrome session through browserControl.</p>
<p class="muted">Redirect: <code>${htmlEscape(redirectTarget)}</code><br>Scope: <code>${BROWSER_SCOPE}</code></p>
${loopbackWarning}${nativeWarning}${error ? `<p class="error">${htmlEscape(error)}</p>` : ""}
${validated ? `<form method="post" action="/authorize">${hidden}
<label for="device_token"><strong>Device verification</strong></label>
<p class="muted">If the browserControl extension is connected in this Chrome, it verifies this device automatically. Otherwise provide the device MCP credential only from a trusted development client.</p>
<input id="device_token" name="device_token" type="password" autocomplete="off" required autofocus>
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Authorize</button></div>
</form>` : "<p>Return to your MCP client and restart the connector authorization flow.</p>"}
</div><p class="muted">Only approve this page if you started the connection from an MCP client you trust.</p></body></html>`;
  }

  private simplePage(title: string, message: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font:15px system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;color:#1f1f1f}.card{border:1px solid #ddd;border-radius:12px;padding:18px}.muted{color:#666}</style></head><body><h1>${htmlEscape(title)}</h1><div class="card"><p class="muted">${htmlEscape(message)}</p></div></body></html>`;
  }

  private async handleToken(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch (error: any) {
      oauthError(response, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, "invalid_request", "Invalid token request");
      return;
    }

    const clientId = form.get("client_id") || "";
    const client = await this.state.get<OAuthClientRecord>("client", clientId);
    if (!client) {
      oauthError(response, 401, "invalid_client", "Unknown OAuth client");
      return;
    }

    const grantType = form.get("grant_type") || "";
    if (grantType === "authorization_code") {
      const code = form.get("code") || "";
      const record = await this.state.take<OAuthAuthorizationCodeRecord>("code", code);
      if (!record || record.expiresAt <= Date.now()) {
        oauthError(response, 400, "invalid_grant", "Authorization code is invalid or expired");
        return;
      }
      if (record.clientId !== clientId || record.redirectUri !== (form.get("redirect_uri") || "")) {
        oauthError(response, 400, "invalid_grant", "Authorization code is not valid for this client or redirect URI");
        return;
      }
      const resource = form.get("resource") || record.resource;
      if (resource !== record.resource || resource !== this.resourceUrl) {
        oauthError(response, 400, "invalid_target", "OAuth resource does not match the MCP endpoint");
        return;
      }
      if (!verifyPkce(form.get("code_verifier") || "", record.codeChallenge)) {
        oauthError(response, 400, "invalid_grant", "PKCE verification failed");
        return;
      }
      const device = await this.relayState.getDevice(record.deviceId);
      if (!device || device.revokedAt || deviceVersion(device) !== record.deviceVersion) {
        oauthError(response, 400, "invalid_grant", "The paired browser credential was revoked or rotated");
        return;
      }

      let grant = record.grantId ? await this.state.get<OAuthGrantRecord>("grant", record.grantId) : null;
      if (grant && !this.grantMatches(grant, clientId, device)) grant = null;
      if (!grant) grant = await this.createGrant(client, device, record.scope, record.resource);
      await this.issueTokens(response, {
        clientId,
        deviceId: record.deviceId,
        deviceVersion: record.deviceVersion,
        scope: record.scope,
        resource: record.resource,
        grantId: grant.grantId,
      }, grant);
      return;
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") || "";
      const record = await this.state.take<OAuthTokenRecord>("refresh", refreshToken);
      if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId) {
        oauthError(response, 400, "invalid_grant", "Refresh token is invalid or expired");
        return;
      }
      const device = await this.relayState.getDevice(record.deviceId);
      if (!device || device.revokedAt || deviceVersion(device) !== record.deviceVersion) {
        oauthError(response, 400, "invalid_grant", "The paired browser credential was revoked or rotated");
        return;
      }

      let grant = record.grantId ? await this.state.get<OAuthGrantRecord>("grant", record.grantId) : null;
      if (record.grantId && (!grant || !this.grantMatches(grant, clientId, device))) {
        oauthError(response, 400, "invalid_grant", "This browserControl authorization was revoked or expired");
        return;
      }
      if (!grant) grant = await this.createGrant(client, device, record.scope, record.resource);
      await this.issueTokens(response, {
        clientId,
        deviceId: record.deviceId,
        deviceVersion: record.deviceVersion,
        scope: record.scope,
        resource: record.resource,
        grantId: grant.grantId,
      }, grant);
      return;
    }

    oauthError(response, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported");
  }

  private async issueTokens(
    response: http.ServerResponse,
    base: Omit<OAuthTokenRecord, "expiresAt">,
    grant?: OAuthGrantRecord
  ): Promise<void> {
    if (grant) await this.touchGrant(grant);
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const accessRecord: OAuthTokenRecord = {
      ...base,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
    const refreshRecord: OAuthTokenRecord = {
      ...base,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    };
    await Promise.all([
      this.state.put("access", accessToken, accessRecord, ACCESS_TOKEN_TTL_MS),
      this.state.put("refresh", refreshToken, refreshRecord, REFRESH_TOKEN_TTL_MS),
    ]);
    writeJson(response, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: base.scope,
    }, { "Access-Control-Allow-Origin": "*" });
  }
}
