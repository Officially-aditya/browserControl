import { randomUUID } from "node:crypto";
import WebSocket from "ws";

interface ExtensionRpcResponse {
  id: string;
  ok: boolean;
  result?: any;
  error?: { code?: string; message?: string };
}

export class ExtensionBridge {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(public readonly deviceId: string) {}

  private failPending(message: string, code = "DEVICE_OFFLINE"): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(message), { code }));
      this.pending.delete(id);
    }
  }

  public attach(socket: WebSocket): void {
    const previous = this.socket;
    if (previous && previous !== socket) {
      this.failPending("browserControl device reconnected before the previous RPC completed", "DEVICE_RECONNECTED");
    }
    this.socket = socket;
    if (previous && previous !== socket && previous.readyState === WebSocket.OPEN) {
      previous.close(4001, "Replaced by newer browserControl connection for this device");
    }

    socket.on("message", (raw) => {
      let message: ExtensionRpcResponse | { type?: string };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!("id" in message) || !message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new Error(message.error?.message || "Extension RPC failed");
        (error as any).code = message.error?.code || "EXTENSION_RPC_ERROR";
        pending.reject(error);
      }
    });

    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending("browserControl extension disconnected");
    });
  }

  public disconnect(code = 4003, reason = "Device disconnected"): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(code, reason); } catch { socket.terminate(); }
    }
    this.failPending(reason);
  }

  public get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public async call(method: string, params: Record<string, any> = {}, timeoutMs = 30_000): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw Object.assign(new Error(`browserControl device ${this.deviceId} is offline`), { code: "DEVICE_OFFLINE" });
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Extension RPC timed out: ${method}`), { code: "DEVICE_TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export class ControlLease {
  private owner: string | null = null;
  private expiresAt = 0;

  constructor(private readonly ttlMs = 60_000) {}

  public acquire(owner: string): boolean {
    const now = Date.now();
    if (!this.owner || this.owner === owner || now >= this.expiresAt) {
      this.owner = owner;
      this.expiresAt = now + this.ttlMs;
      return true;
    }
    return false;
  }

  public release(owner: string): void {
    if (this.owner !== owner) return;
    this.owner = null;
    this.expiresAt = 0;
  }

  public clear(): void {
    this.owner = null;
    this.expiresAt = 0;
  }

  public status(): { owner: string | null; expiresAt: number } {
    if (this.owner && Date.now() >= this.expiresAt) this.clear();
    return { owner: this.owner, expiresAt: this.expiresAt };
  }
}

export interface DeviceRoute {
  deviceId: string;
  bridge: ExtensionBridge;
  lease: ControlLease;
}

export class DeviceRouter {
  private readonly routes = new Map<string, DeviceRoute>();

  constructor(private readonly leaseTtlMs = 60_000) {}

  public route(deviceId: string): DeviceRoute {
    let route = this.routes.get(deviceId);
    if (!route) {
      route = {
        deviceId,
        bridge: new ExtensionBridge(deviceId),
        lease: new ControlLease(this.leaseTtlMs),
      };
      this.routes.set(deviceId, route);
    }
    return route;
  }

  public attach(deviceId: string, socket: WebSocket): DeviceRoute {
    const route = this.route(deviceId);
    route.bridge.attach(socket);
    return route;
  }

  public disconnect(deviceId: string, code = 4003, reason = "Device credential revoked"): void {
    const route = this.routes.get(deviceId);
    if (!route) return;
    route.lease.clear();
    route.bridge.disconnect(code, reason);
  }

  public isConnected(deviceId: string): boolean {
    return this.routes.get(deviceId)?.bridge.connected ?? false;
  }

  public connectedCount(): number {
    let count = 0;
    for (const route of this.routes.values()) if (route.bridge.connected) count++;
    return count;
  }
}
