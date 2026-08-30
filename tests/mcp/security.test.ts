import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { runHttpMcpServer, extractHostname } from "../../src/mcp/http-server.js";

describe("MCP HTTP Security Hardening Suite", () => {
  let mcpInstance: { server: http.Server; transports: Record<string, any>; authToken: string };
  let port: number;

  beforeAll(async () => {
    // Start server with specific auth token, CORS disabled by default, and small max body size (1 KB for test)
    mcpInstance = await runHttpMcpServer(0, "127.0.0.1", undefined, {
      authToken: "test-secret-key-12345",
      enableCors: false,
      maxBodySizeBytes: 1024, // 1 KB limit for testing 413
    });
    port = (mcpInstance.server.address() as any).port;
  });

  afterAll(async () => {
    if (mcpInstance?.server) {
      await new Promise<void>((resolve) => mcpInstance.server.close(() => resolve()));
    }
  });

  // Helper to make raw HTTP requests
  function makeRequest(options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: options.path || "/mcp",
          method: options.method || "GET",
          headers: options.headers || {},
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body: data,
            });
          });
        }
      );
      req.on("error", reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  describe("1. Mandatory Authentication Enforcement", () => {
    it("should reject requests missing Authorization header with 401 Unauthorized", async () => {
      const res = await makeRequest({
        method: "GET",
        path: "/health",
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(401);
      expect(res.body).toContain("Unauthorized");
    });

    it("should reject requests with invalid Bearer token with 401 Unauthorized", async () => {
      const res = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: "Bearer invalid-wrong-token",
        },
      });
      expect(res.status).toBe(401);
      expect(res.body).toContain("Unauthorized");
    });

    it("should accept requests with valid Bearer token", async () => {
      const res = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    });
  });

  describe("2. Host Header Validation & DNS Rebinding Protection", () => {
    it("should reject requests with malicious Host headers (e.g. evil.com) with 403 Forbidden", async () => {
      const res = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: "evil.com",
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Forbidden: Invalid or unrecognized Host header");
    });

    it("should allow valid loopback Host headers (127.0.0.1, localhost, [::1], and ::1)", async () => {
      const res1 = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res1.status).toBe(200);

      const res2 = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: `localhost:${port}`,
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res2.status).toBe(200);

      // Bracketed IPv6 with port
      const res3 = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: `[::1]:${port}`,
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res3.status).toBe(200);

      // Bracketed IPv6 without port
      const res4 = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: "[::1]",
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res4.status).toBe(200);

      // Raw unbracketed IPv6
      const res5 = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: "::1",
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res5.status).toBe(200);
    });

    it("should correctly parse and normalize various IPv6, IPv4, and domain Host headers with extractHostname", () => {
      expect(extractHostname("127.0.0.1:8080")).toBe("127.0.0.1");
      expect(extractHostname("127.0.0.1")).toBe("127.0.0.1");
      expect(extractHostname("localhost:3000")).toBe("localhost");
      expect(extractHostname("localhost")).toBe("localhost");
      expect(extractHostname("[::1]:8080")).toBe("::1");
      expect(extractHostname("[::1]")).toBe("::1");
      expect(extractHostname("::1")).toBe("::1");
      expect(extractHostname("[fe80::1]:9000")).toBe("fe80::1");
      expect(extractHostname("[2001:db8::1]")).toBe("2001:db8::1");
      expect(extractHostname("api.internal.corp:443")).toBe("api.internal.corp");
    });
  });

  describe("3. CORS Disabled by Default & Whitelist Control", () => {
    it("should not return Access-Control-Allow-Origin header by default", async () => {
      const res = await makeRequest({
        method: "GET",
        path: "/health",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: "http://attacker-site.com",
          Authorization: `Bearer ${mcpInstance.authToken}`,
        },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("should reject OPTIONS preflight with 403 when CORS is disabled", async () => {
      const res = await makeRequest({
        method: "OPTIONS",
        path: "/mcp",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: "http://untrusted-site.com",
        },
      });
      expect(res.status).toBe(403);
    });

    it("should allow CORS only for whitelisted origin when enabled", async () => {
      const corsServer = await runHttpMcpServer(0, "127.0.0.1", undefined, {
        authToken: "cors-token",
        enableCors: true,
        allowedOrigins: ["https://trusted-dashboard.internal"],
      });
      const corsPort = (corsServer.server.address() as any).port;

      try {
        // Whitelisted origin preflight
        const reqPromise = new Promise<number>((resolve) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: corsPort,
              path: "/mcp",
              method: "OPTIONS",
              headers: {
                Host: `127.0.0.1:${corsPort}`,
                Origin: "https://trusted-dashboard.internal",
              },
            },
            (res) => resolve(res.statusCode || 0)
          );
          req.end();
        });
        const status = await reqPromise;
        expect(status).toBe(204);

        // Non-whitelisted origin preflight
        const blockedPromise = new Promise<number>((resolve) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: corsPort,
              path: "/mcp",
              method: "OPTIONS",
              headers: {
                Host: `127.0.0.1:${corsPort}`,
                Origin: "https://evil.com",
              },
            },
            (res) => resolve(res.statusCode || 0)
          );
          req.end();
        });
        const blockedStatus = await blockedPromise;
        expect(blockedStatus).toBe(403);
      } finally {
        await new Promise<void>((resolve) => corsServer.server.close(() => resolve()));
      }
    });
  });

  describe("4. Request Payload Size Limits", () => {
    it("should reject payloads exceeding max body size with 413 Payload Too Large", async () => {
      const oversizedPayload = JSON.stringify({
        jsonrpc: "2.0",
        method: "test",
        params: { data: "x".repeat(2048) }, // 2 KB exceeds the configured 1 KB limit
        id: 1,
      });

      const res = await makeRequest({
        method: "POST",
        path: "/mcp",
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${mcpInstance.authToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(oversizedPayload).toString(),
        },
        body: oversizedPayload,
      });

      expect(res.status).toBe(413);
      const parsedBody = JSON.parse(res.body);
      expect(parsedBody.error).toContain("Payload Too Large");
    });
  });
});
