import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ControlLease, type BrowserRoute } from "../browser-control/bridge.js";
import { browserTools, handleBrowserToolCall } from "../browser-control/tools.js";
import { DEFAULT_LOCAL_PORT, startLocalExtensionServer, type LocalExtensionServer } from "./extension-server.js";

function localPortFromEnvironment(): number {
  const raw = process.env.BROWSERCONTROL_LOCAL_PORT;
  if (!raw) return DEFAULT_LOCAL_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BROWSERCONTROL_LOCAL_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export async function runLocalBrowserControl(): Promise<void> {
  const local = await startLocalExtensionServer({ port: localPortFromEnvironment() });
  const route: BrowserRoute = {
    deviceId: "local",
    bridge: local.bridge,
    lease: new ControlLease(60_000),
  };
  const clientId = `local-stdio:${process.pid}`;

  const server = new Server(
    { name: "browser-control-local", version: "0.7.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: browserTools() as any,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as Record<string, any>;
    return handleBrowserToolCall(route, clientId, request.params.name, args) as any;
  });

  let closed = false;
  const closeLocal = async () => {
    if (closed) return;
    closed = true;
    await local.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void closeLocal().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void closeLocal().finally(() => process.exit(0)));
  process.once("exit", () => {
    if (!closed) local.bridge.disconnect(1001, "browserControl local process exited");
  });

  console.error(`[browserControl] Local extension bridge listening on 127.0.0.1:${local.port}`);
  console.error("[browserControl] Waiting for the browserControl Chrome extension; browser traffic stays local.");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLocalBrowserControl().catch((error) => {
    console.error("Fatal browserControl local error:", error);
    process.exit(1);
  });
}
