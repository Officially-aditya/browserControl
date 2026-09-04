import WebSocket from "ws";
import { ControlLease, ExtensionBridge } from "../browser-control/bridge.js";

export { ControlLease, ExtensionBridge } from "../browser-control/bridge.js";

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
