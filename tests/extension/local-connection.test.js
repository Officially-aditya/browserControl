import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalConnection } from "../../extension/local-connection.js";

describe("local extension connection", () => {
  let sockets;
  let connection;
  let handleRpc;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = 0;
      send = vi.fn();
      close = vi.fn();
      constructor() { sockets.push(this); }
      open() { this.readyState = 1; this.onopen(); }
      receive(message) { return this.onmessage({ data: JSON.stringify(message) }); }
      closed(code) { this.readyState = 3; this.onclose({ code }); }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("chrome", {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
      alarms: { onAlarm: { addListener: vi.fn() }, create: vi.fn(), clear: vi.fn() },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ challenge: "one-use-challenge" }),
    })));
    handleRpc = vi.fn(async () => ({ success: true }));
    connection = createLocalConnection({ handleRpc, onStateChange: vi.fn() });
  });

  afterEach(() => {
    connection.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function connectedSocket() {
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    return sockets[0];
  }

  it("asks the agent to stop, waits for confirmation, and discovers the next agent", async () => {
    const socket = await connectedSocket();
    const disconnected = connection.disconnect();
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "disconnect" }));
    expect(socket.close).not.toHaveBeenCalled();
    await socket.receive({ id: "late", method: "click" });
    expect(handleRpc).not.toHaveBeenCalled();

    socket.closed(4000);
    await expect(disconnected).resolves.toBeUndefined();
    expect(connection.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(connection.connected).toBe(true);
  });

  it("reports a missing connection", async () => {
    await expect(connection.disconnect()).rejects.toThrow(/No local agent/);
  });

  it("reports older agents that do not support disconnect", async () => {
    await connectedSocket();
    const result = expect(connection.disconnect()).rejects.toThrow(/Update or restart/);
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(connection.connected).toBe(true);
  });

  it("does not claim success for an unexpected socket close", async () => {
    const socket = await connectedSocket();
    const result = expect(connection.disconnect()).rejects.toThrow(/before.*confirmed/);
    socket.closed(1006);
    await result;
  });
});
