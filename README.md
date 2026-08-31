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

The repository supports two complementary paths: the original Node/raw-CDP controller for local agents, and an extension-first routed relay that gives compatible web AI clients an authenticated screen/mouse/keyboard connection to Chrome without adding a second reasoning model.

## Core Principles & Guarantees

- **100% Selectorless**: Interacts through viewport pixels, normalized coordinates, and keyboard strokes. No DOM/CSS selectors, Playwright/Puppeteer abstractions, or accessibility refs are required for correctness.
- **Connects to Existing Chrome**: Re-uses the user's running Chrome session, cookies, logins, profile, and tabs via Chrome remote debugging or the browserControl MV3 extension.
- **Direct CDP Transport**: Chrome DevTools Protocol interaction with no heavy automation wrapper.
- **Observation Guardrails**: Screenshots yield an `observationId` and `visualEpoch`. External visual changes invalidate observations, and every mutating remote MCP tool is observation-bound.
- **Cloud-safe Relay**: Claude/remote AI connects to a public HTTPS MCP relay while the local extension maintains an outbound WSS connection. No AI cloud service is expected to reach the user's localhost.
- **Device-scoped Routing**: Pairing creates independent extension and MCP credentials. MCP authentication resolves the target device server-side, so many users/devices can remain connected to one relay process without cross-routing.
- **Separated Administration**: The admin credential can pair, list, rotate, and revoke devices; it is never the model-facing credential.

---

## 1. Quick Start

### Prerequisites
1. **Node.js** (v20+)
2. **Google Chrome**

```bash
npm ci
npm run build
```

---

## 2. Local raw-CDP connection modes

The Node controller supports:

1. **`auto`** (`CHROME_CONNECT_MODE=auto`) - discovers an active Chrome debugging session where supported.
2. **`browser-url`** (`CHROME_BROWSER_URL=http://127.0.0.1:9222`) - connects to an explicit HTTP debugging endpoint.
3. **`ws-endpoint`** (`CHROME_WS_ENDPOINT=ws://...`) - connects directly to a Chrome WebSocket debugger URL.

Run diagnostics with:

```bash
npm run doctor
```

Launch the interactive CLI with:

```bash
npm run cli
```

---

## 3. Model Context Protocol (MCP)

### Local agents

```bash
npm run mcp
# or
npm run mcp:http
```

The local stdio/HTTP path remains supported for local raw-CDP agents.

### Remote web control: Claude / compatible MCP clients

A remote web AI runs in its provider's cloud. Therefore the required topology is:

```text
User Chrome extension
       |
       | outbound WSS
       v
public browserControl relay
       ^
       | HTTPS MCP, device-scoped token
       |
Claude / remote AI cloud
```

A public relay does **not** use one global MCP token. Pairing provisions per-device credentials:

- `deviceToken` -> authenticates that extension's WSS connection
- `mcpToken` -> authenticates the remote MCP connector and routes it to that device

The relay stores only credential digests.

#### Public relay environment

```text
BROWSERCONTROL_GATEWAY_HOST=0.0.0.0
BROWSERCONTROL_ADMIN_TOKEN=<long-random-admin-secret>
BROWSERCONTROL_TRUST_PROXY=1     # only behind a trusted reverse proxy
```

Optional durable pairings:

```text
BROWSERCONTROL_DEVICE_STORE_PATH=/durable/path/browsercontrol-devices.json
```

Do **not** configure `BROWSERCONTROL_DEVICE_TOKEN` or `BROWSERCONTROL_MCP_TOKEN` on a public relay. Those are loopback-development compatibility options and are rejected in public mode.

#### Pair a device

Create an eight-digit, single-use pairing code:

```bash
curl -X POST https://YOUR_RELAY/pairing/create \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chrome laptop"}'
```

Then in the extension popup:

1. Enter `wss://YOUR_RELAY/extension`.
2. Enter the pairing code.
3. Click **Pair & connect**.
4. Copy the generated **Claude / remote MCP connector URL**.
5. Add that URL as the remote MCP connector in Claude.
6. Click **Share active tab** when you want browser control enabled.

The generated connector URL is device-scoped:

```text
https://YOUR_RELAY/mcp?token=<DEVICE_MCP_TOKEN>
```

Treat it like a password. If a client supports custom headers, use `Authorization: Bearer <DEVICE_MCP_TOKEN>` instead of the query form.

#### Admin operations

```bash
# List devices and connection state
curl https://YOUR_RELAY/devices \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

# Rotate only the device's MCP connector token
curl -X POST https://YOUR_RELAY/devices/DEVICE_ID/connector/rotate \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

# Revoke the device completely
curl -X DELETE https://YOUR_RELAY/devices/DEVICE_ID \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

Connector rotation leaves the extension connected. Full revocation invalidates both device credentials and immediately closes that device's WebSocket.

#### Multi-device behavior

One relay process maintains a `DeviceRouter` with an independent extension bridge and interactive lease for every paired device. A reconnect replaces only the same device's socket. MCP requests are routed from the authenticated token rather than from a client-supplied device ID.

For horizontal multi-instance scaling, live WebSocket ownership must also be routed (for example with sticky/device-aware routing or a shared broker). Randomly load-balancing MCP requests across stateless replicas is not sufficient.

---

## 4. Remote visual/action safety

- `browser_observe` defaults to a maximum 1280-pixel long edge to reduce image bandwidth/token cost while retaining CSS-coordinate mapping.
- `browser_inspect` returns a native-detail crop when additional precision is needed.
- Every mutating remote MCP tool requires a fresh `observationId`.
- DOM mutations and user pointer/keyboard/input/scroll activity invalidate prior observations, so old actions return `STALE_OBSERVATION`.
- The extension retains local Pause and Disconnect authority; remote pause/resume is not exposed.
- Interactive leases are independent per device.
- Screenshots are forwarded in memory and are not intentionally persisted by the relay.

The previously deferred shared-tab-scope behavior is intentionally unchanged in this release.

See [`docs/WEB_CONTROL_PIPELINE.md`](docs/WEB_CONTROL_PIPELINE.md) for the full relay, pairing, routing, deployment, and external-client flow.

---

## 5. Programmatic TypeScript API

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

await controller.executeComputerAction({ type: "type", text: "Hello World", method: "auto" });
await controller.executeComputerAction({ type: "keypress", keys: ["Meta", "A"] });
await controller.disconnect();
```

---

## 6. Test Suites & Verification

```bash
npm run test:unit
npm run test:web
npx vitest run tests/extension
npm run test:integration
npm test
```

The `Web Control Pipeline CI` workflow runs deterministic install/build, the core suite, routed-relay tests, extension tests, and a headed Chrome-for-Testing WSS/MCP canary. The remote suite includes simultaneous two-device routing isolation, device credential rotation/revocation, durable credential-digest persistence, public/loopback trust-boundary tests, and chunked request-size enforcement.
