# Chrome Computer-Use Bridge

A production-ready browser-control layer enabling AI vision agents to operate an existing Google Chrome session using the computer-use interaction paradigm:

```text
Screenshot
    ↓
Vision model determines coordinates / action
    ↓
Mouse / keyboard action
    ↓
New screenshot
    ↓
Repeat
```

## Core Principles & Guarantees

- **100% Selectorless**: Interacts purely with viewport pixels, normalized coordinates, and keyboard strokes. No DOM/CSS selectors, no Playwright/Puppeteer abstractions, no accessibility refs.
- **Connects to Existing Chrome**: Re-uses the user's running Chrome session, cookies, logins, profile, and tabs via Chrome 144+ remote debugging (`chrome://inspect/#remote-debugging`).
- **Direct CDP Transport**: Pure WebSocket communication over Chrome DevTools Protocol with zero heavy automation wrappers.
- **Deterministic Coordinate Normalization**: Encoded screenshots are decoded at the binary header level to determine real dimensions (`actualScreenshotWidth`, `actualScreenshotHeight`, `scaleX`, `scaleY`), ensuring $\Delta x, \Delta y \le 2$ CSS px error on real Chrome across DPR 1, DPR 2, and zoom levels.
- **Observation Guardrails**: Every screenshot yields an `observationId` and `visualEpoch`. Actions planned against stale observations (after page navigation, tab switches, or in-page SPA routing) are rejected with `STALE_OBSERVATION` to prevent invalid coordinate clicks. Wildly out-of-bounds coordinates are rejected with `OUT_OF_BOUNDS`.
- **Action Serialization & Cancellation**: Actions are queued serially per target (`ActionQueue`) with strict cancel-and-drain semantics and AbortSignal propagation.
- **Dual MCP Transports**: Standard Stdio transport for local AI agents + hardened Streamable HTTP transport for remote/tunneled environments with lazy reconnection and security sandboxing.

---

## 1. Quick Start

### Prerequisites
1. **Node.js** (v18+)
2. **Google Chrome** (Chrome 144+ recommended for `--auto-connect`):
   - Navigate to `chrome://inspect/#remote-debugging` and ensure remote debugging is enabled, OR
   - Start Chrome with `--remote-debugging-port=9222`

### Installation & Build
```bash
npm install
npm run build
```

---

## 2. Connection Modes

The bridge supports 3 connection modes:

1. **`auto`** (`CHROME_CONNECT_MODE=auto`):
   Automatically discovers active Chrome 144+ sessions by inspecting `DevToolsActivePort` across macOS, Linux, and Windows user-data paths, falling back to probing standard debugging ports.
   ```bash
   npm run cli
   # Inside CLI: auto-connect
   ```

2. **`browser-url`** (`CHROME_BROWSER_URL=http://127.0.0.1:9222`):
   Connects to an explicit HTTP debugging port.
   ```bash
   npm run cli
   # Inside CLI: connect 9222 127.0.0.1
   ```

3. **`ws-endpoint`** (`CHROME_WS_ENDPOINT=ws://...`):
   Connects directly to a specific Chrome WebSocket debugger URL.

---

## 3. Diagnostic Doctor

Inspect your Chrome connection status, viewport metrics, real screenshot dimensions, coordinate scale factors, and DPR:

```bash
npm run doctor
```

Example Output:
```json
{
  "connected": true,
  "wsUrl": "ws://127.0.0.1:59142/devtools/browser/...",
  "targetId": "2063B4D7455AF284BD3940E74F386CD9",
  "currentUrl": "https://github.com",
  "visualEpoch": 1,
  "viewport": {
    "width": 1440,
    "height": 900,
    "dpr": 2,
    "zoom": 1
  },
  "screenshot": {
    "imageWidth": 2880,
    "imageHeight": 1800,
    "scaleX": 0.5,
    "scaleY": 0.5
  },
  "activeDialog": null
}
```

---

## 4. Interactive CLI REPL

Launch the interactive terminal REPL to test actions directly:

```bash
npm run cli
```

### Complete Command Reference

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `auto-connect` | — | Auto-discover and connect to running Chrome instance |
| `connect` | `[port] [host]` | Connect to specific HTTP remote debugging endpoint (default: 9222 127.0.0.1) |
| `doctor` | — | Run diagnostic check and display viewport/scale metrics |
| `nav` | `<url>` | Navigate active tab to URL |
| `back` | — | Navigate back in session history |
| `forward` | — | Navigate forward in session history |
| `reload` | — | Reload active tab |
| `observe` | `[filepath]` | Capture screenshot observation, record `observationId`, and optionally save image |
| `click` | `<x> <y> [button]` | Click at pixel coordinates (`left`, `right`, `middle`, `back`, `forward`) |
| `dblclick` | `<x> <y> [button]` | Double click at pixel coordinates |
| `move` | `<x> <y>` | Move mouse cursor to coordinates |
| `down` | `<x> <y> [button]` | Press and hold mouse button |
| `up` | `<x> <y> [button]` | Release held mouse button |
| `scroll` | `<x> <y> <deltaY> [deltaX]` | Scroll wheel by delta at coordinates |
| `drag` | `<x1,y1> <x2,y2> ...` | Execute smooth multi-waypoint drag path |
| `type` | `<text>` | Insert text into focused element |
| `keypress` | `<key1> [key2]` | Dispatch shortcut combo (e.g. `keypress Meta a`) |
| `keydown` | `<key>` | Press and hold key (e.g. `keydown Shift`) |
| `keyup` | `<key>` | Release held key (e.g. `keyup Shift`) |
| `reset-input` | — | Emergency release of all held keys, buttons, and drag state |
| `tabs` | — | List all open browser tabs |
| `tab` | `<targetId>` | Switch active controller session to target tab |
| `newtab` | `[url]` | Open a new browser tab |
| `closetab` | `[targetId]` | Close tab (defaults to active tab) |
| `windows` | — | List all open browser windows and bounds |
| `newwindow` | `[url]` | Open a new browser window |
| `closewindow` | `<windowId>` | Close specific window by numeric ID |
| `dialog` | — | Inspect active JavaScript dialog (`alert`, `confirm`, `prompt`) |
| `dialog-accept` | `[promptText]` | Accept active dialog with optional prompt input |
| `dialog-dismiss`| — | Dismiss/cancel active dialog |
| `help` | — | List available CLI commands |
| `exit` / `quit` | — | Disconnect cleanly and exit REPL |

