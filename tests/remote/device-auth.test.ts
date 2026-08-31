import { describe, expect, it, vi } from "vitest";
import { DeviceRegistry, PairingManager } from "../../src/remote/device-auth.js";

describe("remote device authentication", () => {
  it("issues independent extension and MCP credentials without exposing digests", () => {
    const registry = new DeviceRegistry();
    const issued = registry.issue("Laptop Chrome");

    expect(issued.deviceId).toMatch(/^[a-f0-9]{24}$/);
    expect(issued.deviceToken.length).toBeGreaterThan(30);
    expect(issued.mcpToken.length).toBeGreaterThan(30);
    expect(issued.mcpToken).not.toBe(issued.deviceToken);
    expect(registry.authenticateDevice(issued.deviceToken)).toEqual({ deviceId: issued.deviceId, name: "Laptop Chrome" });
    expect(registry.authenticateMcp(issued.mcpToken)).toEqual({ deviceId: issued.deviceId, name: "Laptop Chrome" });
    expect(JSON.stringify(registry.list())).not.toContain(issued.deviceToken);
    expect(JSON.stringify(registry.list())).not.toContain(issued.mcpToken);
  });

  it("rotates only the MCP connector credential", () => {
    const registry = new DeviceRegistry();
    const issued = registry.issue("Desktop");
    const rotated = registry.rotateMcpToken(issued.deviceId);

    expect(rotated?.mcpToken).toBeTruthy();
    expect(rotated?.mcpToken).not.toBe(issued.mcpToken);
    expect(registry.authenticateMcp(issued.mcpToken)).toBeNull();
    expect(registry.authenticateMcp(rotated!.mcpToken)?.deviceId).toBe(issued.deviceId);
    expect(registry.authenticateDevice(issued.deviceToken)?.deviceId).toBe(issued.deviceId);
    expect(registry.list()[0].mcpRotatedAt).toBeTypeOf("number");
  });

  it("revokes both device and MCP credentials immediately and emits a revocation event", () => {
    const registry = new DeviceRegistry();
    const issued = registry.issue();
    const revoked: string[] = [];
    const unsubscribe = registry.onRevoked((deviceId) => revoked.push(deviceId));

    expect(registry.authenticateDevice(issued.deviceToken)?.deviceId).toBe(issued.deviceId);
    expect(registry.authenticateMcp(issued.mcpToken)?.deviceId).toBe(issued.deviceId);
    expect(registry.revoke(issued.deviceId)).toBe(true);
    expect(registry.authenticateDevice(issued.deviceToken)).toBeNull();
    expect(registry.authenticateMcp(issued.mcpToken)).toBeNull();
    expect(revoked).toEqual([issued.deviceId]);
    expect(registry.revoke(issued.deviceId)).toBe(false);

    unsubscribe();
  });

  it("round-trips a token-digest-only registry snapshot", () => {
    const registry = new DeviceRegistry();
    const issued = registry.issue("Persistent laptop");
    const snapshot = registry.snapshot();
    const restored = new DeviceRegistry(snapshot);

    expect(JSON.stringify(snapshot)).not.toContain(issued.deviceToken);
    expect(JSON.stringify(snapshot)).not.toContain(issued.mcpToken);
    expect(restored.authenticateDevice(issued.deviceToken)?.deviceId).toBe(issued.deviceId);
    expect(restored.authenticateMcp(issued.mcpToken)?.deviceId).toBe(issued.deviceId);
  });

  it("uses eight-digit one-time pairing codes by default and provisions both relay credentials", () => {
    const registry = new DeviceRegistry();
    const pairing = new PairingManager(registry);
    const { code } = pairing.create("Desktop");

    expect(pairing.digits).toBe(8);
    expect(code).toMatch(/^\d{8}$/);
    const credential = pairing.claim(code);
    expect(credential?.name).toBe("Desktop");
    expect(credential && registry.authenticateDevice(credential.deviceToken)?.deviceId).toBe(credential?.deviceId);
    expect(credential && registry.authenticateMcp(credential.mcpToken)?.deviceId).toBe(credential?.deviceId);
    expect(pairing.claim(code)).toBeNull();
  });

  it("expires unclaimed pairing codes", () => {
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const pairing = new PairingManager(registry, 1_000);
      const { code } = pairing.create();
      vi.advanceTimersByTime(1_001);
      expect(pairing.claim(code)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the configured pairing-code length bounds", () => {
    expect(() => new PairingManager(new DeviceRegistry(), 1_000, 5)).toThrow(/between 6 and 12/);
  });
});
