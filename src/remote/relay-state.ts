import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  DeviceRegistry,
  PairingManager,
  type DeviceCredential,
  type DeviceIdentity,
} from "./device-auth.js";
import { RedisClient, redisArray, redisNumber, redisString } from "./redis-client.js";

export interface RelayDeviceRecord extends DeviceIdentity {
  createdAt: number;
  mcpRotatedAt?: number;
  revokedAt?: number;
}

export interface RelayPresence {
  deviceId: string;
  replicaId: string;
  internalUrl: string;
  connectionId: string;
  expiresAt: number;
}

export interface RelayRateLimit {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RelayState {
  readonly pairingDigits: number;
  createPairing(name?: string, ttlMs?: number): Promise<{ code: string; expiresAt: number }>;
  claimPairing(code: string): Promise<DeviceCredential | null>;
  authenticateDevice(token: string): Promise<DeviceIdentity | null>;
  authenticateMcp(token: string): Promise<DeviceIdentity | null>;
  rotateMcpToken(deviceId: string): Promise<{ deviceId: string; mcpToken: string } | null>;
  revoke(deviceId: string): Promise<boolean>;
  listDevices(): Promise<RelayDeviceRecord[]>;
  getDevice(deviceId: string): Promise<RelayDeviceRecord | null>;
  setPresence(presence: RelayPresence, ttlMs: number): Promise<void>;
  refreshPresence(presence: RelayPresence, ttlMs: number): Promise<boolean>;
  clearPresence(deviceId: string, connectionId: string): Promise<void>;
  getPresence(deviceId: string): Promise<RelayPresence | null>;
  consumeRateLimit(bucket: string, key: string, limit: number, windowMs: number): Promise<RelayRateLimit>;
  close(): Promise<void>;
}

type MemoryPresence = RelayPresence;

type MemoryRate = { startedAt: number; count: number };

export class MemoryRelayState implements RelayState {
  public readonly pairingDigits: number;
  private readonly presence = new Map<string, MemoryPresence>();
  private readonly rates = new Map<string, MemoryRate>();

  constructor(
    public readonly registry = new DeviceRegistry(),
    public readonly pairing = new PairingManager(registry)
  ) {
    this.pairingDigits = pairing.digits;
  }

  public async createPairing(name?: string): Promise<{ code: string; expiresAt: number }> {
    return this.pairing.create(name);
  }

  public async claimPairing(code: string): Promise<DeviceCredential | null> {
    return this.pairing.claim(code);
  }

  public async authenticateDevice(token: string): Promise<DeviceIdentity | null> {
    return this.registry.authenticateDevice(token);
  }

  public async authenticateMcp(token: string): Promise<DeviceIdentity | null> {
    return this.registry.authenticateMcp(token);
  }

  public async rotateMcpToken(deviceId: string): Promise<{ deviceId: string; mcpToken: string } | null> {
    return this.registry.rotateMcpToken(deviceId);
  }

  public async revoke(deviceId: string): Promise<boolean> {
    return this.registry.revoke(deviceId);
  }

  public async listDevices(): Promise<RelayDeviceRecord[]> {
    return this.registry.list();
  }

  public async getDevice(deviceId: string): Promise<RelayDeviceRecord | null> {
    return this.registry.list().find((device) => device.deviceId === deviceId) ?? null;
  }

  public async setPresence(presence: RelayPresence, ttlMs: number): Promise<void> {
    this.presence.set(presence.deviceId, { ...presence, expiresAt: Date.now() + ttlMs });
  }

  public async refreshPresence(presence: RelayPresence, ttlMs: number): Promise<boolean> {
    const current = this.getMemoryPresence(presence.deviceId);
    if (current && current.connectionId !== presence.connectionId) return false;
    this.presence.set(presence.deviceId, { ...presence, expiresAt: Date.now() + ttlMs });
    return true;
  }

  public async clearPresence(deviceId: string, connectionId: string): Promise<void> {
    const current = this.getMemoryPresence(deviceId);
    if (current?.connectionId === connectionId) this.presence.delete(deviceId);
  }

  public async getPresence(deviceId: string): Promise<RelayPresence | null> {
    return this.getMemoryPresence(deviceId);
  }

