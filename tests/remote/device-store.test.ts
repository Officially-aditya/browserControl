import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeviceRegistry } from "../../src/remote/device-auth.js";
import { loadDeviceRegistry, persistDeviceRegistry } from "../../src/remote/device-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("device registry persistence", () => {
  it("persists only credential digests and restores both auth paths", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "browsercontrol-store-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "devices.json");
    const registry = new DeviceRegistry();
    const persistence = persistDeviceRegistry(registry, filePath);
    const issued = registry.issue("Persistent Chrome");
    await persistence.flush();

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(issued.deviceToken);
    expect(raw).not.toContain(issued.mcpToken);

    const restored = await loadDeviceRegistry(filePath);
    expect(restored.authenticateDevice(issued.deviceToken)?.deviceId).toBe(issued.deviceId);
    expect(restored.authenticateMcp(issued.mcpToken)?.deviceId).toBe(issued.deviceId);
    await persistence.close();
  });
});
