import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

describe("Live Chrome MCP Stdio Tunnel Protocol Integration", () => {
  let server: TestServer;
  let chrome: LaunchedChrome;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,850" });

    // Spawn real MCP stdio server process through the actual stdio tunnel
    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/mcp/server.ts"],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHROME_CONNECT_MODE: "ws-endpoint",
        CHROME_WS_ENDPOINT: chrome.wsUrl,
      },
    });

    client = new Client({ name: "mcp-stdio-test-client", version: "1.0.0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (transport) await transport.close();
    if (chrome) await chrome.close();
    if (server) await server.close();
  });

  it("1. should discover all advertised tools with complete JSON schemas over stdio tunnel", async () => {
    const listResult = await client.listTools();
    expect(listResult.tools).toBeDefined();
    expect(listResult.tools.length).toBeGreaterThanOrEqual(4);

    const toolNames = listResult.tools.map((t) => t.name);
    expect(toolNames).toContain("observe");
    expect(toolNames).toContain("computer_action");
    expect(toolNames).toContain("browser_action");
    expect(toolNames).toContain("doctor");

    const obsTool = listResult.tools.find((t) => t.name === "observe");
    expect(obsTool?.inputSchema.properties?.format).toBeDefined();
  });

  it("2. should inspect connection status and metrics via doctor tool over stdio tunnel", async () => {
    const docResult = await client.callTool({
      name: "doctor",
      arguments: {},
    });

    expect(docResult.isError).toBeFalsy();
    expect(docResult.content.length).toBeGreaterThan(0);

    const diag = JSON.parse((docResult.content[0] as any).text);
    expect(diag.connected).toBe(true);
    expect(diag.targetId).toBeTruthy();
    expect(diag.visualEpoch).toBeGreaterThan(0);
  });

  it("3. should execute full navigation, observe, click, type & browser actions purely via MCP client", async () => {
    // 1. Navigate to test page using browser_action
    const navResult = await client.callTool({
      name: "browser_action",
      arguments: {
        type: "navigate",
        url: `${server.url}/interactive.html`,
      },
    });
    expect(navResult.isError).toBeFalsy();
    const navData = JSON.parse((navResult.content[0] as any).text);
    expect(navData.success).toBe(true);

    // 2. Capture screenshot observation using observe
    const obsResult = await client.callTool({
      name: "observe",
      arguments: { format: "png", showCursor: true },
    });
    expect(obsResult.isError).toBeFalsy();
    expect(obsResult.content.length).toBe(2);

    const obsMeta = JSON.parse((obsResult.content[0] as any).text);
    expect(obsMeta.observationId).toBeTruthy();
    expect(obsMeta.viewportWidth).toBe(1280);

    const img = obsResult.content[1] as any;
    expect(img.type).toBe("image");
    expect(img.mimeType).toBe("image/png");
    expect(img.data.length).toBeGreaterThan(100);

    // 3. Click button using computer_action
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

    // 4. Type text using computer_action
    const typeResult = await client.callTool({
      name: "computer_action",
      arguments: {
        type: "type",
        text: "Stdio MCP Automation",
      },
    });
    expect(typeResult.isError).toBeFalsy();

    // 5. Query open tabs using browser_action
    const tabsResult = await client.callTool({
      name: "browser_action",
      arguments: { type: "tabs" },
    });
    expect(tabsResult.isError).toBeFalsy();
    const tabsData = JSON.parse((tabsResult.content[0] as any).text);
    expect(tabsData.success).toBe(true);
    expect(tabsData.data.length).toBeGreaterThanOrEqual(1);

    // 6. Query open windows using browser_action
    const winResult = await client.callTool({
      name: "browser_action",
      arguments: { type: "windows" },
    });
    expect(winResult.isError).toBeFalsy();
    const winData = JSON.parse((winResult.content[0] as any).text);
    expect(winData.success).toBe(true);
    expect(winData.data.length).toBeGreaterThanOrEqual(1);
  });
});