  public async consumeRateLimit(bucket: string, key: string, limit: number, windowMs: number): Promise<RelayRateLimit> {
    const now = Date.now();
    const mapKey = `${bucket}:${key}`;
    const current = this.rates.get(mapKey);
    if (!current || now - current.startedAt >= windowMs) {
      this.rates.set(mapKey, { startedAt: now, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (current.count >= limit) {
      return { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - current.startedAt)) };
    }
    current.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  public async close(): Promise<void> {}

  private getMemoryPresence(deviceId: string): MemoryPresence | null {
    const current = this.presence.get(deviceId);
    if (!current) return null;
    if (current.expiresAt <= Date.now()) {
      this.presence.delete(deviceId);
      return null;
    }
    return current;
  }
}

type StoredRedisDevice = RelayDeviceRecord & {
  deviceTokenDigest: string;
  mcpTokenDigest: string;
};

type PairingRecord = { name?: string; expiresAt: number };

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

export interface RedisRelayStateOptions {
  prefix?: string;
  pairingDigits?: number;
  pairingTtlMs?: number;
}

export class RedisRelayState implements RelayState {
  public readonly pairingDigits: number;
  private readonly pairingTtlMs: number;
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisClient,
    options: RedisRelayStateOptions = {}
  ) {
    this.prefix = safeKey(options.prefix || "browsercontrol");
    this.pairingDigits = options.pairingDigits ?? 8;
    this.pairingTtlMs = options.pairingTtlMs ?? 5 * 60_000;
    if (!Number.isInteger(this.pairingDigits) || this.pairingDigits < 6 || this.pairingDigits > 12) {
      throw new Error("Pairing code length must be between 6 and 12 digits");
    }
  }

  public static fromUrl(url: string, options: RedisRelayStateOptions = {}): RedisRelayState {
    return new RedisRelayState(new RedisClient(url), options);
  }

  public async createPairing(name?: string, ttlMs = this.pairingTtlMs): Promise<{ code: string; expiresAt: number }> {
    const upperBound = 10 ** this.pairingDigits;
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = String(randomInt(0, upperBound)).padStart(this.pairingDigits, "0");
      const expiresAt = Date.now() + ttlMs;
      const value = JSON.stringify({ name, expiresAt } satisfies PairingRecord);
      const created = await this.redis.command("SET", this.pairingKey(code), value, "NX", "PX", ttlMs);
      if (created === "OK") return { code, expiresAt };
    }
    throw new Error("Could not allocate a unique browserControl pairing code");
  }

  public async claimPairing(code: string): Promise<DeviceCredential | null> {
    const raw = redisString(await this.redis.command("GETDEL", this.pairingKey(code)));
    const pair = parseJson<PairingRecord>(raw);
    if (!pair || pair.expiresAt <= Date.now()) return null;
    return this.issueDevice(pair.name);
  }

  public async authenticateDevice(token: string): Promise<DeviceIdentity | null> {
    if (!token) return null;
    return parseJson<DeviceIdentity>(redisString(await this.redis.command("GET", this.deviceTokenKey(tokenDigest(token)))));
  }

  public async authenticateMcp(token: string): Promise<DeviceIdentity | null> {
    if (!token) return null;
    return parseJson<DeviceIdentity>(redisString(await this.redis.command("GET", this.mcpTokenKey(tokenDigest(token)))));
  }

  public async rotateMcpToken(deviceId: string): Promise<{ deviceId: string; mcpToken: string } | null> {
    const mcpToken = randomBytes(32).toString("base64url");
    const newDigest = tokenDigest(mcpToken);
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local device = cjson.decode(raw)
      if device.revokedAt then return 0 end
      redis.call('DEL', ARGV[1] .. device.mcpTokenDigest)
      device.mcpTokenDigest = ARGV[2]
      device.mcpRotatedAt = tonumber(ARGV[3])
      redis.call('SET', KEYS[1], cjson.encode(device))
      redis.call('SET', ARGV[1] .. ARGV[2], cjson.encode({deviceId=device.deviceId,name=device.name}))
      return 1
    `;
    const changed = redisNumber(await this.redis.command(
      "EVAL", script, 1, this.deviceKey(deviceId), `${this.prefix}:mcp:`, newDigest, Date.now()
    ));
    return changed === 1 ? { deviceId, mcpToken } : null;
  }

  public async revoke(deviceId: string): Promise<boolean> {
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local device = cjson.decode(raw)
      if device.revokedAt then return 0 end
      device.revokedAt = tonumber(ARGV[3])
      redis.call('DEL', ARGV[1] .. device.deviceTokenDigest)
      redis.call('DEL', ARGV[2] .. device.mcpTokenDigest)
      redis.call('SET', KEYS[1], cjson.encode(device))
      return 1
    `;
    const changed = redisNumber(await this.redis.command(
      "EVAL", script, 1, this.deviceKey(deviceId), `${this.prefix}:device-token:`, `${this.prefix}:mcp:`, Date.now()
    ));
    return changed === 1;
  }

  public async listDevices(): Promise<RelayDeviceRecord[]> {
    const ids = redisArray(await this.redis.command("SMEMBERS", this.devicesKey())).filter((value): value is string => typeof value === "string");
    if (ids.length === 0) return [];
    const values = redisArray(await this.redis.command("MGET", ...ids.map((id) => this.deviceKey(id))));
    return values
      .map((value) => parseJson<StoredRedisDevice>(typeof value === "string" ? value : null))
      .filter((device): device is StoredRedisDevice => !!device)
      .map(({ deviceTokenDigest: _device, mcpTokenDigest: _mcp, ...device }) => device);
  }

