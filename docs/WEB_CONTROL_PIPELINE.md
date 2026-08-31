# browserControl Web Control Pipeline

browserControl lets a remote MCP client such as Claude web control a real Chrome tab while the web AI remains the only reasoning model.

## Architecture

Claude does **not** connect to the user's localhost. Remote MCP calls originate in the AI provider's cloud, so browserControl uses a publicly reachable relay. The browser extension independently opens an outbound WebSocket to that relay.

```text
Claude / remote AI cloud
        |
        | HTTPS Streamable HTTP MCP
        | device-scoped MCP credential
        v
browserControl public relay
        |
        | server-side credential -> deviceId routing
        v
DeviceRouter[deviceId]
        |
        | existing outbound WSS connection
        v
browserControl Chrome extension
        |
        | chrome.debugger / CDP
        v
User's Chrome
```

The Chrome debugging port is never exposed to the internet. NAT, residential IP changes and local firewalls do not require inbound access because the extension initiates the relay connection.

## Multi-device routing model

A single relay process can keep many paired Chrome devices connected concurrently. Pairing provisions two independent random credentials for each device:

- `deviceToken` authenticates the extension's WSS connection.
- `mcpToken` authenticates the remote MCP connector and identifies the target device.

The relay stores SHA-256 digests only. A client-supplied `deviceId` is never trusted for routing. After authenticating the MCP token, the relay resolves the device server-side and dispatches tools only to that device's `ExtensionBridge`.

Each device has an independent WebSocket bridge and control lease. Reconnecting one device replaces only that device's previous socket; it does not disconnect another user's browser.

## Model-facing tools

### Observation

- `browser_status` - routed device, extension, shared-tab and lease state
- `browser_observe` - scaled shared-tab overview + observation metadata
- `browser_inspect` - native-detail nested crop
- `browser_tabs` - read-only tab list

### Computer use

- `browser_move`
- `browser_click`
- `browser_double_click`
- `browser_drag`
- `browser_scroll`
- `browser_type`
- `browser_keypress`

### Browser chassis

- `browser_navigate`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_switch_tab`
- `browser_new_tab`
- `browser_close_tab`
- `browser_handle_dialog`
- `browser_release_control`

All visual coordinates use a model-facing 0-1000 coordinate space. Every mutating tool is observation-bound.

## Safety invariants

1. **Explicit initial tab sharing** - until the user presses **Share active tab**, observation/action requests fail with `NO_TAB_SHARED`.
2. **Local Pause wins** - a remote AI cannot resume a user-paused session.
3. **Disconnect stays disconnected** - local Disconnect detaches the debugger and stops reconnect until the user reconnects.
4. **Observation binding** - every mutation requires the exact `observationId` it was planned from.
5. **External-change invalidation** - DOM changes, user pointer/keyboard/input/scroll activity, navigation and execution-context changes invalidate old observations.
6. **Stale action rejection** - stale mutations fail with `STALE_OBSERVATION`.
7. **Per-device control lease** - concurrent MCP clients contend only for the same browser device. Different devices have independent leases.
8. **Credential-scoped routing** - the remote MCP credential selects its device server-side. The AI does not choose a trusted device ID.
9. **Outbound-only browser connection** - the extension connects outward to the relay; CDP is never internet-facing.
10. **No screenshot persistence in the relay** - screenshots are forwarded in memory and are not intentionally stored.
11. **Immediate revocation** - revoking a device invalidates both its extension and MCP credentials and closes its active WebSocket.
12. **Separated privileges** - `BROWSERCONTROL_ADMIN_TOKEN` administers pairing/devices. It must never be given to an AI connector.
13. **Public relays reject global credentials** - `BROWSERCONTROL_DEVICE_TOKEN` and `BROWSERCONTROL_MCP_TOKEN` are loopback-development compatibility paths only.

The intentionally deferred shared-tab-scope policy is unchanged: after initial sharing, the current tab-management surface can still enumerate/switch/close tabs as previously implemented.

## Public relay setup

A public relay needs a trusted HTTPS/WSS hostname and one admin credential:

```text
BROWSERCONTROL_GATEWAY_HOST=0.0.0.0
BROWSERCONTROL_ADMIN_TOKEN=<long-random-admin-secret>
BROWSERCONTROL_TRUST_PROXY=1   # only behind a trusted reverse proxy
```

Do **not** configure `BROWSERCONTROL_DEVICE_TOKEN` or `BROWSERCONTROL_MCP_TOKEN` on a public relay. Public MCP access is device-scoped and comes from pairing.

For durable pairings, set:

```text
BROWSERCONTROL_DEVICE_STORE_PATH=/durable/path/browsercontrol-devices.json
```

The persisted file contains credential digests and device metadata, never the raw extension/MCP tokens. On a hosted platform the path must be backed by durable storage. Without it, pairings are intentionally ephemeral across relay restarts.

### Create a pairing code

```bash
curl -X POST https://YOUR_RELAY/pairing/create \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chrome laptop"}'
```

The default code is eight digits, single-use, expires after five minutes and is rate-limited.

### Pair the Chrome extension

In the extension popup:

1. Enter `wss://YOUR_RELAY/extension`.
2. Enter the pairing code.
3. Click **Pair & connect**.

