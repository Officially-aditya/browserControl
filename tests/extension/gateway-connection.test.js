import { describe, expect, it } from "vitest";
import {
  getGatewayHttpUrl,
  getGatewayMcpUrl,
  getGatewayPermissionOrigin,
  getLoopbackHealthUrl,
  getReconnectDelay,
  isLoopbackHostname,
} from "../../extension/gateway-connection.js";

describe("extension gateway connection helpers", () => {
  it("recognizes loopback hostnames", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("gateway.example.com")).toBe(false);
  });

  it("maps ws/wss gateways to their HTTP API origins", () => {
    expect(getGatewayHttpUrl("wss://gateway.example.com/extension?token=secret", "/pairing/claim").toString())
      .toBe("https://gateway.example.com/pairing/claim");
    expect(getGatewayHttpUrl("ws://127.0.0.1:8787/extension", "/health").toString())
      .toBe("http://127.0.0.1:8787/health");
    expect(() => getGatewayHttpUrl("ws://gateway.example.com/extension")).toThrow(/secure wss/);
  });

  it("builds a device-scoped remote MCP connector URL", () => {
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