  public async getDevice(deviceId: string): Promise<RelayDeviceRecord | null> {
    const device = parseJson<StoredRedisDevice>(redisString(await this.redis.command("GET", this.deviceKey(deviceId))));
    if (!device) return null;
    const { deviceTokenDigest: _device, mcpTokenDigest: _mcp, ...record } = device;
    return record;
  }

  public async setPresence(presence: RelayPresence, ttlMs: number): Promise<void> {
    const value = JSON.stringify({ ...presence, expiresAt: Date.now() + ttlMs });
    await this.redis.command("SET", this.presenceKey(presence.deviceId), value, "PX", ttlMs);
  }

  public async refreshPresence(presence: RelayPresence, ttlMs: number): Promise<boolean> {
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if raw then
        local current = cjson.decode(raw)
        if current.connectionId ~= ARGV[1] then return 0 end
      end
      local next = cjson.decode(ARGV[2])
      next.expiresAt = tonumber(ARGV[3])
      redis.call('SET', KEYS[1], cjson.encode(next), 'PX', ARGV[4])
      return 1
    `;
    const now = Date.now();
    const refreshed = redisNumber(await this.redis.command(
      "EVAL", script, 1, this.presenceKey(presence.deviceId), presence.connectionId,
      JSON.stringify(presence), now + ttlMs, ttlMs
    ));
    return refreshed === 1;
  }

  public async clearPresence(deviceId: string, connectionId: string): Promise<void> {
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local current = cjson.decode(raw)
      if current.connectionId ~= ARGV[1] then return 0 end
      return redis.call('DEL', KEYS[1])
    `;
    await this.redis.command("EVAL", script, 1, this.presenceKey(deviceId), connectionId);
  }

  public async getPresence(deviceId: string): Promise<RelayPresence | null> {
    return parseJson<RelayPresence>(redisString(await this.redis.command("GET", this.presenceKey(deviceId))));
  }

  public async consumeRateLimit(bucket: string, key: string, limit: number, windowMs: number): Promise<RelayRateLimit> {
    const rateKey = `${this.prefix}:rate:${safeKey(bucket)}:${tokenDigest(key).slice(0, 32)}`;
    const script = `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
      local ttl = redis.call('PTTL', KEYS[1])
      return {count, ttl}
    `;
    const result = redisArray(await this.redis.command("EVAL", script, 1, rateKey, windowMs));
    const count = redisNumber(result[0] ?? 0);
    const ttl = Math.max(1, redisNumber(result[1] ?? windowMs));
    return { allowed: count <= limit, retryAfterMs: count <= limit ? 0 : ttl };
  }

  public async close(): Promise<void> {
    await this.redis.close();
  }

  private async issueDevice(name?: string): Promise<DeviceCredential> {
    const deviceId = randomBytes(12).toString("hex");
    const deviceToken = randomBytes(32).toString("base64url");
    const mcpToken = randomBytes(32).toString("base64url");
    const deviceTokenDigest = tokenDigest(deviceToken);
    const mcpTokenDigest = tokenDigest(mcpToken);
    const createdAt = Date.now();
    const stored: StoredRedisDevice = { deviceId, name, createdAt, deviceTokenDigest, mcpTokenDigest };
    const identity = JSON.stringify({ deviceId, name } satisfies DeviceIdentity);
    const script = `
      redis.call('SET', KEYS[1], ARGV[1])
      redis.call('SET', KEYS[2], ARGV[2])
      redis.call('SET', KEYS[3], ARGV[2])
      redis.call('SADD', KEYS[4], ARGV[3])
      return 1
    `;
    await this.redis.command(
      "EVAL", script, 4,
      this.deviceKey(deviceId), this.deviceTokenKey(deviceTokenDigest), this.mcpTokenKey(mcpTokenDigest), this.devicesKey(),
      JSON.stringify(stored), identity, deviceId
    );
    return { deviceId, deviceToken, mcpToken, name };
  }

  private pairingKey(code: string): string { return `${this.prefix}:pair:${code}`; }
  private deviceKey(deviceId: string): string { return `${this.prefix}:device:${deviceId}`; }
  private deviceTokenKey(digest: string): string { return `${this.prefix}:device-token:${digest}`; }
  private mcpTokenKey(digest: string): string { return `${this.prefix}:mcp:${digest}`; }
  private devicesKey(): string { return `${this.prefix}:devices`; }
  private presenceKey(deviceId: string): string { return `${this.prefix}:presence:${deviceId}`; }
}
