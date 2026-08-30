import { describe, it, expect, vi } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

describe("Lazy MCP Reconnect Architecture", () => {
  it("should lazily trigger controller.connect() when an observe tool request is received", async () => {
    let connectCalled = 0;

    const mockController: any = {
      isConnected: false,
      session: {
        sessionId: null,
        visualEpoch: 1,
        targetId: null,
      },
      connect: vi.fn().mockImplementation(async () => {
        connectCalled++;
        mockController.isConnected = true;
        mockController.session.sessionId = "session-new-123";
        mockController.session.targetId = "target-123";
      }),
      observe: vi.fn().mockResolvedValue({
        observationId: "obs-lazy-1",
        visualEpoch: 1,
        viewportWidth: 1280,
        viewportHeight: 800,
        imageWidth: 1280,
        imageHeight: 800,
        coordinateSpace: { scaleX: 1, scaleY: 1 },
        image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      }),
    };

    const server = await createMcpServer(mockController);
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    // Call observe while initially disconnected
    const res = await handler({
      method: "tools/call",
      params: {
        name: "observe",
        arguments: {},
      },
    });

    expect(connectCalled).toBe(1);
    expect(mockController.connect).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    const meta = JSON.parse(res.content[0].text);
    expect(meta.observationId).toBe("obs-lazy-1");
  });

  it("should deduplicate concurrent tool calls during lazy connection into a single controller.connect() call", async () => {
    let connectCalled = 0;

    const mockController: any = {
      isConnected: false,
      session: {
        sessionId: null,
        visualEpoch: 1,
        targetId: null,
      },
      connect: vi.fn().mockImplementation(async () => {
        connectCalled++;
        await new Promise((r) => setTimeout(r, 40));
        mockController.isConnected = true;
        mockController.session.sessionId = "session-dedup-1";
      }),
      executeBrowserAction: vi.fn().mockResolvedValue({ id: "act-1", success: true }),
      executeComputerAction: vi.fn().mockResolvedValue({ id: "act-2", success: true }),
    };

    const server = await createMcpServer(mockController);
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    // Dispatch 4 concurrent tool calls while disconnected
    const [r1, r2, r3, r4] = await Promise.all([
      handler({ method: "tools/call", params: { name: "browser_action", arguments: { type: "tabs" } } }),
      handler({ method: "tools/call", params: { name: "browser_action", arguments: { type: "windows" } } }),
      handler({ method: "tools/call", params: { name: "computer_action", arguments: { type: "reset_input" } } }),
      handler({ method: "tools/call", params: { name: "browser_action", arguments: { type: "tabs" } } }),
    ]);

    expect(connectCalled).toBe(1); // Exact single connection initiated
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r3.isError).toBeFalsy();
    expect(r4.isError).toBeFalsy();
  });

  it("should return a formatted MCP error response with troubleshooting advice when lazy connection fails", async () => {
    const mockController: any = {
      isConnected: false,
      session: {
        sessionId: null,
      },
      connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:9222")),
    };

    const server = await createMcpServer(mockController);
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const res = await handler({
      method: "tools/call",
      params: {
        name: "observe",
        arguments: {},
      },
    });

    expect(res.isError).toBe(true);
    const content = JSON.parse(res.content[0].text);
    expect(content.success).toBe(false);
    expect(content.errorCode).toBe("CONNECTION_FAILED");
    expect(content.troubleshooting).toBeDefined();
    expect(content.troubleshooting.length).toBeGreaterThan(0);
  });
});
