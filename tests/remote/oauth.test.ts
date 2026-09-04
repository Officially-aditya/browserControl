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
