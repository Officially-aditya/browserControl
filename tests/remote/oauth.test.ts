import net from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import WebSocket from "ws";
import { runRemoteGateway } from "../../src/remote/gateway.js";

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const ENROLLMENT_HEADERS = {
  "Content-Type": "application/json",
  "X-BrowserControl-Enrollment": "extension-v1",
};
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

function form(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) params.set(key, value);
  return params;
}

async function enroll(baseUrl: string, name = "OAuth Chrome") {
  const nonce = "oauth-enrollment-nonce-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE";
  const nonceHash = createHash("sha256").update(nonce).digest("hex");
  const started = await fetch(`${baseUrl}/enroll/start`, {
    method: "POST",
    headers: ENROLLMENT_HEADERS,
    body: JSON.stringify({ nonceHash, name }),
  });
  expect(started.status).toBe(201);
  const startPayload = await started.json() as { ticket: string; expiresAt: number };
  expect(startPayload.ticket.length).toBeGreaterThan(40);

  const claimed = await fetch(`${baseUrl}/enroll/claim`, {
    method: "POST",
    headers: ENROLLMENT_HEADERS,
    body: JSON.stringify({ ticket: startPayload.ticket, nonce }),
  });
  expect(claimed.status).toBe(200);
  return claimed.json() as Promise<{ deviceId: string; deviceToken: string; mcpToken: string }>;
}

