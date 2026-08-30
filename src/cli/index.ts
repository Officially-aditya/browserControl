import readline from "node:readline";
import fs from "node:fs/promises";
import { ChromeController } from "../controller.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "repl";

  if (command === "doctor") {
    const controller = new ChromeController({ mode: "auto" });
    try {
      await controller.connect();
      const doc = await controller.doctor();
      console.log("\n=== Chrome Computer-Use Doctor Diagnostic ===");
      console.log(JSON.stringify(doc, null, 2));
      await controller.disconnect();
    } catch (err: any) {
      console.error("\n=== Chrome Computer-Use Doctor Diagnostic ===");
      console.error(`Status: Disconnected / Error: ${err.message}`);
      console.error("Troubleshooting steps:");
      console.error("1. If Chrome is running, open chrome://inspect/#remote-debugging in Chrome and ensure remote debugging is enabled and target is approved.");
      console.error("2. Or launch Chrome with: --remote-debugging-port=9222");
      console.error("3. Or pass explicit endpoint with --browser-url http://127.0.0.1:9222 or --ws-endpoint ws://...");
      process.exit(1);
    }
    return;
  }

  const controller = new ChromeController({
    mode: (process.env.CHROME_CONNECT_MODE as any) || "auto",
    browserUrl: process.env.CHROME_BROWSER_URL,
    wsEndpoint: process.env.CHROME_WS_ENDPOINT,
  });

  try {
    await controller.connect();
    console.log(`Connected to Chrome (Target: ${controller.currentTargetId}, Epoch: ${controller.session.visualEpoch})`);
  } catch (err: any) {
    console.log(`Initial connection not active: ${err.message}. Type 'auto-connect' or 'connect <port>' to connect.`);
  }

  let lastObservationId: string | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "chrome-agent> ",
  });

  console.log("\nChrome Computer-Use CLI REPL");
  console.log("Commands:");
  console.log("  auto-connect                         - Auto-discover & connect to Chrome");
  console.log("  connect [port] [host]                - Connect via browser port (default 9222)");
  console.log("  doctor                               - Run diagnostic doctor");
  console.log("  nav <url>                            - Navigate active tab");
  console.log("  observe [filepath]                   - Capture screenshot and record observationId");
  console.log("  click <x> <y> [button]               - Click coordinate using last observation");
  console.log("  dblclick <x> <y> [button]            - Double click coordinate");
  console.log("  move <x> <y>                         - Move cursor");
  console.log("  down <x> <y> [button]                - Press mouse down");
  console.log("  up <x> <y> [button]                  - Release mouse up");
  console.log("  scroll <x> <y> <deltaY> [deltaX]     - Scroll wheel");
  console.log("  drag <x1,y1> <x2,y2> ...             - Multi-point drag path");
  console.log("  type <text>                          - Type text (auto/key_events)");
  console.log("  keypress <key1> [key2]               - Dispatch key shortcut (e.g. keypress Meta A)");
  console.log("  keydown <key> / keyup <key>          - Press/release single key");
  console.log("  reset-input                          - Emergency reset of held keys & buttons");
  console.log("  tabs / tab <targetId>                - List / switch tabs");
  console.log("  windows / newwindow / closewindow    - Manage browser windows");
  console.log("  dialog / dialog-accept / dialog-dismiss - Handle JS dialogs");
  console.log("  exit                                 - Quit REPL\n");

  rl.prompt();

  rl.on("line", async (line) => {
    const raw = line.trim();
    if (!raw) {
      rl.prompt();
      return;
    }

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const cmdArgs = parts.slice(1);

    try {
      if (cmd === "exit" || cmd === "quit") {
        await controller.disconnect();
        process.exit(0);
      } else if (cmd === "auto-connect") {
        await controller.disconnect().catch(() => {});
        controller.connection = new (controller.connection.constructor as any)({ mode: "auto" });
        await controller.connect();
        console.log(`Auto-connected to Chrome (Target: ${controller.currentTargetId})`);
      } else if (cmd === "doctor") {
        const doc = await controller.doctor();
        console.log(JSON.stringify(doc, null, 2));
      } else if (cmd === "observe") {
        const obs = await controller.observe({ showCursor: true });
        lastObservationId = obs.observationId;
        console.log(`Observation captured:`);
        console.log(`  ID: ${obs.observationId} (Epoch: ${obs.visualEpoch})`);
        console.log(`  Image: ${obs.imageWidth}x${obs.imageHeight} px, Viewport: ${obs.viewportWidth}x${obs.viewportHeight} px`);
        console.log(`  Scale: scaleX=${obs.coordinateSpace.scaleX.toFixed(3)}, scaleY=${obs.coordinateSpace.scaleY.toFixed(3)}`);
        if (cmdArgs[0]) {
          await fs.writeFile(cmdArgs[0], Buffer.from(obs.image, "base64"));
          console.log(`  Saved screenshot to ${cmdArgs[0]}`);
        }
      } else if (cmd === "click") {
        if (!lastObservationId) {
          const obs = await controller.observe();
          lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        const button = (cmdArgs[2] as any) || "left";
        const res = await controller.executeComputerAction({
          type: "click",
          observationId: lastObservationId,
          x,
          y,
          button,
        });
        console.log("Result:", res);
      } else if (cmd === "move") {
        if (!lastObservationId) {
          const obs = await controller.observe();
          lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        const res = await controller.executeComputerAction({
          type: "move",
          observationId: lastObservationId,
          x,
          y,
        });
        console.log("Result:", res);
      } else if (cmd === "type") {
        const text = cmdArgs.join(" ");
        const res = await controller.executeComputerAction({
          type: "type",
          text,
          method: "auto",
        });
        console.log("Result:", res);
      } else if (cmd === "keypress") {
        const res = await controller.executeComputerAction({
          type: "keypress",
          keys: cmdArgs,
        });
        console.log("Result:", res);
      } else if (cmd === "keydown") {
        const res = await controller.executeComputerAction({
          type: "key_down",
          key: cmdArgs[0],
        });
        console.log("Result:", res);
      } else if (cmd === "keyup") {
        const res = await controller.executeComputerAction({
          type: "key_up",
          key: cmdArgs[0],
        });
        console.log("Result:", res);
      } else if (cmd === "reset-input") {
        await controller.resetInputState();
        console.log("Input state reset complete.");
      } else if (cmd === "tabs") {
        const tabs = await controller.getTabs();
        console.log("Open Tabs:", tabs);
      } else if (cmd === "windows") {
        const windows = await controller.getWindows();
        console.log("Open Windows:", windows);
      } else if (cmd === "nav") {
        const res = await controller.executeBrowserAction({ type: "navigate", url: cmdArgs[0] });
        console.log("Result:", res);
      } else if (cmd === "dialog") {
        console.log("Active Dialog:", controller.activeDialog);
      } else if (cmd === "dialog-accept") {
        const res = await controller.executeBrowserAction({ type: "handle_dialog", accept: true, promptText: cmdArgs[0] });
        console.log("Result:", res);
      } else if (cmd === "dialog-dismiss") {
        const res = await controller.executeBrowserAction({ type: "handle_dialog", accept: false });
        console.log("Result:", res);
      } else {
        console.log(`Unknown command: ${cmd}. Type 'doctor' or 'observe' for options.`);
      }
    } catch (err: any) {
      console.error("Command error:", err.message || err);
    }

    rl.prompt();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