---

## 5. Model Context Protocol (MCP) Server

The bridge provides full MCP tool exposure for AI agents (`observe`, `computer_action`, `browser_action`, `doctor`) with lazy reconnection support.

### A. Local Agents (Stdio Transport)
Run the MCP server over standard input/output:
```bash
npm run mcp
```

**Claude Desktop Configuration (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "chrome-computer-use": {
      "command": "node",
      "args": ["/Users/addy/Downloads/browser/chrome-computer-use/dist/mcp/server.js"],
      "env": {
        "CHROME_CONNECT_MODE": "auto"
      }
    }
  }
}
```

### B. Remote & Tunneled Agents (Streamable HTTP Transport)
Run the official Streamable HTTP MCP server:
```bash
npm run mcp:http
```

#### Security Hardening & Configuration:
- **Mandatory Authentication**: Auto-generates a secure Bearer token on startup, or supply via `MCP_AUTH_TOKEN` environment variable. (Disable only for local testing via `MCP_ALLOW_INSECURE_NO_AUTH=true`).
- **DNS Rebinding & Host Validation**: Enforces Host header validation against loopback addresses (`127.0.0.1`, `localhost`, `::1`, `[::1]`) and custom hosts via `MCP_ALLOWED_HOSTS`.
- **CORS Protection**: Cross-Origin requests are disabled by default. Enable strictly for trusted domains via `MCP_ENABLE_CORS=true` and `MCP_ALLOWED_ORIGINS=https://my-domain.com`.
- **Request Body Limits**: Enforces payload size limits (default 10 MB, configurable via `MCP_MAX_BODY_SIZE`).
- **Lazy Reconnect**: Tools automatically connect to Chrome on demand if Chrome is started after the MCP server.

---

## 6. Programmatic TypeScript API

```typescript
import { ChromeController } from "chrome-computer-use";

const controller = new ChromeController({ mode: "auto" });
await controller.connect();

// 1. Capture observation
const obs = await controller.observe({ showCursor: true });
console.log(`Observation ID: ${obs.observationId}, Scale: ${obs.coordinateSpace.scaleX}`);

// 2. Click button using model coordinates
await controller.executeComputerAction({
  type: "click",
  observationId: obs.observationId,
  x: 250,
  y: 180,
  button: "left",
});

// 3. Type text into focused input
await controller.executeComputerAction({
  type: "type",
  text: "Hello World",
  method: "auto",
});

// 4. Keyboard shortcut
await controller.executeComputerAction({
  type: "keypress",
  keys: ["Meta", "A"],
});

// 5. Multi-point drag
await controller.executeComputerAction({
  type: "drag",
  observationId: obs.observationId,
  path: [
    { x: 300, y: 150 },
    { x: 450, y: 150 },
    { x: 600, y: 150 },
  ],
});

// 6. Clean disconnect
await controller.disconnect();
```

---

## 7. Test Suites & Verification

```bash
# Run unit tests (coordinates, inputs, protocol, ActionQueue, MCP security & reconnect, CLI, mock E2E)
npm run test:unit

# Run live Chrome integration tests (spawns Chrome, verifies DPR 1/2 calibration, canvas apps, tabs, recovery, MCP tunnels)
npm run test:integration

# Run opt-in smoke test against an already running Chrome instance (chrome --remote-debugging-port=9222)
npm run test:smoke

# Run full project test suite across all 21 test files
npm test
```

### Test Coverage Highlights (21 Test Suites, 150+ Tests Passing):
- **Coordinate & Pixel Calibration**: Sub-2px precision on live Chrome across DPR 1, DPR 2, and page zoom levels.
- **Observation Guardrails**: Rejection of stale observations (`STALE_OBSERVATION`) on navigations and SPA route changes (`history.pushState`).
- **ActionQueue Architecture**: FIFO execution, mutual exclusion, AbortSignal propagation, in-flight task tracking, and cancel-and-drain safe reset.
- **Automatic Controlled Target Recovery**: Automatic switch to open tab or new `about:blank` page upon target destruction or detachment.
- **Selectorless Canvas E2E**: 100% canvas-rendered visual app automated entirely via vision coordinates and input actions with zero DOM queries.
- **Unicode & International Script Typing**: Code-point preservation for emojis and multi-byte scripts across DOM inputs and canvas.
- **MCP Protocol Integrations**: End-to-end tests through official MCP Client using both Stdio and Streamable HTTP transports.
- **HTTP Security**: 11-part test suite validating Bearer auth, DNS rebinding Host validation, IPv6 normalization, CORS origin whitelisting, and payload limits (`MCP_MAX_BODY_SIZE`).
- **Browser-Level Ops**: Tabs, windows, and JavaScript dialogs (`alert`, `confirm`, `prompt`, blocking).
