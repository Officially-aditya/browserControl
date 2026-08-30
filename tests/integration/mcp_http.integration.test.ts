import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { runHttpMcpServer } from "../../src/mcp/http-server.js";
import http from "node:http";

describe("Live Chrome MCP Streamable HTTP Protocol Integration", () => {
  let server: TestServer;
  let chrome: LaunchedChrome;
  let mcpHttp: { server: http.Server; transports: Record<string, any>; authToken: string };
  let mcpPort: number;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,850" });

    // Set Chrome environment variables and start HTTP server process/tunnel
    process.env.CHROME_CONNECT_MODE = "ws-endpoint";
    process.env.CHROME_WS_ENDPOINT = chrome.wsUrl;

    mcpHttp = await runHttpMcpServer(0, "127.0.0.1", undefined, {
      authToken: "protocol-tunnel-token-777",
    });
    mcpPort = (mcpHttp.server.address() as any).port;
  }, 30000);

  afterAll(async () => {
    if (mcpHttp?.transports) {
      for (const sid of Object.keys(mcpHttp.transports)) {
        try {
          await mcpHttp.transports[sid].close();
        } catch {}
      }
    }
    if (mcpHttp?.server) {
      await new Promise<void>((resolve) => mcpHttp.server.close(() => resolve()));
    }
    if (chrome) await chrome.close();
    if (server) await server.close();
    delete process.env.CHROME_CONNECT_MODE;
    delete process.env.CHROME_WS_ENDPOINT;
  });

  function createClientTransport(token = mcpHttp.authToken): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
  }

  it("1. should connect official MCP client over Streamable HTTP and list tools with full schemas", async () => {
    const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
    const transport = createClientTransport();

    try {
      await client.connect(transport);

      const toolsResult = await client.listTools();
      expect(toolsResult.tools).toBeDefined();
      expect(toolsResult.tools.length).toBeGreaterThanOrEqual(4);

      const toolNames = toolsResult.tools.map((t) => t.name);
      expect(toolNames).toContain("observe");
      expect(toolNames).toContain("computer_action");
      expect(toolNames).toContain("browser_action");
      expect(toolNames).toContain("doctor");

      // Verify complete input schemas exist
      const observeTool = toolsResult.tools.find((t) => t.name === "observe");
      expect(observeTool?.inputSchema.properties?.format).toBeDefined();

      const actionTool = toolsResult.tools.find((t) => t.name === "computer_action");
      expect(actionTool?.inputSchema.properties?.type).toBeDefined();
      expect(actionTool?.inputSchema.properties?.observationId).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("2. should call doctor and observe tools over Streamable HTTP transport", async () => {
    const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
    const transport = createClientTransport();

    try {
      await client.connect(transport);

      // 1. Call doctor tool
      const docResult = await client.callTool({
        name: "doctor",
        arguments: {},
      });
      expect(docResult.isError).toBeFalsy();
      expect(docResult.content.length).toBeGreaterThan(0);
      const docContent = JSON.parse((docResult.content[0] as any).text);
      expect(docContent.connected).toBe(true);
      expect(docContent.visualEpoch).toBeGreaterThan(0);

      // 2. Call observe tool
      const obsResult = await client.callTool({
        name: "observe",
        arguments: { format: "png", showCursor: true },
      });
      expect(obsResult.isError).toBeFalsy();
      expect(obsResult.content.length).toBe(2);

      // Content item 0: JSON metadata
      const obsMeta = JSON.parse((obsResult.content[0] as any).text);
      expect(obsMeta.observationId).toBeTruthy();
      expect(obsMeta.viewportWidth).toBe(1280);

      // Content item 1: Base64 image
      const imgItem = obsResult.content[1] as any;
      expect(imgItem.type).toBe("image");
      expect(imgItem.mimeType).toBe("image/png");
      expect(imgItem.data.length).toBeGreaterThan(100);
    } finally {
      await client.close();
    }
  });

  it("3. should execute computer_action and browser_action tools purely through MCP client", async () => {
    const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
    const transport = createClientTransport();

    try {
      await client.connect(transport);

      // 1. Navigate via MCP browser_action tool
      const navRes = await client.callTool({
        name: "browser_action",
        arguments: {
          type: "navigate",
          url: `${server.url}/interactive.html`,
        },
      });
      expect(navRes.isError).toBeFalsy();

      // 2. Capture observation via MCP observe tool
      const obsResult = await client.callTool({
        name: "observe",
        arguments: { format: "png" },
      });
      const obsMeta = JSON.parse((obsResult.content[0] as any).text);

      // 3. Click button via MCP computer_action tool
      const clickResult = await client.callTool({
        name: "computer_action",
        arguments: {
          type: "click",
          observationId: obsMeta.observationId,
          x: 100,
          y: 100,
          button: "left",
        },
      });
      expect(clickResult.isError).toBeFalsy();
      const clickData = JSON.parse((clickResult.content[0] as any).text);
      expect(clickData.success).toBe(true);

      // 4. Type text via MCP computer_action tool
      const typeResult = await client.callTool({
        name: "computer_action",
        arguments: {
          type: "type",
          text: "Streamable HTTP Client Test",
        },
      });
      expect(typeResult.isError).toBeFalsy();

      // 5. List tabs via MCP browser_action tool
      const tabsResult = await client.callTool({
        name: "browser_action",
        arguments: {
          type: "tabs",
        },
      });
      expect(tabsResult.isError).toBeFalsy();
      const tabsData = JSON.parse((tabsResult.content[0] as any).text);
      expect(tabsData.success).toBe(true);
      expect(tabsData.data.length).toBeGreaterThanOrEqual(1);

      // 6. List windows via MCP browser_action tool
      const winResult = await client.callTool({
        name: "browser_action",
        arguments: {
          type: "windows",
        },
      });
      expect(winResult.isError).toBeFalsy();
      const winData = JSON.parse((winResult.content[0] as any).text);
      expect(winData.success).toBe(true);
      expect(winData.data.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
    }
  });

  it("4. should reject unauthenticated clients and accept valid Bearer token", async () => {
    // 1. Connection attempt with invalid token must fail
    const unauthClient = new Client({ name: "unauth-client", version: "1.0.0" });
    const unauthTransport = createClientTransport("invalid-fake-token");

    await expect(unauthClient.connect(unauthTransport)).rejects.toThrow();

    // 2. Connection attempt with valid Bearer token must succeed
    const authClient = new Client({ name: "auth-client", version: "1.0.0" });
    const authTransport = createClientTransport();

    await authClient.connect(authTransport);
    const tools = await authClient.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(4);
    await authClient.close();
  });
});
