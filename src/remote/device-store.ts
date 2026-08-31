import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DeviceRegistry, type DeviceRegistrySnapshot } from "./device-auth.js";

export async function loadDeviceRegistry(filePath: string): Promise<DeviceRegistry> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as DeviceRegistrySnapshot;
    return new DeviceRegistry(parsed);
  } catch (error: any) {
    if (error?.code === "ENOENT") return new DeviceRegistry();
    throw new Error(`Could not load browserControl device registry from ${filePath}: ${error?.message || String(error)}`);
  }
}

export interface DeviceRegistryPersistence {
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function persistDeviceRegistry(
  registry: DeviceRegistry,
  filePath: string,
  onError: (error: Error) => void = (error) => console.error("[browserControl] Device registry persistence error:", error)
): DeviceRegistryPersistence {
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const persist = (snapshot: DeviceRegistrySnapshot) => {
    if (closed) return;
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(tempPath, filePath);
      })
      .catch((error) => {
        onError(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
  };

  const unsubscribe = registry.onChanged(persist);

  return {
    flush: () => queue,
    close: async () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      await queue;
    },
  };
}
