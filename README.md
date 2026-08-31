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

The repository supports two complementary paths: the original Node/raw-CDP controller for local agents, and an extension-first remote gateway that gives compatible web AI clients an authenticated screen/mouse/keyboard connection to Chrome without adding a second reasoning model.

## Core Principles & Guarantees

- **100% Selectorless**: Interacts purely with viewport pixels, normalized coordinates, and keyboard strokes. No DOM/CSS selectors, no Playwright/Puppeteer abstractions, no accessibility refs.
- **Connects to Existing Chrome**: Re-uses the user's running Chrome session, cookies, logins, profile, and tabs via Chrome remote debugging or the browserControl MV3 extension.
- **Direct CDP Transport**: Pure Chrome DevTools Protocol interaction with no heavy automation wrapper.
- **Deterministic Coordinate Normalization**: Encoded screenshots are decoded at the binary header level to determine real dimensions and scale factors, preserving accurate mapping across DPR and zoom levels.
- **Observation Guardrails**: Screenshots yield an `observationId` and `visualEpoch`. The extension path also invalidates observations on external DOM/user visual changes, and every mutating remote MCP tool is observation-bound.
- **Action Serialization & Cancellation**: Local controller actions are queued serially per target (`ActionQueue`) with cancel-and-drain semantics and AbortSignal propagation.
- **Dual MCP Paths**: Standard Stdio/HTTP transports for local raw-CDP agents plus the hardened extension gateway for remote web clients.

---

## 1. Quick Start

### Prerequisites
1. **Node.js** (v20+)
2. **Google Chrome**

### Installation & Build
```bash
npm ci
npm run build
```

---

## 2. Local raw-CDP connection modes

The Node controller supports 3 connection modes:

1. **`auto`** (`CHROME_CONNECT_MODE=auto`): discovers an active Chrome debugging session where supported.
2. **`browser-url`** (`CHROME_BROWSER_URL=http://127.0.0.1:9222`): connects to an explicit HTTP debugging endpoint.
3. **`ws-endpoint`** (`CHROME_WS_ENDPOINT=ws://...`): connects directly to a Chrome WebSocket debugger URL.

For explicit remote debugging, enable it in Chrome or launch a dedicated test profile with a debugging port.

---

## 3. Diagnostic Doctor

Inspect Chrome connection status, viewport metrics, screenshot dimensions, scale factors, and DPR:

```bash
npm run doctor
```

---

## 4. Interactive CLI REPL

Launch the interactive terminal REPL:

```bash
npm run cli
```

### Complete Command Reference

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `auto-connect` | — | Auto-discover and connect to running Chrome instance |
| `connect` | `[port] [host]` | Connect to specific HTTP remote debugging endpoint |
| `doctor` | — | Run diagnostic check and display viewport/scale metrics |
| `nav` | `<url>` | Navigate active tab to URL |
| `back` | — | Navigate back in session history |
| `forward` | — | Navigate forward in session history |
| `reload` | — | Reload active tab |
| `observe` | `[filepath]` | Capture screenshot observation and optionally save image |
| `click` | `<x> <y> [button]` | Click at coordinates |
| `dblclick` | `<x> <y> [button]` | Double click at coordinates |
| `move` | `<x> <y>` | Move mouse cursor |
| `down` | `<x> <y> [button]` | Press and hold mouse button |
| `up` | `<x> <y> [button]` | Release held mouse button |
| `scroll` | `<x> <y> <deltaY> [deltaX]` | Scroll wheel at coordinates |
| `drag` | `<x1,y1> <x2,y2> ...` | Multi-waypoint drag path |
| `type` | `<text>` | Insert text into focused element |
| `keypress` | `<key1> [key2]` | Dispatch shortcut combo (for example `keypress Meta a`) |
| `keydown` | `<key>` | Press and hold key |
| `keyup` | `<key>` | Release held key |
| `reset-input` | — | Emergency release of held keys/buttons |
| `tabs` | — | List browser tabs |
| `tab` | `<targetId>` | Switch active controller session |
| `newtab` | `[url]` | Open a browser tab |
| `closetab` | `[targetId]` | Close tab |
| `windows` | — | List browser windows |
| `newwindow` | `[url]` | Open a browser window |
| `closewindow` | `<windowId>` | Close a browser window |
| `dialog` | — | Inspect active JavaScript dialog |
| `dialog-accept` | `[promptText]` | Accept dialog |
| `dialog-dismiss` | — | Dismiss dialog |
| `help` | — | List commands |
| `exit` / `quit` | — | Disconnect and exit |

