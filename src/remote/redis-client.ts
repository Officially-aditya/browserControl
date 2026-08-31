import net from "node:net";
import tls from "node:tls";

export type RedisValue = string | number | null | RedisValue[];

type PendingCommand = {
  resolve: (value: RedisValue) => void;
  reject: (error: Error) => void;
};

function encodeCommand(parts: Array<string | number>): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const value = Buffer.from(String(part));
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

type Parsed = { value: RedisValue | Error; next: number };

function findCrlf(buffer: Buffer, start: number): number {
  for (let i = start; i + 1 < buffer.length; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
  }
  return -1;
}

function parseResp(buffer: Buffer, offset = 0): Parsed | null {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]);
  const lineEnd = findCrlf(buffer, offset + 1);
  if (lineEnd < 0) return null;
  const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
  const afterLine = lineEnd + 2;

  if (prefix === "+") return { value: line, next: afterLine };
  if (prefix === "-") return { value: new Error(line), next: afterLine };
  if (prefix === ":") return { value: Number(line), next: afterLine };

  if (prefix === "$") {
    const length = Number(line);
    if (length === -1) return { value: null, next: afterLine };
    if (!Number.isInteger(length) || length < 0) return { value: new Error(`Invalid Redis bulk length: ${line}`), next: afterLine };
    const end = afterLine + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.subarray(afterLine, end).toString("utf8"), next: end + 2 };
  }

  if (prefix === "*") {
    const count = Number(line);
    if (count === -1) return { value: null, next: afterLine };
    if (!Number.isInteger(count) || count < 0) return { value: new Error(`Invalid Redis array length: ${line}`), next: afterLine };
    const values: RedisValue[] = [];
    let cursor = afterLine;
    for (let i = 0; i < count; i++) {
      const parsed = parseResp(buffer, cursor);
      if (!parsed) return null;
      if (parsed.value instanceof Error) return { value: parsed.value, next: parsed.next };
      values.push(parsed.value);
      cursor = parsed.next;
    }
    return { value: values, next: cursor };
  }

  return { value: new Error(`Unsupported Redis response prefix: ${prefix}`), next: afterLine };
}

export interface RedisClientOptions {
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export class RedisClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private connecting: Promise<void> | null = null;
  private incoming: Buffer = Buffer.alloc(0);
  private readonly pending: PendingCommand[] = [];
  private closed = false;
  private readonly url: URL;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(url: string, options: RedisClientOptions = {}) {
    this.url = new URL(url);
    if (!['redis:', 'rediss:'].includes(this.url.protocol)) throw new Error("Redis URL must use redis:// or rediss://");
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  }

  public async command(...parts: Array<string | number>): Promise<RedisValue> {
    if (this.closed) throw new Error("Redis client is closed");
    await this.ensureConnected();
    return this.writeCommand(parts);
  }

  public async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 250);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const host = this.url.hostname;
    const secure = this.url.protocol === "rediss:";
    const port = Number(this.url.port || (secure ? 6380 : 6379));
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    try {
      await new Promise<void>((resolve, reject) => {
        const readyEvent = secure ? "secureConnect" : "connect";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`Timed out connecting to Redis at ${host}:${port}`));
        }, this.connectTimeoutMs);
        const onError = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        socket.once("error", onError);
        socket.once(readyEvent, () => {
          clearTimeout(timer);
          socket.off("error", onError);
          resolve();
        });
      });

      this.socket = socket;
      this.incoming = Buffer.alloc(0);
      socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
      socket.on("error", (error) => this.onSocketFailure(error));
      socket.on("close", () => this.onSocketFailure(new Error("Redis connection closed")));

      const password = decodeURIComponent(this.url.password || "");
      const username = decodeURIComponent(this.url.username || "");
      if (password) {
        const auth = username ? await this.writeCommand(["AUTH", username, password]) : await this.writeCommand(["AUTH", password]);
        if (auth !== "OK") throw new Error("Redis AUTH failed");
      }

      const dbText = this.url.pathname.replace(/^\//, "");
      if (dbText) {
        const db = Number(dbText);
        if (!Number.isInteger(db) || db < 0) throw new Error(`Invalid Redis database index: ${dbText}`);
        const selected = await this.writeCommand(["SELECT", db]);
        if (selected !== "OK") throw new Error(`Redis SELECT ${db} failed`);
      }
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      socket.destroy();
      throw error;
    }
  }

  private writeCommand(parts: Array<string | number>): Promise<RedisValue> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("Redis socket is not connected"));
    return new Promise<RedisValue>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Redis command timed out: ${parts[0]}`));
        socket.destroy(new Error(`Redis command timed out: ${parts[0]}`));
      }, this.commandTimeoutMs);

      const wrappedResolve = (value: RedisValue) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      this.pending.push({ resolve: wrappedResolve, reject: wrappedReject });
      socket.write(encodeCommand(parts));
    });
  }

  private onData(chunk: Buffer): void {
    this.incoming = this.incoming.length ? Buffer.concat([this.incoming, chunk]) : chunk;
    let offset = 0;
    while (this.pending.length > 0) {
      const parsed = parseResp(this.incoming, offset);
      if (!parsed) break;
      offset = parsed.next;
      const pending = this.pending.shift()!;
      if (parsed.value instanceof Error) pending.reject(parsed.value);
      else pending.resolve(parsed.value);
    }
    if (offset > 0) this.incoming = this.incoming.subarray(offset);
  }

  private onSocketFailure(error: Error): void {
    if (!this.socket && this.pending.length === 0) return;
    this.socket = null;
    this.incoming = Buffer.alloc(0);
    while (this.pending.length) this.pending.shift()!.reject(error);
  }
}

export function redisString(value: RedisValue): string | null {
  return typeof value === "string" ? value : null;
}

export function redisNumber(value: RedisValue): number {
  return typeof value === "number" ? value : Number(value);
}

export function redisArray(value: RedisValue): RedisValue[] {
  return Array.isArray(value) ? value : [];
}
