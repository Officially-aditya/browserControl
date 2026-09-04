import { createBrowserControlMcpServer, browserTools } from "../browser-control/tools.js";
import type { DeviceRoute } from "./device-router.js";

export { browserTools };

export function createDeviceMcpServer(route: DeviceRoute, clientId: string) {
  return createBrowserControlMcpServer(route, clientId, {
    name: "browser-control-remote",
    version: "0.7.0",
  });
}
