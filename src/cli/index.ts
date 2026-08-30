#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { ChromeController } from "../controller.js";

const defaultPort = process.env.CHROME_DEBUG_PORT ? parseInt(process.env.CHROME_DEBUG_PORT, 10) : 9222;
const defaultHost = process.env.CHROME_DEBUG_HOST || "127.0.0.1";

let controller: ChromeController | null = null;
let isConnected = false;
let lastObservationId: string | null = null;
let debugCoordinates = true;

function printHelp(): void {
  console.log(`
Commands:
  auto-connect                   Auto-discover and connect to active Chrome session (Chrome 144+)
  connect [port] [host]          Connect via standard browser URL (default: 9222 127.0.0.1)
  doctor                         Run diagnostic inspection on Chrome connection, viewport & scale
  tabs                           List open browser tabs
  tab <targetId>                 Switch to tab targetId
  newtab [url]                   Open new tab
  closetab [targetId]            Close tab
  windows                        List open browser windows
  nav <url>                      Navigate current tab to URL
  back / forward / reload        Browser navigation controls
  screenshot [filepath]          Capture screenshot & print exact pixel/viewport dimensions
  observe [filepath]             Capture observation & record observationId
  move <x> <y>                   Move mouse to coordinate
  click <x> <y> [button]         Click at coordinate [left|right|middle|back|forward]
  dblclick <x> <y>               Double click at coordinate
  down <x> <y> [button]          Mouse down at coordinate
  up <x> <y> [button]            Mouse up at coordinate
  scroll <x> <y> <deltaY> [dX]   Scroll wheel at coordinate
  drag <x1,y1> <x2,y2> [x3,y3..] Drag mouse along coordinate path
  type <text...>                 Type text (auto / insert_text / key_events)
  keypress <key1> [key2...]      Press shortcut (e.g. keypress Meta A, keypress Enter)
  keydown <key>                  Press and hold single key (e.g. keydown Shift)
  keyup <key>                    Release single key (e.g. keyup Shift)
  dialog                         View current active JavaScript dialog state
  dialog-accept [promptText]     Accept active alert/confirm/prompt
  dialog-dismiss                 Dismiss active alert/confirm/prompt
  wait <ms>                      Wait specified milliseconds
  stop                           Stop session and detach debugger
  help                           Show this help message
  exit / quit                    Exit CLI
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle single-command invocations like `chrome-computer-use doctor`
  if (args.includes("doctor")) {
    const docController = new ChromeController({ mode: "auto" });
    try {
      await docController.connect();
      const report = await docController.doctor();
      console.log("\n=== Chrome Computer-Use Doctor Diagnostic ===");
      console.log(JSON.stringify(report, null, 2));
      await docController.disconnect();
      process.exit(0);
    } catch (err: any) {
      console.error("\n=== Chrome Computer-Use Doctor Diagnostic ===");
      console.error(`Status: Disconnected / Error: ${err.message}`);
      process.exit(1);
    }
  }

  console.log("=== Chrome Computer-Use CLI ===");
  printHelp();

  const rl = readline.createInterface({ input, output });

  try {
    controller = new ChromeController({ mode: "auto", port: defaultPort, host: defaultHost });
    console.log("Attempting auto-connection to Chrome...");
    try {
      await controller.connect();
      isConnected = true;
      console.log("✓ Connected to Chrome successfully!\n");
    } catch (err: any) {
      console.log(`Note: Auto-connect: ${err.message}. Type 'auto-connect' or 'connect' when Chrome is ready.\n`);
    }

    while (true) {
      const line = await rl.question("chrome-cu> ");
      const trimmed = line.trim();
      if (!trimmed) continue;

      const [cmd, ...cmdArgs] = trimmed.split(/\s+/);

      if (cmd === "exit" || cmd === "quit") {
        break;
      }

      if (cmd === "help") {
        printHelp();
        continue;
      }

      if (cmd === "auto-connect") {
        try {
          if (controller) await controller.disconnect();
          controller = new ChromeController({ mode: "auto" });
          await controller.connect();
          isConnected = true;
          console.log("✓ Auto-connected to Chrome session!");
        } catch (err: any) {
          console.error(`Auto-connect error: ${err.message}`);
        }
        continue;
      }

      if (cmd === "connect") {
        const p = cmdArgs[0] ? parseInt(cmdArgs[0], 10) : defaultPort;
        const h = cmdArgs[1] || defaultHost;
        try {
          if (controller) await controller.disconnect();
          controller = new ChromeController({ mode: "browser-url", port: p, host: h });
          await controller.connect();
          isConnected = true;
          console.log(`✓ Connected to Chrome on ${h}:${p}`);
        } catch (err: any) {
          console.error(`Connection error: ${err.message}`);
        }
        continue;
      }

      if (!controller || !isConnected) {
        console.error("Not connected to Chrome. Run 'auto-connect' or 'connect [port] [host]' first.");
        continue;
      }

      try {
        switch (cmd) {
          case "doctor": {
            const report = await controller.doctor();
            console.log("\n=== Diagnostic Doctor Report ===");
            console.log(`Connected:          ${report.connected ? "YES" : "NO"}`);
            console.log(`WebSocket URL:      ${report.wsUrl}`);
            console.log(`Active Target ID:   ${report.targetId}`);
            console.log(`Current Page URL:   ${report.currentUrl}`);
            if (report.viewport) {
              console.log(`CSS Viewport:       ${report.viewport.width} × ${report.viewport.height} px`);
              console.log(`Device Pixel Ratio: ${report.viewport.dpr}`);
              console.log(`Page Zoom:          ${report.viewport.zoom ?? 1}`);
            }
            if (report.screenshot) {
              console.log(`Screenshot Image:   ${report.screenshot.imageWidth} × ${report.screenshot.imageHeight} px`);
              console.log(`Coordinate Scale:   ${report.screenshot.scaleX} × ${report.screenshot.scaleY}`);
            }
            if (report.activeDialog) {
              console.log(`Active JS Dialog:   [${report.activeDialog.type}] "${report.activeDialog.message}"`);
            }
            console.log();
            break;
          }

          case "tabs": {
            const tabs = await controller.getTabs();
            console.table(
              tabs.map((t) => ({
                id: t.targetId.substring(0, 8) + "...",
                fullId: t.targetId,
                title: t.title.substring(0, 30),
                url: t.url.substring(0, 40),
                active: t.targetId === controller?.currentTargetId ? "*" : "",
              }))
            );
            break;
          }

          case "windows": {
            const windows = await controller.getWindows();
            console.table(windows);
            break;
          }

          case "tab": {
            if (!cmdArgs[0]) {
              console.error("Usage: tab <targetId>");
              break;
            }
            await controller.tabController.switchTab(cmdArgs[0]);
            console.log(`Switched to tab: ${cmdArgs[0]}`);
            break;
          }

          case "newtab": {
            const url = cmdArgs[0] || "about:blank";
            const res = await controller.tabController.newTab(url);
            console.log(`Opened new tab: ${res.targetId}`);
            break;
          }

          case "closetab": {
            const target = cmdArgs[0] || controller.currentTargetId;
            if (!target) {
              console.error("No target specified and no active tab");
              break;
            }
            await controller.tabController.closeTab(target);
            console.log(`Closed tab: ${target}`);
            break;
          }

          case "nav":
          case "navigate": {
            if (!cmdArgs[0]) {
              console.error("Usage: nav <url>");
              break;
            }
            console.log(`Navigating to ${cmdArgs[0]}...`);
            await controller.navigationController.navigate(cmdArgs[0]);
            console.log("Navigation complete.");
            break;
          }

          case "back": {
            await controller.navigationController.back();
            console.log("Navigated back.");
            break;
          }

          case "forward": {
            await controller.navigationController.forward();
            console.log("Navigated forward.");
            break;
          }

          case "reload": {
            await controller.navigationController.reload();
            console.log("Reloaded page.");
            break;
          }

          case "screenshot":
          case "observe": {
            const filePath = cmdArgs[0] || path.join(process.cwd(), "screenshot.png");
            console.log("Capturing observation...");
            const obs = await controller.observe();
            lastObservationId = obs.observationId;
            const buffer = Buffer.from(obs.image, "base64");
            await fs.writeFile(filePath, buffer);

            console.log("-----------------------------------------");
            console.log(`Screenshot image:   ${obs.imageWidth} × ${obs.imageHeight}`);
            console.log(`CSS viewport:       ${obs.viewportWidth} × ${obs.viewportHeight}`);
            console.log(`Coordinate scale:   ${obs.coordinateSpace.scaleX} × ${obs.coordinateSpace.scaleY}`);
            console.log(`DPR:                ${obs.coordinateSpace.devicePixelRatio ?? 1}`);
            console.log(`Observation:        ${obs.observationId}`);
            console.log(`Saved file:         ${filePath}`);
            console.log("-----------------------------------------");
            break;
          }

          case "move": {
            const x = parseFloat(cmdArgs[0]);
            const y = parseFloat(cmdArgs[1]);
            if (isNaN(x) || isNaN(y)) {
              console.error("Usage: move <x> <y>");
              break;
            }
            const res = await controller.executeComputerAction({
              type: "move",
              x,
              y,
              observationId: lastObservationId || undefined,
            });
            console.log(`Moved to (${x}, ${y}) [${res.durationMs}ms]`);
            break;
          }

          case "click": {
            const x = parseFloat(cmdArgs[0]);
            const y = parseFloat(cmdArgs[1]);
            const button = (cmdArgs[2] as any) || "left";
            if (isNaN(x) || isNaN(y)) {
              console.error("Usage: click <x> <y> [left|right|middle|back|forward]");
              break;
            }
            const res = await controller.executeComputerAction({
              type: "click",
              x,
              y,
              button,
              observationId: lastObservationId || undefined,
            });
            if (res.success) {
              console.log(`Clicked at (${x}, ${y}, ${button}) [${res.durationMs}ms]`);
            } else {
              console.error(`Click failed: [${res.errorCode}] ${res.error}`);
            }
            break;
          }

          case "dblclick": {
            const x = parseFloat(cmdArgs[0]);
            const y = parseFloat(cmdArgs[1]);
            if (isNaN(x) || isNaN(y)) {
              console.error("Usage: dblclick <x> <y>");
              break;
            }
            const res = await controller.executeComputerAction({
              type: "double_click",
              x,
              y,
              observationId: lastObservationId || undefined,
            });
            console.log(`Double-clicked at (${x}, ${y}) [${res.durationMs}ms]`);
            break;
          }

          case "down": {
            const x = parseFloat(cmdArgs[0]);
            const y = parseFloat(cmdArgs[1]);
            const button = (cmdArgs[2] as any) || "left";
            await controller.executeComputerAction({
              type: "down",
              x,
              y,
              button,
              observationId: lastObservationId || undefined,
            });
            console.log(`Mouse down at (${x}, ${y}, ${button})`);
            break;
          }

          case "up": {
            const x = parseFloat(cmdArgs[0]);
            const y = parseFloat(cmdArgs[1]);
            const button = (cmdArgs[2] as any) || "left";
            await controller.executeComputerAction({
              type: "up",
              x,
              y,
              button,
              observationId: lastObservationId || undefined,
            });
            console.log(`Mouse up at (${x}, ${y}, ${button})`);
            break;
          }

          case "scroll": {
            const x = parseFloat(cmdArgs[0]);
            const y = parseFloat(cmdArgs[1]);
            const deltaY = parseFloat(cmdArgs[2]);
            const deltaX = cmdArgs[3] ? parseFloat(cmdArgs[3]) : 0;
            if (isNaN(x) || isNaN(y) || isNaN(deltaY)) {
              console.error("Usage: scroll <x> <y> <deltaY> [deltaX]");
              break;
            }
            const res = await controller.executeComputerAction({
              type: "scroll",
              x,
              y,
              deltaX,
              deltaY,
              observationId: lastObservationId || undefined,
            });
            console.log(`Scrolled at (${x}, ${y}) dY=${deltaY} dX=${deltaX} [${res.durationMs}ms]`);
            break;
          }

          case "drag": {
            if (cmdArgs.length < 2) {
              console.error("Usage: drag <x1,y1> <x2,y2> ...");
              break;
            }
            const pathPoints = cmdArgs.map((coordStr) => {
              const [px, py] = coordStr.split(",").map(Number);
              return { x: px, y: py };
            });
            const res = await controller.executeComputerAction({
              type: "drag",
              path: pathPoints,
              observationId: lastObservationId || undefined,
            });
            console.log(`Dragged along ${pathPoints.length} points [${res.durationMs}ms]`);
            break;
          }

          case "type": {
            const text = cmdArgs.join(" ");
            const res = await controller.executeComputerAction({ type: "type", text, method: "auto" });
            console.log(`Typed: "${text}" [${res.durationMs}ms]`);
            break;
          }

          case "keypress": {
            if (cmdArgs.length === 0) {
              console.error("Usage: keypress <key1> [key2...]");
              break;
            }
            const res = await controller.executeComputerAction({ type: "keypress", keys: cmdArgs });
            console.log(`Keypress: [${cmdArgs.join("+")}] [${res.durationMs}ms]`);
            break;
          }

          case "keydown": {
            if (!cmdArgs[0]) {
              console.error("Usage: keydown <key>");
              break;
            }
            await controller.executeComputerAction({ type: "key_down", key: cmdArgs[0] });
            console.log(`Key down: ${cmdArgs[0]}`);
            break;
          }

          case "keyup": {
            if (!cmdArgs[0]) {
              console.error("Usage: keyup <key>");
              break;
            }
            await controller.executeComputerAction({ type: "key_up", key: cmdArgs[0] });
            console.log(`Key up: ${cmdArgs[0]}`);
            break;
          }

          case "dialog": {
            const diag = controller.activeDialog;
            if (diag) {
              console.log(`Active Dialog: [${diag.type}] "${diag.message}" (URL: ${diag.url})`);
            } else {
              console.log("No active JavaScript dialog.");
            }
            break;
          }

          case "dialog-accept": {
            const promptText = cmdArgs.join(" ") || undefined;
            await controller.executeBrowserAction({ type: "handle_dialog", accept: true, promptText });
            console.log("Accepted active dialog.");
            break;
          }

          case "dialog-dismiss": {
            await controller.executeBrowserAction({ type: "handle_dialog", accept: false });
            console.log("Dismissed active dialog.");
            break;
          }

          case "wait": {
            const ms = parseInt(cmdArgs[0], 10);
            if (isNaN(ms)) {
              console.error("Usage: wait <ms>");
              break;
            }
            await controller.executeComputerAction({ type: "wait", ms });
            console.log(`Waited ${ms}ms.`);
            break;
          }

          case "stop": {
            await controller.stop();
            isConnected = false;
            console.log("Session stopped.");
            break;
          }

          default:
            console.error(`Unknown command: ${cmd}. Type 'help' for command list.`);
        }
      } catch (cmdErr: any) {
        console.error(`Error: ${cmdErr.message}`);
      }
    }
  } finally {
    rl.close();
    if (controller) {
      try {
        await controller.disconnect();
      } catch {}
    }
  }
}

if (
  (process.argv[1] && process.argv[1].endsWith("cli/index.ts")) ||
  process.argv[1]?.endsWith("cli/index.js")
) {
  main().catch(console.error);
}
