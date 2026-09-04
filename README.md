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
- **Device-scoped Routing**: Every enrolled Chrome profile receives independent extension and MCP credentials. Authentication resolves the target device server-side.
- **Horizontal Relay Routing**: Replicas share Redis control-plane state and forward MCP directly to the replica that owns the device WebSocket, so ordinary load balancing is safe.
- **Separated Administration**: The admin credential lists, rotates, and revokes devices; the cluster credential is relay-internal; neither is part of normal user onboarding or model-facing traffic.

---

## 1. Quick Start

### Prerequisites

1. **Node.js** (v20+)
2. **Google Chrome**

```bash
npm ci
npm run build
```

### Production extension + Claude.ai

The normal user path is intentionally short:

```text
Load browserControl extension
        ↓
Click Connect browserControl
        ↓
Add https://browsercontrol-relay-production.up.railway.app/mcp to Claude once
        ↓
Approve browserControl OAuth once
        ↓
Ask Claude to use the browser
```

Users do **not** enter a relay URL, admin token, pairing code, device token, or MCP token.

The extension uses the managed production endpoints internally:

```text
WSS  wss://browsercontrol-relay-production.up.railway.app/extension
MCP  https://browsercontrol-relay-production.up.railway.app/mcp
```

Many users can connect to the same WSS endpoint at the same time. Each connection is authenticated and routed by its independently issued `deviceId` and device credential.

On first connect, the extension performs a short-lived proof-bound self-enrollment flow. The relay issues device-scoped credentials only after a single-use enrollment ticket is claimed. The admin bearer token is not involved.

Claude uses browserControl's OAuth discovery, Dynamic Client Registration, authorization code + PKCE `S256`, opaque access tokens, and rotating refresh tokens. The extension verifies its local paired device on browserControl's authorization page, so the user does not copy an MCP secret into Claude.

See [`docs/CLAUDE_OAUTH.md`](docs/CLAUDE_OAUTH.md) for the complete production and Claude flow.

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

### Remote web control

A remote web AI runs in its provider's cloud. The production topology is:

```text
User Chrome extension
       |
       | outbound authenticated WSS
       v
public browserControl relay / relay cluster
       ^
       | HTTPS MCP + OAuth
       |
Claude / remote AI cloud
```

A public relay does **not** use one global browser credential. Self-enrollment provisions per-device credentials:

- `deviceToken` authenticates that extension's WSS connection.
- `mcpToken` anchors device-scoped connector authorization and is kept inside browserControl's extension/OAuth flow.
- Claude receives its own OAuth access/refresh tokens rather than the device MCP credential.

Only credential digests and control-plane metadata are stored server-side. Screenshots and browser RPC payloads are not persisted in Redis.

### Automatic active-tab control

Connecting the extension does **not** immediately attach Chrome's debugger.

On the first authenticated browser action, browserControl automatically attaches the active normal `http://` or `https://` tab. By default, an active control session follows the tab the user selects. Switching to a restricted Chrome/internal page detaches control.

After 15 minutes without remote browser activity, browserControl detaches automatically. **Pause** detaches immediately and blocks remote actions until resumed. **Disconnect** closes the relay connection and detaches locally.

The popup still exposes toggles for:

- **Auto-use active tab**
- **Follow active tab**

so the user can make the boundary stricter without changing relay configuration.

### Public relay environment

Current Railway deployment:

```text
BROWSERCONTROL_GATEWAY_HOST=0.0.0.0
PORT=8787
BROWSERCONTROL_ADMIN_TOKEN=<long-random-admin-secret>
BROWSERCONTROL_REDIS_URL=<Railway Redis REDIS_URL>
BROWSERCONTROL_REDIS_PREFIX=browsercontrol
BROWSERCONTROL_RELAY_CLUSTER_TOKEN=<different-long-random-secret>
BROWSERCONTROL_RELAY_REPLICA_ID=railway-relay-01
BROWSERCONTROL_RELAY_INTERNAL_URL=http://browsercontrol-relay.railway.internal:8787
BROWSERCONTROL_TRUST_PROXY=0
```

