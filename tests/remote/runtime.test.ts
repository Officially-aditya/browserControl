import { describe, expect, it } from "vitest";
import { runGatewayRuntime } from "../../src/remote/runtime.js";

const tls = { tlsKey: "test-key", tlsCert: "test-cert" };

describe("gateway runtime public-listener security", () => {
  it("requires an MCP token before exposing a public TLS listener", async () => {
    await expect(runGatewayRuntime({ host: "0.0.0.0", ...tls }))
      .rejects.toThrow(/BROWSERCONTROL_MCP_TOKEN/);
  });

  it("requires a separate admin token before exposing a public TLS listener", async () => {
    await expect(runGatewayRuntime({ host: "0.0.0.0", mcpBearerToken: "mcp", ...tls }))
      .rejects.toThrow(/BROWSERCONTROL_ADMIN_TOKEN/);
  });

  it("rejects a permanent static device token on a public TLS listener", async () => {
    await expect(runGatewayRuntime({
      host: "0.0.0.0",
      mcpBearerToken: "mcp",
      adminBearerToken: "admin",
      extensionToken: "static-device-secret",
      ...tls,
    })).rejects.toThrow(/revocable device pairing/);
  });
});