---

## 5. Model Context Protocol (MCP)

### A. Local agents

Run the local stdio MCP server:

```bash
npm run mcp
```

Run the hardened local Streamable HTTP server:

```bash
npm run mcp:http
```

The local HTTP path uses `MCP_AUTH_TOKEN` and retains its existing security controls such as host validation, CORS controls, payload limits, and lazy Chrome reconnect.

### B. Extension-first remote web control

For Claude web and other compatible remote MCP clients, run/deploy the dedicated gateway:

```bash
npm run gateway:setup
# load .browsercontrol.env for local development
npm run gateway
```

The remote gateway uses MCP `2026-07-28` with legacy stateless compatibility and exposes screenshot image content plus browser-control tools.

#### Credential separation

- `BROWSERCONTROL_MCP_TOKEN`: model-facing MCP access.
- `BROWSERCONTROL_ADMIN_TOKEN`: pairing creation, device listing and revocation. **Never give this token to the AI connector.**
- `BROWSERCONTROL_DEVICE_TOKEN`: loopback-development compatibility only. Public/non-loopback gateways reject the static device-token path and use revocable pairing instead.

The Render blueprint follows this model and does not create a permanent production device token.

#### Pairing and device revocation

Create an eight-digit, one-time pairing code with the admin credential:

```bash
curl -X POST https://YOUR_GATEWAY_HOST/pairing/create \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chrome laptop"}'
```

Then enter the public `wss://YOUR_GATEWAY_HOST/extension` URL and the code directly in the extension popup and choose **Pair & connect**. The popup requests access only to that configured gateway origin, claims the code, stores the revocable credential, and connects automatically.

API-driven claim remains available:

```bash
curl -X POST https://YOUR_GATEWAY_HOST/pairing/claim \
  -H "Content-Type: application/json" \
  -d '{"code":"12345678"}'
```

Pairing claims are rate-limited. Revoking an issued device with the admin API immediately closes its active extension socket and prevents reuse of its credential.

```bash
curl https://YOUR_GATEWAY_HOST/devices \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

curl -X DELETE https://YOUR_GATEWAY_HOST/devices/DEVICE_ID \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

The current device registry is process-local; use shared persistent storage before deploying multiple gateway replicas.

#### Remote visual/action safety

- `browser_observe` defaults to a maximum 1280-pixel long edge to reduce image bandwidth/token cost while retaining full CSS-coordinate mapping.
- `browser_inspect` returns a native-detail crop when additional precision is needed.
- Every mutating remote MCP tool requires a fresh `observationId`, including typing, keypresses, navigation, history, tab mutations, and dialog handling.
- DOM mutations and user pointer/keyboard/input/scroll activity invalidate prior observations, so an old action returns `STALE_OBSERVATION`.
- The extension retains local Pause and Disconnect authority; remote pause/resume is not exposed.
- Remote interactive clients are serialized through a control lease.

See [`docs/WEB_CONTROL_PIPELINE.md`](docs/WEB_CONTROL_PIPELINE.md) for the full extension architecture, deployment, pairing and external-client flow.

---

## 6. Programmatic TypeScript API

```typescript
import { ChromeController } from "chrome-computer-use";

const controller = new ChromeController({ mode: "auto" });
await controller.connect();

const obs = await controller.observe({ showCursor: true });

await controller.executeComputerAction({
  type: "click",
  observationId: obs.observationId,
  x: 250,
  y: 180,
  button: "left",
});

await controller.executeComputerAction({
  type: "type",
  text: "Hello World",
  method: "auto",
});

await controller.executeComputerAction({
  type: "keypress",
  keys: ["Meta", "A"],
});

await controller.disconnect();
```

---

## 7. Test Suites & Verification

```bash
# Core coordinates, inputs, protocol, controller, MCP, CLI, vision and agent tests
npm run test:unit

# Focused remote gateway/auth tests
npm run test:web

# Extension helpers and normalized-keyboard tests
npx vitest run tests/extension

# Live integration tests where their environment prerequisites are available
npm run test:integration

# Entire Vitest suite
npm test
```

The `Web Control Pipeline CI` workflow gates `main` and the release-hardening branch with deterministic `npm ci`, TypeScript build, the full core unit suite, remote tests, extension tests, and a headed Chrome-for-Testing WSS/MCP canary. The canary exercises the real MV3 service worker and popup, screenshot delivery, scaled overview metadata, an observation-bound click, and rejection of a stale observation after an external DOM mutation.
