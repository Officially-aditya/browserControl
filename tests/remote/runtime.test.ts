import { describe, expect, it } from "vitest";
import { runGatewayRuntime } from "../../src/remote/runtime.js";

const tls = { tlsKey: "test-key", tlsCert: "test-cert" };

describe("gateway runtime public-listener security", () => {
  it("requires an admin token before exposing a public TLS relay", async () => {
    await expect(runGatewayRuntime({ host: "0.0.0.0", ...tls }))
      .rejects.toThrow(/BROWSERCONTROL_ADMIN_TOKEN/);
  });

  it("rejects a global MCP token on a public relay because MCP credentials are device-scoped", async () => {
    await expect(runGatewayRuntime({
      host: "0.0.0.0",
      adminBearerToken: "admin",
      mcpBearerToken: "legacy-global-mcp",
      ...tls,
    })).rejects.toThrow(/device-scoped MCP credentials/);
  });

  it("rejects a permanent static device token on a public TLS relay", async () => {
    await expect(runGatewayRuntime({
      host: "0.0.0.0",
      adminBearerToken: "admin",
      extensionToken: "static-device-secret",
      ...tls,
    })).rejects.toThrow(/revocable device pairing/);
  });
});
