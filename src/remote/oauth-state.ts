import { createHash } from "node:crypto";
import { RedisClient, redisString } from "./redis-client.js";

export type OAuthRecordKind = "client" | "code" | "access" | "refresh" | "enroll";

export interface OAuthState {
  put<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<void>;
  get<T>(kind: OAuthRecordKind, key: string): Promise<T | null>;
  take<T>(kind: OAuthRecordKind, key: string): Promise<T | null>;
  delete(kind: OAuthRecordKind, key: string): Promise<void>;
  close(): Promise<void>;
}

type MemoryRecord = {
  value: string;
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

export class MemoryOAuthState implements OAuthState {
  private readonly records = new Map<string, MemoryRecord>();

  public async put<T>(kind: OAuthRecordKind, key: string, value: T, ttlMs: number): Promise<void> {
    this.records.set(this.key(kind, key), {
      value: JSON.stringify(value),
      expiresAt: Date.now() + Math.max(1, ttlMs),
    });
  }

  public async get<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    const mapKey = this.key(kind, key);
    const record = this.records.get(mapKey);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(mapKey);
      return null;
    }
    return parseJson<T>(record.value);
  }

  public async take<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    const mapKey = this.key(kind, key);
    const record = this.records.get(mapKey);
    this.records.delete(mapKey);
    if (!record || record.expiresAt <= Date.now()) return null;
    return parseJson<T>(record.value);
  }

  public async delete(kind: OAuthRecordKind, key: string): Promise<void> {
    this.records.delete(this.key(kind, key));
  }

  public async close(): Promise<void> {
    this.records.clear();
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
    await this.redis.command(
      "SET",
      this.key(kind, key),
      JSON.stringify(value),
      "PX",
      Math.max(1, ttlMs)
    );
  }

  public async get<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    return parseJson<T>(redisString(await this.redis.command("GET", this.key(kind, key))));
  }

  public async take<T>(kind: OAuthRecordKind, key: string): Promise<T | null> {
    return parseJson<T>(redisString(await this.redis.command("GETDEL", this.key(kind, key))));
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
