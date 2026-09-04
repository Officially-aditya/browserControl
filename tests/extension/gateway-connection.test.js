import { describe, expect, it } from "vitest";
import {
  PRODUCTION_GATEWAY_URL,
  PRODUCTION_MCP_URL,
  getGatewayHttpUrl,
  getGatewayMcpUrl,
  getGatewayPermissionOrigin,
  getLoopbackHealthUrl,
  getReconnectDelay,
  isLoopbackHostname,
  resolveGatewayUrl,
} from "../../extension/gateway-connection.js";

describe("extension gateway connection helpers", () => {
  it("recognizes loopback hostnames", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("gateway.example.com")).toBe(false);
  });

  it("uses the managed production relay by default", () => {
    expect(resolveGatewayUrl({})).toBe(PRODUCTION_GATEWAY_URL);
    expect(getGatewayMcpUrl()).toBe(PRODUCTION_MCP_URL);
  });

  it("allows hidden loopback developer overrides but not alternate remote relays", () => {
    expect(resolveGatewayUrl({ developerGatewayUrl: "ws://127.0.0.1:8787/extension" }))
      .toBe("ws://127.0.0.1:8787/extension");
    expect(resolveGatewayUrl({ gatewayUrl: "wss://localhost:8787/extension" }))
      .toBe("wss://localhost:8787/extension");
    expect(() => resolveGatewayUrl({ developerGatewayUrl: "wss://other.example.com/extension" }))
      .toThrow(/loopback/);
    expect(resolveGatewayUrl({ gatewayUrl: "wss://other.example.com/extension" }))
      .toBe(PRODUCTION_GATEWAY_URL);
  });

  it("maps ws/wss gateways to their HTTP API origins", () => {
    expect(getGatewayHttpUrl("wss://gateway.example.com/extension?token=secret", "/enroll/claim").toString())
      .toBe("https://gateway.example.com/enroll/claim");
    expect(getGatewayHttpUrl("ws://127.0.0.1:8787/extension", "/health").toString())
      .toBe("http://127.0.0.1:8787/health");
    expect(() => getGatewayHttpUrl("ws://gateway.example.com/extension")).toThrow(/secure wss/);
  });

  it("builds a remote MCP connector URL without credentials", () => {
    expect(getGatewayMcpUrl("wss://relay.example.com/extension"))
      .toBe("https://relay.example.com/mcp");
  });

  it("builds valid port-agnostic optional permission origins", () => {
    expect(getGatewayPermissionOrigin("wss://gateway.example.com/extension")).toBe("https://gateway.example.com/*");
    expect(getGatewayPermissionOrigin("ws://localhost:8787/extension")).toBe("http://localhost/*");
    expect(getGatewayPermissionOrigin("not a url")).toBeNull();
  });

  it("builds a quiet health probe for local ws endpoints", () => {
    expect(getLoopbackHealthUrl("ws://127.0.0.1:8787/extension?token=secret")).toBe("http://127.0.0.1:8787/health");
    expect(getLoopbackHealthUrl("ws://[::1]:8787/extension")).toBe("http://[::1]:8787/health");
    expect(getLoopbackHealthUrl("wss://gateway.example.com/extension")).toBeNull();
    expect(getLoopbackHealthUrl("not a url")).toBeNull();
  });

  it("uses bounded exponential reconnect backoff", () => {
    expect(getReconnectDelay(0)).toBe(1000);
    expect(getReconnectDelay(3)).toBe(8000);
    expect(getReconnectDelay(99)).toBe(30000);
  });
});
