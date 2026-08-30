import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface DeviceCredential {
  deviceId: string;
  deviceToken: string;
  name?: string;
}

interface StoredDevice {
  deviceId: string;
  tokenDigest: Buffer;
  name?: string;
  createdAt: number;
  revokedAt?: number;
}

interface PairingRecord {
  code: string;
  expiresAt: number;
  name?: string;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class DeviceRegistry {
  private readonly devices = new Map<string, StoredDevice>();

  public issue(name?: string): DeviceCredential {
    const deviceId = randomBytes(12).toString("hex");
    const deviceToken = randomBytes(32).toString("base64url");
    this.devices.set(deviceId, {
      deviceId,
      tokenDigest: digest(deviceToken),
      name,
      createdAt: Date.now(),
    });
    return { deviceId, deviceToken, name };
  }

  public authenticate(deviceToken: string): { deviceId: string; name?: string } | null {
    if (!deviceToken) return null;
    const candidate = digest(deviceToken);
    for (const device of this.devices.values()) {
      if (device.revokedAt || candidate.length !== device.tokenDigest.length) continue;
      if (timingSafeEqual(candidate, device.tokenDigest)) {
        return { deviceId: device.deviceId, name: device.name };
      }
    }
    return null;
  }

  public revoke(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return false;
    device.revokedAt = Date.now();
    return true;
  }

  public list(): Array<{ deviceId: string; name?: string; createdAt: number; revokedAt?: number }> {
    return [...this.devices.values()].map(({ tokenDigest: _tokenDigest, ...device }) => ({ ...device }));
  }
}

export class PairingManager {
  private readonly pairs = new Map<string, PairingRecord>();

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly ttlMs = 5 * 60_000
  ) {}

  public create(name?: string): { code: string; expiresAt: number } {
    this.prune();
    let code = "";
    do {
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
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

  private prune(): void {
    const now = Date.now();
    for (const [code, pair] of this.pairs) {
      if (pair.expiresAt <= now) this.pairs.delete(code);
    }
  }
}
