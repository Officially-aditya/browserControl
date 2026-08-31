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

  it("requires a shared cluster token when Redis enables horizontal scaling", async () => {
    await expect(runGatewayRuntime({
      host: "0.0.0.0",
      adminBearerToken: "admin",
      redisUrl: "redis://127.0.0.1:1",
      relayInternalUrl: "https://relay-1.internal.example",
      ...tls,
    })).rejects.toThrow(/BROWSERCONTROL_RELAY_CLUSTER_TOKEN/);
  });

  it("requires a peer-reachable per-replica URL for a public clustered TLS relay", async () => {
    await expect(runGatewayRuntime({
      host: "0.0.0.0",
      adminBearerToken: "admin",
      redisUrl: "redis://127.0.0.1:1",
      clusterToken: "cluster-secret",
      ...tls,
    })).rejects.toThrow(/BROWSERCONTROL_RELAY_INTERNAL_URL/);
  });
});
