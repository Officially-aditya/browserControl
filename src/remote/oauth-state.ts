import { createHash } from "node:crypto";
import { RedisClient, redisArray, redisString } from "./redis-client.js";

export type OAuthRecordKind =
  | "client"
  | "code"
  | "access"
  | "refresh"
  | "enroll"
  | "approval"
  | "approval_code"
  | "grant"
  | "grant_index"
  | "browser_pair"
  | "browser_pair_code"
  | "browser_access"
  | "browser_refresh"
  | "browser_grant"
  | "browser_grant_index";

export interface OAuthState {
  put<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<void>;
  putIfAbsent<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<boolean>;
  get<T>(kind: OAuthRecordKind, key: string): Promise<T | null>;
  take<T>(kind: OAuthRecordKind, key: string): Promise<T | null>;
  delete(kind: OAuthRecordKind, key: string): Promise<void>;
  close(): Promise<void>;
}

type MemoryRecord = {
  value: string;
  expiresAt: number;
};

type MemoryGrantIndex = {
  grantIds: Set<string>;
  expiresAt: number;
};

function digestKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePrefix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function hasRequiredGrant(kind: OAuthRecordKind, value: unknown): boolean {
  if (
    kind !== "code" &&
    kind !== "access" &&
    kind !== "refresh" &&
    kind !== "browser_access" &&
    kind !== "browser_refresh"
  ) return true;
  return !!value && typeof value === "object" && typeof (value as { grantId?: unknown }).grantId === "string";
}

function isGrantIndex(kind: OAuthRecordKind): boolean {
  return kind === "grant_index" || kind === "browser_grant_index";
}

function grantIdsFromValue(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const grantIds = (value as { grantIds?: unknown }).grantIds;
  if (!Array.isArray(grantIds)) return [];
  return [...new Set(grantIds.filter((item): item is string => typeof item === "string" && item.length <= 160))];
}

export class MemoryOAuthState implements OAuthState {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly grantIndexes = new Map<string, MemoryGrantIndex>();

  public async put<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<void> {
    if (isGrantIndex(kind)) {
      const mapKey = this.key(kind, key);
      const now = Date.now();
      let index = this.grantIndexes.get(mapKey);
      if (!index || index.expiresAt <= now) {
        index = { grantIds: new Set<string>(), expiresAt: now + Math.max(1, ttlMs) };
        this.grantIndexes.set(mapKey, index);
      }
      for (const grantId of grantIdsFromValue(value)) index.grantIds.add(grantId);
      index.expiresAt = now + Math.max(1, ttlMs);
      return;
    }
    this.records.set(this.key(kind, key), {
      value: JSON.stringify(value),
      expiresAt: Date.now() + Math.max(1, ttlMs),
    });
  }

  public async putIfAbsent<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<boolean> {
    if (isGrantIndex(kind)) throw new Error("putIfAbsent is not supported for grant indexes");
    const mapKey = this.key(kind, key);
    const current = this.records.get(mapKey);
    if (current && current.expiresAt > Date.now()) return false;
    this.records.set(mapKey, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + Math.max(1, ttlMs),
    });
    return true;
  }

  public async get<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    if (isGrantIndex(kind)) {
      const mapKey = this.key(kind, key);
      const index = this.grantIndexes.get(mapKey);
      if (!index) return null;
      if (index.expiresAt <= Date.now()) {
        this.grantIndexes.delete(mapKey);
        return null;
      }
      return { grantIds: [...index.grantIds] } as T;
    }
    const mapKey = this.key(kind, key);
    const record = this.records.get(mapKey);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(mapKey);
      return null;
    }
    const parsed = parseJson<T>(record.value);
    if (!hasRequiredGrant(kind, parsed)) return null;
    return parsed;
  }

  public async take<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    if (isGrantIndex(kind)) {
      const value = await this.get<T>(kind, key);
      this.grantIndexes.delete(this.key(kind, key));
      return value;
    }
    const mapKey = this.key(kind, key);
    const record = this.records.get(mapKey);
    this.records.delete(mapKey);
    if (!record || record.expiresAt <= Date.now()) return null;
    const parsed = parseJson<T>(record.value);
    if (!hasRequiredGrant(kind, parsed)) return null;
    return parsed;
  }

  public async delete(kind: OAuthRecordKind, key: string): Promise<void> {
    if (isGrantIndex(kind)) this.grantIndexes.delete(this.key(kind, key));
    else this.records.delete(this.key(kind, key));
  }

  public async close(): Promise<void> {
    this.records.clear();
    this.grantIndexes.clear();
  }

  private key(kind: OAuthRecordKind, key: string): string {
    return `${kind}:${digestKey(key)}`;
  }
}

export interface RedisOAuthStateOptions {
  prefix?: string;
}

export class RedisOAuthState implements OAuthState {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisClient,
    options: RedisOAuthStateOptions = {}
  ) {
    this.prefix = safePrefix(options.prefix || "browsercontrol");
  }

  public static fromUrl(url: string, options: RedisOAuthStateOptions = {}): RedisOAuthState {
    return new RedisOAuthState(new RedisClient(url), options);
  }

  public async put<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<void> {
    if (isGrantIndex(kind)) {
      const redisKey = this.key(kind, key);
      const grantIds = grantIdsFromValue(value);
      if (grantIds.length > 0) {
        await this.redis.command("SADD", redisKey, ...grantIds);
        await this.redis.command("PEXPIRE", redisKey, Math.max(1, ttlMs));
      }
      return;
    }
    await this.redis.command(
      "SET",
      this.key(kind, key),
      JSON.stringify(value),
      "PX",
      Math.max(1, ttlMs)
    );
  }

  public async putIfAbsent<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<boolean> {
    if (isGrantIndex(kind)) throw new Error("putIfAbsent is not supported for grant indexes");
    const result = await this.redis.command(
      "SET",
      this.key(kind, key),
      JSON.stringify(value),
      "NX",
      "PX",
      Math.max(1, ttlMs)
    );
    return result === "OK";
  }

  public async get<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    if (isGrantIndex(kind)) {
      const values = redisArray(await this.redis.command("SMEMBERS", this.key(kind, key)))
        .filter((value): value is string => typeof value === "string");
      return (values.length ? { grantIds: values } : null) as T | null;
    }
    const parsed = parseJson<T>(redisString(await this.redis.command("GET", this.key(kind, key))));
    if (!hasRequiredGrant(kind, parsed)) return null;
    return parsed;
  }

  public async take<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    if (isGrantIndex(kind)) {
      const value = await this.get<T>(kind, key);
      await this.redis.command("DEL", this.key(kind, key));
      return value;
    }
    const parsed = parseJson<T>(redisString(await this.redis.command("GETDEL", this.key(kind, key))));
    if (!hasRequiredGrant(kind, parsed)) return null;
    return parsed;
  }

  public async delete(kind: OAuthRecordKind, key: string): Promise<void> {
    await this.redis.command("DEL", this.key(kind, key));
  }

  public async close(): Promise<void> {
    await this.redis.close();
  }

  private key(kind: OAuthRecordKind, key: string): string {
    return `${this.prefix}:oauth:${kind}:${digestKey(key)}`;
  }
}