The claim response contains:

```json
{
  "deviceId": "...",
  "deviceToken": "...",
  "mcpToken": "..."
}
```

The extension stores the two secrets locally and displays a device-scoped connector URL such as:

```text
https://YOUR_RELAY/mcp?token=<DEVICE_MCP_TOKEN>
```

Copy that URL into Claude's remote MCP connector configuration. Treat it like a password: possession of that URL grants model-facing control of that paired device.

The query-token form exists for clients that cannot configure an Authorization header. Clients that can send headers should use:

```text
Authorization: Bearer <DEVICE_MCP_TOKEN>
```

## Device administration

List devices and online state:

```bash
curl https://YOUR_RELAY/devices \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

Rotate only a device's MCP connector credential:

```bash
curl -X POST https://YOUR_RELAY/devices/DEVICE_ID/connector/rotate \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

The old MCP token becomes invalid immediately. The extension remains connected because its `deviceToken` is independent.

Revoke a device completely:

```bash
curl -X DELETE https://YOUR_RELAY/devices/DEVICE_ID \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

Revocation invalidates both credentials and immediately closes the matching extension WebSocket.

## Local development

For loopback-only development:

```bash
npm ci
npm run build
npm run gateway:setup
set -a; source .browsercontrol.env; set +a
npm run gateway
```

`gateway:setup` creates compatibility credentials for:

- extension: `ws://127.0.0.1:8787/extension`
- MCP: `http://127.0.0.1:8787/mcp?token=...`

Those global/static credentials are deliberately rejected when the relay is public.

## Visual loop

```text
browser_observe(maxLongEdge=1280)
    -> scaled overview + observationId

model acts
    -> mutation(observationId, ...)

or inspects
    -> browser_inspect(observationId, region)
    -> native-detail crop + new observationId
    -> mutation(newObservationId, ...)

then observe again
```

`browser_observe` defaults to a maximum 1280-pixel long edge to reduce image bandwidth/token cost while retaining the CSS viewport as the coordinate source.

## Claude topology

```text
User Chrome extension
       |
       | outbound WSS
       v
public browserControl relay
       ^
       | HTTPS MCP using that device's MCP token
       |
Anthropic cloud / Claude.ai
```

This public relay is mandatory for Claude web because `localhost` from Claude's cloud environment is not the user's machine.

## Validation

```bash
npm run build
npm run test:unit
npm run test:web
npx vitest run tests/extension
```

The remote suite includes multi-device isolation tests that connect two extension sockets concurrently and prove that each device-scoped MCP token reaches only its paired extension. The GitHub Actions gate also runs the real unpacked MV3 extension through TLS/WSS and MCP against Chrome for Testing.

## Deployment boundary

The current relay is **multi-user/multi-device within one relay process**. Optional durable registry storage survives process restarts.

Horizontal multi-instance deployment is a separate scaling problem because live WebSockets are process-local. Multiple relay replicas would require device-aware sticky routing or a shared connection/pub-sub broker. Do not put multiple stateless replicas behind a random load balancer and expect MCP requests to find the device socket.

Remaining distribution/integration work includes MCP-standard OAuth, Chrome Web Store packaging, broader OS release testing, and live Claude/ChatGPT account canaries.

The existing Node/raw-CDP controller remains supported for local agents, CLI use and environments where an extension is not appropriate.
