import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DeviceIdentity } from "./device-auth.js";
import type { RelayDeviceRecord, RelayState } from "./relay-state.js";
import {
  MemoryOAuthState,
  RedisOAuthState,
  type OAuthState,
} from "./oauth-state.js";

const BROWSER_SCOPE = "browser:control";
const CLIENT_TTL_MS = 365 * 24 * 60 * 60_000;
const AUTH_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

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
  expiresAt: number;
};

type OAuthTokenRecord = {
  clientId: string;
  deviceId: string;
  deviceVersion: number;
  scope: string;
  resource: string;
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

function writeHtml(response: http.ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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

function isAllowedRegisteredRedirect(raw: string): boolean {
  if (!raw || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.toString() === CLAUDE_CALLBACK) return true;
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
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
    return { deviceId: device.deviceId, name: device.name, clientId: record.clientId };
  }

  public async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): Promise<boolean> {
    const pathname = url.pathname;

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
      await this.handleAuthorizeGet(response, url.searchParams);
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

  private async handleRegistration(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch (error: any) {
      oauthError(response, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, "invalid_client_metadata", "Invalid client registration payload");
      return;
    }

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      redirectUris.some((uri) => !isAllowedRegisteredRedirect(uri))
    ) {
      oauthError(response, 400, "invalid_redirect_uri", "Register the Claude callback or an RFC 8252 loopback redirect URI");
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

    const applicationType = body.application_type === "native" ? "native" : "web";
    const clientName = typeof body.client_name === "string"
      ? body.client_name.trim().slice(0, 120) || "Claude MCP client"
      : "Claude MCP client";
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

  private async handleAuthorizeGet(response: http.ServerResponse, params: URLSearchParams): Promise<void> {
    const validated = await this.validateAuthorization(params);
    if (!validated) {
      writeHtml(response, 400, this.authorizationPage(null, "Invalid or unsupported OAuth authorization request."));
      return;
    }
    writeHtml(response, 200, this.authorizationPage(validated));
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
      writeHtml(response, 401, this.authorizationPage(validated, "That MCP token is invalid or was rotated. Copy the current token from the browserControl extension and try again."));
      return;
    }

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
    const redirectHost = validated ? new URL(validated.redirectUri).host : "unknown client";
    const clientName = validated?.client.clientName || "Unknown MCP client";
    const loopbackWarning = validated && isLoopbackHostname(new URL(validated.redirectUri).hostname)
      ? "<p class=\"warning\">This client redirects to your local computer. Only continue if you deliberately started a local Claude/Inspector login.</p>"
      : "";

    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize browserControl</title>
<style>body{font:15px system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;color:#1f1f1f}h1{font-size:24px}code,input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #bbb;border-radius:8px}.card{border:1px solid #ddd;border-radius:12px;padding:18px}.muted{color:#666;font-size:13px;line-height:1.5}.error,.warning{color:#9a3412;background:#fff7ed;padding:10px;border-radius:8px}.row{display:flex;gap:10px;margin-top:16px}button{padding:10px 14px;border:1px solid #aaa;border-radius:8px;background:#fff;cursor:pointer}button.primary{background:#111;color:#fff;border-color:#111;flex:1}</style>
</head><body><h1>Authorize browserControl</h1>
<div class="card"><p><strong>${htmlEscape(clientName)}</strong> wants access to the Chrome device paired with browserControl.</p>
<p class="muted">Redirect: <code>${htmlEscape(redirectHost)}</code><br>Scope: <code>${BROWSER_SCOPE}</code></p>
${loopbackWarning}${error ? `<p class="error">${htmlEscape(error)}</p>` : ""}
${validated ? `<form method="post" action="/authorize">${hidden}
<label for="device_token"><strong>MCP bearer token</strong></label>
<p class="muted">Open the browserControl extension and click <strong>Copy MCP token</strong>. Paste it here. The token is verified by this relay and is never sent to Claude.</p>
<input id="device_token" name="device_token" type="password" autocomplete="off" required autofocus>
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Authorize Claude</button></div>
</form>` : "<p>Return to Claude and restart the connector authorization flow.</p>"}
</div><p class="muted">Only approve this page if you started the connection from Claude or another MCP client you trust.</p></body></html>`;
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
      await this.issueTokens(response, {
        clientId,
        deviceId: record.deviceId,
        deviceVersion: record.deviceVersion,
        scope: record.scope,
        resource: record.resource,
      });
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
      await this.issueTokens(response, {
        clientId,
        deviceId: record.deviceId,
        deviceVersion: record.deviceVersion,
        scope: record.scope,
        resource: record.resource,
      });
      return;
    }

    oauthError(response, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported");
  }

  private async issueTokens(
    response: http.ServerResponse,
    base: Omit<OAuthTokenRecord, "expiresAt">
  ): Promise<void> {
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