describe("MCP OAuth for Claude", () => {
  let gateway: Awaited<ReturnType<typeof runRemoteGateway>>;
  let port: number;
  let baseUrl: string;
  let extension: WebSocket;
  let deviceId: string;
  let deviceToken: string;
  let mcpToken: string;

  beforeAll(async () => {
    port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    gateway = await runRemoteGateway({
      host: "127.0.0.1",
      port,
      adminBearerToken: "admin-secret",
      allowLoopbackDevelopment: false,
      publicBaseUrl: baseUrl,
      leaseTtlMs: 5_000,
    });

    const credential = await enroll(baseUrl);
    deviceId = credential.deviceId;
    deviceToken = credential.deviceToken;
    mcpToken = credential.mcpToken;

    extension = new WebSocket(
      `${baseUrl.replace("http://", "ws://")}/extension`,
      [`browsercontrol.${credential.deviceToken}`]
    );
    await new Promise<void>((resolve, reject) => {
      extension.once("open", resolve);
      extension.once("error", reject);
    });

    extension.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (!request.id || !request.method) return;
      let result: any;
      if (request.method === "status") {
        result = { connected: true, attachedTabId: 77, visualEpoch: 1, paused: false };
      } else if (request.method === "observe") {
        result = {
          observationId: "77:1:oauth-observation",
          visualEpoch: 1,
          targetId: "77",
          url: "https://example.com/",
          title: "OAuth example",
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
        result = { success: true, visualEpoch: 2 };
      }
      extension.send(JSON.stringify({ id: request.id, ok: true, result }));
    });
  });

  afterAll(async () => {
    extension?.close();
    gateway?.wss.close();
    if (gateway?.httpServer) {
      await new Promise<void>((resolve) => gateway.httpServer.close(() => resolve()));
    }
  });

  it("requires extension-marked enrollment and proof of possession", async () => {
    const nonce = "proof-test-nonce-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHI";
    const nonceHash = createHash("sha256").update(nonce).digest("hex");

    const unmarked = await fetch(`${baseUrl}/enroll/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonceHash }),
    });
    expect(unmarked.status).toBe(403);

    const started = await fetch(`${baseUrl}/enroll/start`, {
      method: "POST",
      headers: ENROLLMENT_HEADERS,
      body: JSON.stringify({ nonceHash, name: "Proof test" }),
    });
    expect(started.status).toBe(201);
    const { ticket } = await started.json() as { ticket: string };

    const wrong = await fetch(`${baseUrl}/enroll/claim`, {
      method: "POST",
      headers: ENROLLMENT_HEADERS,
      body: JSON.stringify({ ticket, nonce: "wrong-proof-nonce-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE" }),
    });
    expect(wrong.status).toBe(401);

    const replay = await fetch(`${baseUrl}/enroll/claim`, {
      method: "POST",
      headers: ENROLLMENT_HEADERS,
      body: JSON.stringify({ ticket, nonce }),
    });
    expect(replay.status).toBe(404);
  });

  it("allows the validated OpenCode loopback callback origin in authorization CSP", async () => {
    const redirectUri = "http://127.0.0.1:41823/callback";
    const registered = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "OpenCode",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string };

    const verifier = "opencode-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authParams = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "opencode-state",
      scope: "browser:control",
      resource: `${baseUrl}/mcp`,
    };

    const authorizePage = await fetch(`${baseUrl}/authorize?${form(authParams)}`);
    expect(authorizePage.status).toBe(200);
    const csp = authorizePage.headers.get("content-security-policy") || "";
    expect(csp).toContain(`form-action 'self' ${new URL(redirectUri).origin};`);
    expect(csp).not.toContain("https://claude.ai");
  });

  it("requires explicit Mac approval for a native Android callback and binds the grant to that device", async () => {
    const redirectUri = "in.cuppet.app:/oauth/callback";
    const registered = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Cuppet Android",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string; application_type: string };
    expect(client.application_type).toBe("native");

    const verifier = "android-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authParams = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "android-state",
      scope: "browser:control",
      resource: `${baseUrl}/mcp`,
    };

    const authorizePage = await fetch(`${baseUrl}/authorize?${form(authParams)}`);
    expect(authorizePage.status).toBe(200);
    expect(authorizePage.headers.get("content-security-policy"))
      .toContain("form-action 'self' in.cuppet.app:;");
    const html = await authorizePage.text();
    expect(html).toContain("Cuppet Android");
    expect(html).toContain("in.cuppet.app:");
    const approvalCode = html.match(/id="approval-code" class="code">([A-Z0-9]{8})</)?.[1] || "";
    expect(approvalCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    const refresh = authorizePage.headers.get("refresh") || "";
    const requestId = refresh.match(/request_id=([A-Za-z0-9_-]+)/)?.[1] || "";
    expect(requestId.length).toBeGreaterThan(20);

    const directNativePost = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ ...authParams, device_token: mcpToken, decision: "approve" }),
      redirect: "manual",
    });
    expect(directNativePost.status).toBe(400);

    const unauthenticatedLookup = await fetch(`${baseUrl}/device-approvals/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: approvalCode }),
    });
    expect(unauthenticatedLookup.status).toBe(401);

    const lookup = await fetch(`${baseUrl}/device-approvals/lookup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: approvalCode }),
    });
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      requestId,
      clientName: "Cuppet Android",
      callback: "in.cuppet.app:",
      scope: "browser:control",
    });

    const otherDevice = await enroll(baseUrl, "Other Chrome");
    const otherLookup = await fetch(`${baseUrl}/device-approvals/lookup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherDevice.deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: approvalCode }),
    });
    expect(otherLookup.status).toBe(200);

    const approved = await fetch(`${baseUrl}/device-approvals/decision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: approvalCode, requestId, decision: "approve" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ success: true, decision: "approve", deviceId });

    const stolenAfterApproval = await fetch(`${baseUrl}/device-approvals/decision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherDevice.deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: approvalCode, requestId, decision: "approve" }),
    });
    expect(stolenAfterApproval.status).toBe(409);

    const completed = await fetch(`${baseUrl}/authorize/device-status?request_id=${encodeURIComponent(requestId)}`, {
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    const callback = new URL(completed.headers.get("location") || "");
    expect(callback.protocol).toBe("in.cuppet.app:");
    expect(callback.pathname).toBe("/oauth/callback");
    expect(callback.searchParams.get("state")).toBe("android-state");
    expect(callback.searchParams.get("iss")).toBe(baseUrl);
    const code = callback.searchParams.get("code") || "";
    expect(code.length).toBeGreaterThan(20);

    const exchanged = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(exchanged.status).toBe(200);
    const token = await exchanged.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(token.token_type).toBe("Bearer");

    const grants = await fetch(`${baseUrl}/device-approvals/grants`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(grants.status).toBe(200);
    const grantPayload = await grants.json() as { grants: Array<{ grantId: string; clientName: string }> };
    const cuppetGrant = grantPayload.grants.find((grant) => grant.clientName === "Cuppet Android");
    expect(cuppetGrant?.grantId).toMatch(/^grant_/);

    const otherGrants = await fetch(`${baseUrl}/device-approvals/grants`, {
      headers: { Authorization: `Bearer ${otherDevice.deviceToken}` },
    });
    expect(otherGrants.status).toBe(200);
    expect(await otherGrants.json()).toMatchObject({ grants: [] });

    const wrongDeviceRevoke = await fetch(`${baseUrl}/device-approvals/grants/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherDevice.deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grantId: cuppetGrant?.grantId }),
    });
    expect(wrongDeviceRevoke.status).toBe(404);

    const beforeRevoke = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      redirect: "manual",
    });
    expect(beforeRevoke.status).not.toBe(401);

    const revoked = await fetch(`${baseUrl}/device-approvals/grants/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grantId: cuppetGrant?.grantId }),
    });
    expect(revoked.status).toBe(200);

    const afterRevoke = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      redirect: "manual",
    });
    expect(afterRevoke.status).toBe(401);

    const refreshAfterRevoke = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: token.refresh_token,
      }),
    });
    expect(refreshAfterRevoke.status).toBe(400);
    expect(await refreshAfterRevoke.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects explicit web private-use redirects, unsafe schemes, and invalid application types", async () => {
    const webPrivateUse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Bad web client",
        redirect_uris: ["in.cuppet.app:/oauth/callback"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      }),
    });
    expect(webPrivateUse.status).toBe(400);
    expect(await webPrivateUse.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const unsafeNative = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Unsafe native client",
        redirect_uris: ["javascript:alert(1)"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    });
    expect(unsafeNative.status).toBe(400);
    expect(await unsafeNative.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const invalidApplicationType = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Invalid app type",
        redirect_uris: ["in.cuppet.app:/oauth/callback"],
        token_endpoint_auth_method: "none",
        application_type: "desktop",
      }),
    });
    expect(invalidApplicationType.status).toBe(400);
    expect(await invalidApplicationType.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("discovers OAuth, completes Claude DCR + PKCE, and reaches browser_observe", async () => {
    const unauthenticated = await fetch(`${baseUrl}/mcp`, { redirect: "manual" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      `resource_metadata=\"${baseUrl}/.well-known/oauth-protected-resource/mcp\"`
    );

    const resourceMetadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(resourceMetadata.status).toBe(200);
    expect(await resourceMetadata.json()).toMatchObject({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ["browser:control"],
    });

    const serverMetadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(serverMetadata.status).toBe(200);
    expect(await serverMetadata.json()).toMatchObject({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      code_challenge_methods_supported: ["S256"],
    });

    const registered = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [CLAUDE_CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      }),
    });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string };
    expect(client.client_id).toMatch(/^bc_/);

    const verifier = "oauth-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authParams = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "claude-state",
      scope: "browser:control",
      resource: `${baseUrl}/mcp`,
    };

    const authorizePage = await fetch(`${baseUrl}/authorize?${form(authParams)}`);
    expect(authorizePage.status).toBe(200);
    expect(authorizePage.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai;");
    expect(await authorizePage.text()).toContain("Authorize browserControl");

    const approved = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ ...authParams, device_token: mcpToken, decision: "approve" }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.get("location") || "");
    expect(callback.origin + callback.pathname).toBe(CLAUDE_CALLBACK);
    expect(callback.searchParams.get("state")).toBe("claude-state");
    expect(callback.searchParams.get("iss")).toBe(baseUrl);
    const code = callback.searchParams.get("code") || "";
    expect(code.length).toBeGreaterThan(20);

    const exchanged = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: CLAUDE_CALLBACK,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(exchanged.status).toBe(200);
    const token = await exchanged.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(token.token_type).toBe("Bearer");
    expect(token.access_token.length).toBeGreaterThan(20);
    expect(token.refresh_token.length).toBeGreaterThan(20);

    const mcpClient = new Client(
      { name: "oauth-relay-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
    });
    try {
      await mcpClient.connect(transport);
      const listed = await mcpClient.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("browser_observe");
      expect(listed.tools.map((tool) => tool.name)).toContain("browser_click");

      const observed = await mcpClient.callTool({ name: "browser_observe", arguments: { format: "png" } });
      expect(observed.isError).toBeFalsy();
      expect((observed.content[0] as any).text).toContain("77:1:oauth-observation");
      expect((observed.content[1] as any).data).toBe(ONE_PIXEL_PNG);
    } finally {
      await mcpClient.close();
    }

    const refreshed = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: token.refresh_token,
      }),
    });
    expect(refreshed.status).toBe(200);
    const refreshedTokens = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(refreshedTokens.refresh_token).not.toBe(token.refresh_token);

    const reusedRefresh = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: token.refresh_token,
      }),
    });
    expect(reusedRefresh.status).toBe(400);
    expect(await reusedRefresh.json()).toMatchObject({ error: "invalid_grant" });

    const rotated = await fetch(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/connector/rotate`, {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret" },
    });
    expect(rotated.status).toBe(200);

    const invalidated = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${refreshedTokens.access_token}` },
      redirect: "manual",
    });
    expect(invalidated.status).toBe(401);
  });
});
