import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface DeviceCredential {
  deviceId: string;
  deviceToken: string;
  mcpToken: string;
  name?: string;
}

export interface DeviceIdentity {
  deviceId: string;
  name?: string;
}

interface StoredDevice {
  deviceId: string;
  deviceTokenDigest: Buffer;
  mcpTokenDigest: Buffer;
  name?: string;
  createdAt: number;
  mcpRotatedAt?: number;
  revokedAt?: number;
}

export interface DeviceRegistrySnapshot {
  version: 1;
  devices: Array<{
    deviceId: string;
    deviceTokenDigest: string;
    mcpTokenDigest: string;
    name?: string;
    createdAt: number;
    mcpRotatedAt?: number;
    revokedAt?: number;
  }>;
}

interface PairingRecord {
  code: string;
  expiresAt: number;
  name?: string;
}

type RevocationListener = (deviceId: string) => void;
type ChangeListener = (snapshot: DeviceRegistrySnapshot) => void;

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function matches(candidate: Buffer, expected: Buffer): boolean {
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export class DeviceRegistry {
  private readonly devices = new Map<string, StoredDevice>();
  private readonly revocationListeners = new Set<RevocationListener>();
  private readonly changeListeners = new Set<ChangeListener>();

  constructor(snapshot?: DeviceRegistrySnapshot) {
    if (!snapshot) return;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.devices)) {
      throw new Error("Unsupported browserControl device registry snapshot");
    }
    for (const device of snapshot.devices) {
      if (!device.deviceId || !device.deviceTokenDigest || !device.mcpTokenDigest) continue;
      this.devices.set(device.deviceId, {
        deviceId: device.deviceId,
        deviceTokenDigest: Buffer.from(device.deviceTokenDigest, "base64"),
        mcpTokenDigest: Buffer.from(device.mcpTokenDigest, "base64"),
        name: device.name,
        createdAt: device.createdAt,
        mcpRotatedAt: device.mcpRotatedAt,
        revokedAt: device.revokedAt,
      });
    }
  }

  public issue(name?: string): DeviceCredential {
    const deviceId = randomBytes(12).toString("hex");
    const deviceToken = randomBytes(32).toString("base64url");
    const mcpToken = randomBytes(32).toString("base64url");
    this.devices.set(deviceId, {
      deviceId,
      deviceTokenDigest: digest(deviceToken),
      mcpTokenDigest: digest(mcpToken),
      name,
      createdAt: Date.now(),
    });
    this.emitChanged();
    return { deviceId, deviceToken, mcpToken, name };
  }

  public authenticate(deviceToken: string): DeviceIdentity | null {
    return this.authenticateDevice(deviceToken);
  }

  public authenticateDevice(deviceToken: string): DeviceIdentity | null {
    if (!deviceToken) return null;
    const candidate = digest(deviceToken);
    for (const device of this.devices.values()) {
      if (device.revokedAt || !matches(candidate, device.deviceTokenDigest)) continue;
      return { deviceId: device.deviceId, name: device.name };
    }
    return null;
  }

  public authenticateMcp(mcpToken: string): DeviceIdentity | null {
    if (!mcpToken) return null;
    const candidate = digest(mcpToken);
    for (const device of this.devices.values()) {
      if (device.revokedAt || !matches(candidate, device.mcpTokenDigest)) continue;
      return { deviceId: device.deviceId, name: device.name };
    }
    return null;
  }

  public rotateMcpToken(deviceId: string): { deviceId: string; mcpToken: string } | null {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return null;
    const mcpToken = randomBytes(32).toString("base64url");
    device.mcpTokenDigest = digest(mcpToken);
    device.mcpRotatedAt = Date.now();
    this.emitChanged();
    return { deviceId, mcpToken };
  }

  public revoke(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return false;
    device.revokedAt = Date.now();
    for (const listener of this.revocationListeners) listener(deviceId);
    this.emitChanged();
    return true;
  }

  public onRevoked(listener: RevocationListener): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  public onChanged(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  public list(): Array<{ deviceId: string; name?: string; createdAt: number; mcpRotatedAt?: number; revokedAt?: number }> {
    return [...this.devices.values()].map(({ deviceTokenDigest: _device, mcpTokenDigest: _mcp, ...device }) => ({ ...device }));
  }

  public snapshot(): DeviceRegistrySnapshot {
    return {
      version: 1,
      devices: [...this.devices.values()].map((device) => ({
        deviceId: device.deviceId,
        deviceTokenDigest: device.deviceTokenDigest.toString("base64"),
        mcpTokenDigest: device.mcpTokenDigest.toString("base64"),
        name: device.name,
        createdAt: device.createdAt,
        mcpRotatedAt: device.mcpRotatedAt,
        revokedAt: device.revokedAt,
      })),
    };
  }

  private emitChanged(): void {
    if (this.changeListeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.changeListeners) listener(snapshot);
  }
}

export class PairingManager {
  private readonly pairs = new Map<string, PairingRecord>();

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly ttlMs = 5 * 60_000,
    private readonly codeDigits = 8
  ) {
    if (!Number.isInteger(codeDigits) || codeDigits < 6 || codeDigits > 12) {
      throw new Error("Pairing code length must be between 6 and 12 digits");
    }
  }

  public create(name?: string): { code: string; expiresAt: number } {
    this.prune();
    const upperBound = 10 ** this.codeDigits;
    let code = "";
    do {
      code = String(randomInt(0, upperBound)).padStart(this.codeDigits, "0");
    } while (this.pairs.has(code));
    const expiresAt = Date.now() + this.ttlMs;
    this.pairs.set(code, { code, expiresAt, name });
    return { code, expiresAt };
  }

  public claim(code: string): DeviceCredential | null {
    this.prune();
    const pair = this.pairs.get(code);
    if (!pair) return null;
    this.pairs.delete(code);
    return this.registry.issue(pair.name);
  }

  public get digits(): number {
    return this.codeDigits;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, pair] of this.pairs) {
      if (pair.expiresAt <= now) this.pairs.delete(code);
    }
  }
}
