import { describe, expect, it, vi } from "vitest";
import { DeviceRegistry, PairingManager } from "../../src/remote/device-auth.js";

describe("remote device authentication", () => {
  it("issues opaque credentials without exposing token digests", () => {
    const registry = new DeviceRegistry();
    const issued = registry.issue("Laptop Chrome");

    expect(issued.deviceId).toMatch(/^[a-f0-9]{24}$/);
    expect(issued.deviceToken.length).toBeGreaterThan(30);
    expect(registry.authenticate(issued.deviceToken)).toEqual({ deviceId: issued.deviceId, name: "Laptop Chrome" });
    expect(JSON.stringify(registry.list())).not.toContain(issued.deviceToken);
  });

  it("revokes a device token immediately and emits a revocation event", () => {
    const registry = new DeviceRegistry();
    const issued = registry.issue();
    const revoked: string[] = [];
    const unsubscribe = registry.onRevoked((deviceId) => revoked.push(deviceId));

    expect(registry.authenticate(issued.deviceToken)?.deviceId).toBe(issued.deviceId);
    expect(registry.revoke(issued.deviceId)).toBe(true);
    expect(registry.authenticate(issued.deviceToken)).toBeNull();
    expect(revoked).toEqual([issued.deviceId]);
    expect(registry.revoke(issued.deviceId)).toBe(false);

    unsubscribe();
  });

  it("uses eight-digit one-time pairing codes by default", () => {
    const registry = new DeviceRegistry();
    const pairing = new PairingManager(registry);
    const { code } = pairing.create("Desktop");

    expect(pairing.digits).toBe(8);
    expect(code).toMatch(/^\d{8}$/);
    const credential = pairing.claim(code);
    expect(credential?.name).toBe("Desktop");
    expect(credential && registry.authenticate(credential.deviceToken)?.deviceId).toBe(credential?.deviceId);
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
