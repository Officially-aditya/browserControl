import readline from "node:readline";
import fs from "node:fs/promises";
import { ChromeController } from "../controller.js";

export class CliSession {
  public controller: ChromeController;
  public lastObservationId: string | null = null;
  private controllerFactory: (options: any) => ChromeController;

  constructor(
    controller?: ChromeController,
    controllerFactory: (options: any) => ChromeController = (opts) => new ChromeController(opts)
  ) {
    this.controllerFactory = controllerFactory;
    this.controller =
      controller ||
      this.controllerFactory({
        mode: (process.env.CHROME_CONNECT_MODE as any) || "auto",
        browserUrl: process.env.CHROME_BROWSER_URL,
        wsEndpoint: process.env.CHROME_WS_ENDPOINT,
      });
  }

  public async handleCommand(input: string): Promise<any> {
    const raw = input.trim();
    if (!raw) return null;

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const cmdArgs = parts.slice(1);

    switch (cmd) {
      case "exit":
      case "quit": {
        await this.controller.disconnect();
        return { action: "exit" };
      }

      case "auto-connect": {
        await this.controller.disconnect().catch(() => {});
        this.controller = this.controllerFactory({ mode: "auto" });
        await this.controller.connect();
        return {
          status: "connected",
          targetId: this.controller.currentTargetId,
          visualEpoch: this.controller.session?.visualEpoch,
        };
      }

      case "connect": {
        const port = parseInt(cmdArgs[0] || "9222", 10);
        const host = cmdArgs[1] || "127.0.0.1";
        await this.controller.disconnect().catch(() => {});
        this.controller = this.controllerFactory({
          mode: "browser-url",
          browserUrl: `http://${host}:${port}`,
        });
        await this.controller.connect();
        return {
          status: "connected",
          endpoint: `http://${host}:${port}`,
          targetId: this.controller.currentTargetId,
        };
      }

      case "doctor": {
        const doc = await this.controller.doctor();
        return doc;
      }

      case "nav": {
        const url = cmdArgs[0];
        if (!url) throw new Error("nav requires a URL parameter (e.g. nav https://example.com)");
        return await this.controller.executeBrowserAction({ type: "navigate", url });
      }

      case "back": {
        return await this.controller.executeBrowserAction({ type: "back" });
      }

      case "forward": {
        return await this.controller.executeBrowserAction({ type: "forward" });
      }

      case "reload": {
        return await this.controller.executeBrowserAction({ type: "reload" });
      }

      case "observe": {
        const obs = await this.controller.observe({ showCursor: true });
        this.lastObservationId = obs.observationId;
        if (cmdArgs[0]) {
          await fs.writeFile(cmdArgs[0], Buffer.from(obs.image, "base64"));
        }
        return {
          observationId: obs.observationId,
          visualEpoch: obs.visualEpoch,
          viewport: { width: obs.viewportWidth, height: obs.viewportHeight },
          image: { width: obs.imageWidth, height: obs.imageHeight },
          savedTo: cmdArgs[0] || null,
        };
      }

      case "click": {
        if (!this.lastObservationId) {
          const obs = await this.controller.observe();
          this.lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        const button = (cmdArgs[2] as any) || "left";
        return await this.controller.executeComputerAction({
          type: "click",
          observationId: this.lastObservationId,
          x,
          y,
          button,
        });
      }

      case "dblclick": {
        if (!this.lastObservationId) {
          const obs = await this.controller.observe();
          this.lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        const button = (cmdArgs[2] as any) || "left";
        return await this.controller.executeComputerAction({
          type: "double_click",
          observationId: this.lastObservationId,
          x,
          y,
          button,
        });
      }

      case "move": {
        if (!this.lastObservationId) {
          const obs = await this.controller.observe();
          this.lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        return await this.controller.executeComputerAction({
          type: "move",
          observationId: this.lastObservationId,
          x,
          y,
        });
      }

      case "down": {
        if (!this.lastObservationId) {
          const obs = await this.controller.observe();
          this.lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        const button = (cmdArgs[2] as any) || "left";
        return await this.controller.executeComputerAction({
          type: "down",
          observationId: this.lastObservationId,
          x,
          y,
          button,
        });
      }

      case "up": {
        if (!this.lastObservationId) {
          const obs = await this.controller.observe();
          this.lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        const button = (cmdArgs[2] as any) || "left";
        return await this.controller.executeComputerAction({
          type: "up",
          observationId: this.lastObservationId,
          x,
          y,
          button,
        });
      }

      case "scroll": {
        if (!this.lastObservationId) {
          const obs = await this.controller.observe();
          this.lastObservationId = obs.observationId;
        }
        const x = parseFloat(cmdArgs[0]);
        const y = parseFloat(cmdArgs[1]);
        const deltaY = parseFloat(cmdArgs[2] || "0");
        const deltaX = parseFloat(cmdArgs[3] || "0");
        return await this.controller.executeComputerAction({
          type: "scroll",
          observationId: this.lastObservationId,
          x,
          y,
          deltaX,
          deltaY,
        });
      }

      case "drag": {
        if (!this.lastObservationId) {
          const obs = await this.controller.observe();
          this.lastObservationId = obs.observationId;
        }
        const path = cmdArgs.map((pt) => {
          const [px, py] = pt.split(",").map((n) => parseFloat(n.trim()));
          if (isNaN(px) || isNaN(py)) {
            throw new Error(`Invalid coordinate point: ${pt}. Expected format x,y`);
          }
          return { x: px, y: py };
        });
        if (path.length < 2) {
          throw new Error("drag requires at least 2 points (e.g. drag 100,100 200,200)");
        }
        return await this.controller.executeComputerAction({
          type: "drag",
          observationId: this.lastObservationId,
          path,
        });
      }

      case "type": {
        const text = cmdArgs.join(" ");
        return await this.controller.executeComputerAction({
          type: "type",
          text,
          method: "auto",
        });
      }

      case "keypress": {
        if (cmdArgs.length === 0) throw new Error("keypress requires key names (e.g. keypress Meta a)");
        return await this.controller.executeComputerAction({
          type: "keypress",
          keys: cmdArgs,
        });
      }

      case "keydown": {
        if (!cmdArgs[0]) throw new Error("keydown requires a key name (e.g. keydown Shift)");
        return await this.controller.executeComputerAction({
          type: "key_down",
          key: cmdArgs[0],
        });
      }

      case "keyup": {
        if (!cmdArgs[0]) throw new Error("keyup requires a key name (e.g. keyup Shift)");
        return await this.controller.executeComputerAction({
          type: "key_up",
          key: cmdArgs[0],
        });
      }

      case "reset-input": {
        await this.controller.resetInputState();
        return { status: "reset_complete" };
      }

      case "tabs": {
        return await this.controller.getTabs();
      }

      case "tab": {
        if (!cmdArgs[0]) throw new Error("tab requires a targetId parameter (e.g. tab <targetId>)");
        return await this.controller.executeBrowserAction({
          type: "switch_tab",
          targetId: cmdArgs[0],
        });
      }

      case "newtab": {
        return await this.controller.executeBrowserAction({
          type: "new_tab",
          url: cmdArgs[0] || "about:blank",
        });
      }

      case "closetab": {
        const targetId = cmdArgs[0] || (this.controller.currentTargetId as string);
        return await this.controller.executeBrowserAction({
          type: "close_tab",
          targetId,
        });
      }

      case "windows": {
        return await this.controller.getWindows();
      }

      case "newwindow": {
        return await this.controller.executeBrowserAction({
          type: "new_window",
          url: cmdArgs[0] || "about:blank",
        });
      }

      case "closewindow": {
        if (!cmdArgs[0]) throw new Error("closewindow requires a numeric windowId (e.g. closewindow 1)");
        const windowId = parseInt(cmdArgs[0], 10);
        return await this.controller.executeBrowserAction({
          type: "close_window",
          windowId,
        });
      }

      case "dialog": {
        return this.controller.activeDialog;
      }

      case "dialog-accept": {
        return await this.controller.executeBrowserAction({
          type: "handle_dialog",
          accept: true,
          promptText: cmdArgs.join(" ") || undefined,
        });
      }

      case "dialog-dismiss": {
        return await this.controller.executeBrowserAction({
          type: "handle_dialog",
          accept: false,
        });
      }

      case "help": {
        return {
          commands: [
            "auto-connect",
            "connect [port] [host]",
            "doctor",
            "nav <url>",
            "back",
            "forward",
            "reload",
            "observe [filepath]",
            "click <x> <y> [button]",
            "dblclick <x> <y> [button]",
            "move <x> <y>",
            "down <x> <y> [button]",
            "up <x> <y> [button]",
            "scroll <x> <y> <deltaY> [deltaX]",
            "drag <x1,y1> <x2,y2> ...",
            "type <text>",
            "keypress <key1> [key2]",
            "keydown <key>",
            "keyup <key>",
            "reset-input",
            "tabs",
            "tab <targetId>",
            "newtab [url]",
            "closetab [targetId]",
            "windows",
            "newwindow [url]",
            "closewindow <windowId>",
            "dialog",
            "dialog-accept [promptText]",
            "dialog-dismiss",
            "help",
            "exit",
          ],
        };
      }

      default:
        throw new Error(`Unknown command: ${cmd}. Type 'help' for available commands.`);
    }
  }
}

export async function main() {
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

  const session = new CliSession();

  try {
    await session.controller.connect();
    console.log(
      `Connected to Chrome (Target: ${session.controller.currentTargetId}, Epoch: ${session.controller.session.visualEpoch})`
    );
  } catch (err: any) {
    console.log(`Initial connection not active: ${err.message}. Type 'auto-connect' or 'connect <port>' to connect.`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "chrome-agent> ",
  });

  console.log("\nChrome Computer-Use CLI REPL");
  console.log("Type 'help' to list all commands, or 'exit' to quit.\n");

  rl.prompt();

  rl.on("line", async (line) => {
    try {
      const result = await session.handleCommand(line);
      if (result && result.action === "exit") {
        process.exit(0);
      }
      if (result !== null && result !== undefined) {
        console.log(typeof result === "object" ? JSON.stringify(result, null, 2) : result);
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
