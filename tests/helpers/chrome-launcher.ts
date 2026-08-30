import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface LaunchedChrome {
  process: ChildProcess;
  port: number;
  wsUrl: string;
  tempDir: string;
  close: () => Promise<void>;
}

export function findChromePath(): string {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    return path.join(local, "Google/Chrome/Application/chrome.exe");
  }
  return "google-chrome";
}

export async function launchRealChrome(options: {
  windowSize?: string;
  deviceScaleFactor?: number;
  extraArgs?: string[];
  headless?: boolean;
  disableBackgroundNetworking?: boolean;
} = {}): Promise<LaunchedChrome> {
  const chromePath = findChromePath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-cu-test-"));
  const windowSize = options.windowSize || "1280,800";
  const headless = options.headless ?? true;
  const disableBackgroundNetworking = options.disableBackgroundNetworking ?? true;

  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${tempDir}`,
    ...(headless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    ...(disableBackgroundNetworking ? ["--disable-background-networking"] : []),
    "--disable-sync",
    "--disable-gpu",
    `--window-size=${windowSize}`,
    ...(options.deviceScaleFactor ? [`--force-device-scale-factor=${options.deviceScaleFactor}`] : []),
    ...(options.extraArgs || []),
    "about:blank",
  ];

  const proc = spawn(chromePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const activePortFile = path.join(tempDir, "DevToolsActivePort");
  const startTime = Date.now();
  let port = 0;
  let wsPath = "";

  while (Date.now() - startTime < 15000) {
    try {
      const content = await fs.readFile(activePortFile, "utf8");
      const lines = content.trim().split("\n").map((l) => l.trim());
      if (lines.length >= 2) {
        port = parseInt(lines[0], 10);
        wsPath = lines[1];
        if (!isNaN(port) && wsPath) break;
      }
    } catch {
      // File not yet written
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!port || !wsPath) {
    proc.kill("SIGKILL");
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error("Timed out waiting for Chrome DevToolsActivePort");
  }

  const wsUrl = `ws://127.0.0.1:${port}${wsPath.startsWith("/") ? "" : "/"}${wsPath}`;

  const close = async () => {
    try {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      proc.kill("SIGKILL");
    } catch {}
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  };

  return { process: proc, port, wsUrl, tempDir, close };
}
