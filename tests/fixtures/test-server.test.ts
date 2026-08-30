import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, TestServer } from "./test-server.js";

describe("Test Fixture Server", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(0);
  });

  afterAll(async () => {
    await server.close();
  });

  it("should serve calibration.html", async () => {
    const res = await fetch(`${server.url}/calibration.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Coordinate Calibration");
    expect(html).toContain("target-1");
    expect(html).toContain("target-2");
    expect(html).toContain("target-3");
  });

  it("should serve canvas_ui.html", async () => {
    const res = await fetch(`${server.url}/canvas_ui.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("appCanvas");
    expect(html).toContain("window.__CANVAS_STATE__");
  });

  it("should serve interactive.html", async () => {
    const res = await fetch(`${server.url}/interactive.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Interactive Test Page");
    expect(html).toContain("nested-scroll");
  });
});
