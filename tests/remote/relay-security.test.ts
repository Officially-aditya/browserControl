import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runRemoteGateway } from "../../src/remote/gateway.js";

const gateways: Array<Awaited<ReturnType<typeof runRemoteGateway>>> = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) {
    gateway.wss.close();
    if (gateway.httpServer.listening) {
      await new Promise<void>((resolve) => gateway.httpServer.close(() => resolve()));
    }
  }
});

describe("routed relay security boundaries", () => {
  it("does not inherit loopback development trust when explicitly running a private hop for a public relay", async () => {
    const gateway = await runRemoteGateway({
      host: "127.0.0.1",
      port: 0,
      adminBearerToken: "admin-secret",
      allowLoopbackDevelopment: false,
    });
    gateways.push(gateway);
    const port = (gateway.httpServer.address() as any).port;

    expect(gateway.mcpBearerToken).toBe("");

    const unauthenticatedMcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(unauthenticatedMcp.status).toBe(401);
  });

  it("rejects chunked MCP payloads that exceed the configured body limit", async () => {
    const gateway = await runRemoteGateway({
      host: "127.0.0.1",
      port: 0,
      extensionToken: "device-secret",
      mcpBearerToken: "mcp-secret",
      adminBearerToken: "admin-secret",
      maxMcpBodySize: 32,
    });
    gateways.push(gateway);
    const port = (gateway.httpServer.address() as any).port;

    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          Authorization: "Bearer mcp-secret",
          "Content-Type": "application/json",
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode || 0));
      });
      request.once("error", reject);
      request.write("{\"jsonrpc\":\"2.0\",\"id\":1,");
      request.write("\"method\":\"tools/list\",\"params\":{}}");
      request.end();
    });

    expect(status).toBe(413);
  });
});
