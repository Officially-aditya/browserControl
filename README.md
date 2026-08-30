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
- **Observation Guardrails**: Every screenshot yields an `observationId`. Actions planned against stale observations (e.g. after page navigation or tab switches) are rejected with `STALE_OBSERVATION` to prevent invalid coordinate clicks. Wildly out-of-bounds coordinates are rejected with `OUT_OF_BOUNDS`.
- **Action Serialization**: Actions are queued and executed serially per target to eliminate race conditions.
- **Dual MCP Transports**: Standard Stdio transport for local AI agents + Streamable HTTP transport for remote/tunneled environments.

---

## 1. Quick Start

### Prerequisites
1. **Node.js** (v18+)
2. **Google Chrome** (Chrome 144+ recommended for `--auto-connect`):
   - Navigate to `chrome://inspect/#remote-debugging` and ensure remote debugging is enabled, OR
   - Start Chrome with `--remote-debugging-port=9222`

### Installation & Build
```bash
cd /Users/addy/Downloads/browser/chrome-computer-use
npm install
npm run build
```

---

## 2. Connection Modes

The bridge supports 3 connection modes:

1. **`auto`** (`--auto-connect`):
   Automatically discovers active Chrome 144+ sessions by inspecting `DevToolsActivePort` across macOS, Linux, and Windows user-data paths, falling back to probing standard debugging ports.
   ```bash
   npm run cli -- auto-connect
   ```

2. **`browser-url`** (`--browser-url <url>`):
   Connects to an explicit HTTP debugging port (e.g. `http://127.0.0.1:9222`).
   ```bash
   npm run cli -- connect 9222 127.0.0.1
   ```

3. **`ws-endpoint`** (`--ws-endpoint <url>`):
   Connects directly to a specific Chrome WebSocket debugger URL (`ws://...`).

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

## 4. Interactive CLI

Launch the interactive terminal REPL to test actions directly:

```bash
npm run cli
```

Available REPL commands:
- `auto-connect` — Auto-discover and connect to running Chrome
- `doctor` — Run diagnostic check
- `tabs` / `tab <targetId>` — List and switch tabs
- `windows` / `newtab [url]` / `closetab [targetId]` — Manage tabs and windows
- `nav <url>` / `back` / `forward` / `reload` — Browser chassis navigation
- `observe [filepath]` — Capture observation and record `observationId`
- `move <x> <y>` — Move mouse
- `click <x> <y> [button]` — Click at coordinate (`left`, `right`, `middle`, `back`, `forward`)
- `dblclick <x> <y>` — Double click
- `scroll <x> <y> <deltaY> [deltaX]` — Scroll wheel at coordinate
- `drag <x1,y1> <x2,y2> ...` — Multi-point drag path
- `type <text>` — Insert text (`auto`, `insert_text`, `key_events`)
- `keypress <key1> [key2]` — Dispatch shortcut (e.g. `keypress Meta A`)
- `keydown <key>` / `keyup <key>` — Press and release individual keys
- `dialog` / `dialog-accept` / `dialog-dismiss` — Intercept and handle JS dialogs

---

## 5. Model Context Protocol (MCP) Transports

### A. Local Agents (Stdio Transport)
Run the MCP server over standard stdio:
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

### B. Remote / Tunneled Agents (Streamable HTTP Transport)
Run the Streamable HTTP MCP server:
```bash
npm run mcp:http
```
Listens on `http://127.0.0.1:8765/mcp` (configurable via `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, and optional `MCP_AUTH_TOKEN` bearer token).

*Note: For remote MCP clients (including ChatGPT workspace custom actions), connect through a supported secure tunnel to this HTTP endpoint.*

---

## 6. Programmatic TypeScript API

```typescript
import { ChromeController } from "chrome-computer-use";

const controller = new ChromeController({ mode: "auto" });
await controller.connect();

// 1. Capture observation
const obs = await controller.observe();
console.log(`Observation ID: ${obs.observationId}, Scale: ${obs.coordinateSpace.scaleX}`);

// 2. Click button using model coordinates
await controller.executeComputerAction({
  type: "click",
  observationId: obs.observationId,
  x: 250,
  y: 180,
  button: "left",
});

// 3. Type into focused field
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

// 5. Drag slider
await controller.executeComputerAction({
  type: "drag",
  path: [
    { x: 300, y: 150 },
    { x: 450, y: 150 },
    { x: 600, y: 150 },
  ],
});

await controller.disconnect();
```

---

## 7. Test Suites & Verification

```bash
# Run unit tests (mathematical precision, schemas, mock protocol)
npm run test:unit

# Run live Chrome integration tests (spawns real Google Chrome and verifies canvas & coordinate calibration)
npm run test:integration

# Run all tests
npm test
```

### Test Counts:
- **Unit Tests**: 61 passed
  - Coordinate calibration & boundary validation
  - Resolution regression matrix (800x600 to 1920x1080, DPR 1 & 2, zoom 80%–150%)
  - Protocol action schemas (all computer & browser actions)
  - Mouse event sequencing, double clicks, scroll chunking, drag paths
  - Keyboard modifiers (`Meta`, `Shift`, `Alt`, `Ctrl`), shortcuts, bulk text insertion
  - Test fixture server validation
- **Live Chrome Integration Tests**: 9 passed
  - Real Chrome target calibration ($\Delta x, \Delta y \le 2$ CSS px error on real browser)
  - Real Chrome out-of-bounds coordinate rejection (`OUT_OF_BOUNDS`)
  - Real Chrome stale observation invalidation (`STALE_OBSERVATION`)
  - Real Chrome 100% canvas-rendered app E2E (button clicks, menu hover, option selection, key_events typing, backspace, slider dragging)
  - Real Chrome interactive controls (left/double/right click, nested container scrolling, input typing)
  - Real Chrome JavaScript dialog interception and handling (`alert`, `confirm`, `prompt`)
  - Real Chrome multi-tab lifecycle management (new tab, switch, close)
