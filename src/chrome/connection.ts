import WebSocket from "ws";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, any>;
  sessionId?: string;
}

export interface CDPResponse {
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
  sessionId?: string;
}

export interface CDPEvent {
  method: string;
  params?: any;
  sessionId?: string;
}

export type ConnectionMode = "auto" | "browser-url" | "ws-endpoint";

export interface ChromeConnectionOptions {
  mode?: ConnectionMode;
  host?: string;
  port?: number;
  browserUrl?: string;
  wsEndpoint?: string;
  timeoutMs?: number;
}

export class ChromeConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      method: string;
      timer: NodeJS.Timeout;
    }
  >();
  private options: Required<ChromeConnectionOptions>;
  private isConnected = false;
  private currentWsUrl = "";

  constructor(options: ChromeConnectionOptions = {}) {
    super();
    const mode = options.mode || (options.wsEndpoint ? "ws-endpoint" : options.browserUrl ? "browser-url" : "auto");
    this.options = {
      mode,
      host: options.host || "127.0.0.1",
      port: options.port || 9222,
      browserUrl: options.browserUrl || `http://${options.host || "127.0.0.1"}:${options.port || 9222}`,
      wsEndpoint: options.wsEndpoint || "",
      timeoutMs: options.timeoutMs || 30000,
    };
  }

  public get connected(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public get wsUrl(): string {
    return this.currentWsUrl;
  }

  /**
   * Find DevToolsActivePort files across common OS paths
   */
  private getDevToolsActivePortPaths(): string[] {
    const home = os.homedir();
    const paths: string[] = [];

    if (process.platform === "darwin") {
      paths.push(
        path.join(home, "Library/Application Support/Google/Chrome/DevToolsActivePort"),
        path.join(home, "Library/Application Support/Google/Chrome Canary/DevToolsActivePort"),
        path.join(home, "Library/Application Support/Chromium/DevToolsActivePort"),
        path.join(home, "Library/Application Support/Google/Chrome/Default/DevToolsActivePort")
      );
    } else if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData/Local");
      paths.push(
        path.join(localAppData, "Google/Chrome/User Data/DevToolsActivePort"),
        path.join(localAppData, "Google/Chrome SxS/User Data/DevToolsActivePort"),
        path.join(localAppData, "Chromium/User Data/DevToolsActivePort")
      );
    } else {
      // Linux
      paths.push(
        path.join(home, ".config/google-chrome/DevToolsActivePort"),
        path.join(home, ".config/chromium/DevToolsActivePort"),
        path.join(home, ".config/google-chrome-unstable/DevToolsActivePort")
      );
    }

    return paths;
  }

  /**
   * Try reading DevToolsActivePort file to get direct WebSocket URL
   */
  private async tryReadDevToolsActivePort(): Promise<string | null> {
    const candidatePaths = this.getDevToolsActivePortPaths();
    for (const filePath of candidatePaths) {
      try {
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.trim().split("\n").map((l) => l.trim());
        if (lines.length >= 2) {
          const port = parseInt(lines[0], 10);
          const browserPath = lines[1];
          if (!isNaN(port) && browserPath) {
            const wsUrl = `ws://127.0.0.1:${port}${browserPath.startsWith("/") ? "" : "/"}${browserPath}`;
            return wsUrl;
          }
        }
      } catch {
        // Continue searching other candidate paths
      }
    }
    return null;
  }

  /**
   * Probe standard HTTP debugging URL to get webSocketDebuggerUrl
   */
  private async probeBrowserUrl(baseUrl: string): Promise<string | null> {
    const url = baseUrl.replace(/\/$/, "");
    const versionUrl = `${url}/json/version`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) {
          return data.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Endpoint not responding
    }
    return null;
  }

  /**
   * Discover WebSocket URL according to connection mode
   */
  public async discoverWebSocketUrl(): Promise<string> {
    if (this.options.mode === "ws-endpoint") {
      if (!this.options.wsEndpoint) {
        throw new Error("Mode 'ws-endpoint' selected but no wsEndpoint URL provided");
      }
      return this.options.wsEndpoint;
    }

    if (this.options.mode === "browser-url") {
      const wsUrl = await this.probeBrowserUrl(this.options.browserUrl);
      if (wsUrl) return wsUrl;
      throw new Error(
        `Could not discover debugging endpoint at ${this.options.browserUrl}. Ensure Chrome is running with remote debugging enabled.`
      );
    }

    // mode === "auto"
    // 1. Try DevToolsActivePort file (modern Chrome 144+ active debugging / chrome://inspect)
    const activePortWs = await this.tryReadDevToolsActivePort();
    if (activePortWs) {
      return activePortWs;
    }

    // 2. Probe standard ports
    const portsToProbe = [this.options.port, 9222, 9223, 9229, 9224];
    const uniquePorts = Array.from(new Set(portsToProbe));

    for (const p of uniquePorts) {
      const wsUrl = await this.probeBrowserUrl(`http://${this.options.host}:${p}`);
      if (wsUrl) {
        return wsUrl;
      }
    }

    throw new Error(
      `Could not discover Chrome remote debugging endpoint.\n` +
      `Troubleshooting steps:\n` +
      `1. If Chrome is running, open chrome://inspect/#remote-debugging in Chrome and ensure remote debugging is enabled and target is approved.\n` +
      `2. Or launch Chrome with: --remote-debugging-port=9222\n` +
      `3. Or pass explicit endpoint with --browser-url http://127.0.0.1:9222 or --ws-endpoint ws://...`
    );
  }

  /**
   * Connect to Chrome via WebSocket
   */
  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const wsUrl = await this.discoverWebSocketUrl();
    this.currentWsUrl = wsUrl;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        const connectionTimeout = setTimeout(() => {
          if (!this.isConnected) {
            this.ws?.terminate();
            reject(new Error(`WebSocket connection timeout to ${wsUrl}`));
          }
        }, this.options.timeoutMs);

        this.ws.on("open", () => {
          clearTimeout(connectionTimeout);
          this.isConnected = true;
          this.emit("open");
          resolve();
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
          this.handleMessage(data.toString());
        });

        this.ws.on("error", (err: Error) => {
          this.emit("error", err);
          if (!this.isConnected) {
            clearTimeout(connectionTimeout);
            if (err.message.includes("403") || err.message.includes("approval")) {
              reject(new Error("Connection approval denied by Chrome user"));
            } else {
              reject(err);
            }
          }
        });

        this.ws.on("close", (code: number, reason: Buffer) => {
          this.isConnected = false;
          const reasonStr = reason.toString();
          this.emit("close", { code, reason: reasonStr });
          this.cleanupPendingRequests(new Error(`WebSocket closed: ${code} ${reasonStr}`));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a CDP command and wait for response
   */
  public async send<T = any>(
    method: string,
    params?: Record<string, any>,
    sessionId?: string
  ): Promise<T> {
    if (!this.connected || !this.ws) {
      throw new Error("Chrome connection is not open");
    }

    const id = this.nextId++;
    const message: CDPRequest = {
      id,
      method,
      params,
    };

    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`CDP command '${method}' (id: ${id}) timed out after ${this.options.timeoutMs}ms`));
        }
      }, this.options.timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        method,
        timer,
      });

      this.ws!.send(JSON.stringify(message), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to send CDP message '${method}': ${err.message}`));
        }
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          pending.reject(
            new Error(
              `CDP error in '${pending.method}': ${msg.error.message} (code: ${msg.error.code})${
                msg.error.data ? ` - ${msg.error.data}` : ""
              }`
            )
          );
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method) {
      const event: CDPEvent = {
        method: msg.method,
        params: msg.params,
        sessionId: msg.sessionId,
      };

      this.emit("event", event);
      this.emit(msg.method, msg.params, msg.sessionId);
      if (msg.sessionId) {
        this.emit(`session:${msg.sessionId}:${msg.method}`, msg.params);
      }
    }
  }

  private cleanupPendingRequests(err: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  public async close(): Promise<void> {
    if (this.ws) {
      this.isConnected = false;
      this.cleanupPendingRequests(new Error("Connection closed explicitly"));
      this.ws.close();
      this.ws = null;
    }
  }
}