Railway provides `RAILWAY_PUBLIC_DOMAIN`; browserControl uses it automatically as the public OAuth issuer. Other hosts can set:

```text
BROWSERCONTROL_PUBLIC_BASE_URL=https://relay.example.com
```

Do **not** configure `BROWSERCONTROL_DEVICE_TOKEN` or `BROWSERCONTROL_MCP_TOKEN` on a public relay. Those remain loopback-development compatibility options and are rejected in public mode.

A hidden loopback-only developer gateway override remains available through extension storage for local testing. The normal popup never asks users for a gateway URL.

### Self-enrollment

The public extension enrollment flow is:

```text
extension creates 256-bit nonce
        ↓
POST /enroll/start with SHA-256(nonce)
        ↓
60-second random enrollment ticket
        ↓
POST /enroll/claim with ticket + original nonce
        ↓
atomic single-use claim
        ↓
deviceId + deviceToken + mcpToken
        ↓
authenticated WSS connection
```

Enrollment is rate-limited per client address and globally. The temporary ticket cannot authenticate `/extension` or `/mcp` and becomes useless immediately after claim.

The older admin-created `/pairing/create` and `/pairing/claim` endpoints remain available for operator/testing compatibility, but they are **not** part of production user onboarding.

### Admin operations

The admin bearer token remains operator-only:

```bash
# List devices, connection state, and current owner replica
curl https://YOUR_RELAY/devices \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

# Rotate only the device's MCP connector credential
curl -X POST https://YOUR_RELAY/devices/DEVICE_ID/connector/rotate \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

# Revoke the device completely
curl -X DELETE https://YOUR_RELAY/devices/DEVICE_ID \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

Connector rotation leaves the extension device connection intact but invalidates OAuth grants bound to the old connector version. Full revocation invalidates the device credentials and asks the owning relay to close that device's WebSocket immediately.

### Multi-device and horizontal behavior

Each owning relay process maintains a `DeviceRouter` with an independent extension bridge and interactive lease for every locally connected device. A reconnect replaces only the same device's socket.

With Redis enabled, all replicas share:

- hashed device/MCP credential indexes
- short-lived enrollment/pairing state
- OAuth client/code/access/refresh state
- distributed rate-limit counters
- TTL-backed device ownership records

An MCP request can hit **any** healthy replica. The entry replica authenticates the device/OAuth principal, resolves the current WebSocket owner from Redis, and forwards the MCP HTTP request directly to that owner's private relay endpoint using `BROWSERCONTROL_RELAY_CLUSTER_TOKEN`. Payloads do not transit Redis.

If an owner dies, its presence expires automatically and the extension reconnects to another replica. If a device reconnects elsewhere before expiry, the newer connection wins and the old owner stops refreshing its stale connection ID.

---

## 4. Remote visual/action safety

- `browser_observe` defaults to a maximum 1280-pixel long edge to reduce image bandwidth/token cost while retaining CSS-coordinate mapping.
- `browser_inspect` returns a native-detail crop when additional precision is needed.
- Every mutating remote MCP tool requires a fresh `observationId`.
- DOM mutations and user pointer/keyboard/input/scroll activity invalidate prior observations, so old actions return `STALE_OBSERVATION`.
- Automatic attachment is limited to normal HTTP(S) pages; Chrome/internal pages are not automatically controlled.
- The extension retains local Pause and Disconnect authority; remote pause/resume is not exposed.
- Active control sessions detach after inactivity.
- Interactive leases are independent per device and stay consistent because requests for one connected device converge on its owning relay.
- Screenshots are forwarded in memory and are not intentionally persisted by the relay or Redis.

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

The `Web Control Pipeline CI` workflow starts Redis 7, runs deterministic install/build, the core suite, routed-relay/OAuth tests, extension tests, and a headed Chrome-for-Testing WSS/MCP canary. The remote suite proves simultaneous multi-device isolation plus real two-replica routing, and the OAuth suite proves self-enrollment, proof-bound single-use tickets, DCR + PKCE, refresh-token rotation, and device-grant invalidation.
