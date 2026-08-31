# browserControl Web Control Pipeline

browserControl's extension-first path lets a remote MCP client such as Claude web or a compatible ChatGPT MCP/app surface control a real Chrome tab while the web AI remains the only reasoning model.

## Architecture

```text
Remote AI web client
        |
        | Streamable HTTP MCP
        v
browserControl gateway
        |
        | authenticated outbound WebSocket
        v
browserControl Chrome extension
        |
        | chrome.debugger / CDP
        v
User-selected Chrome tab
```

The Chrome debugging port is never exposed to the internet. The extension must be connected and the user must explicitly share a tab before browser observations or actions can occur.

## Current model-facing tools

### Observation

- `browser_status` - extension, shared-tab and lease state
- `browser_observe` - scaled shared-tab overview + observation metadata
- `browser_inspect` - native-detail nested crop of an existing observation
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

All visual coordinates use a model-facing 0-1000 coordinate space.

`browser_inspect` returns another observation with its own 0-1000 coordinate system. Nested inspection is supported; browserControl maps an action from the final crop back to the original Chrome viewport.

## Safety invariants

1. **Explicit initial tab sharing** - a remote request cannot implicitly attach the first tab. Until the user presses **Share active tab**, observation/action requests fail with `NO_TAB_SHARED`.
2. **Local Pause wins** - Pause is controlled from the extension popup. A remote AI cannot resume a user-paused browserControl session.
3. **Disconnect stays disconnected** - explicit local Disconnect detaches the debugger and suppresses automatic reconnect until the user chooses Pair/Connect again.
4. **Normalized coordinates** - web models operate in a stable 0-1000 coordinate system independent of DPR and overview image scaling.
5. **Observation binding for mutations** - every mutating MCP tool requires the exact `observationId` it was planned from. Read-only status/tab-list operations are exempt.
6. **External-change invalidation** - page mutations, user pointer/keyboard/input/scroll activity, navigation, execution-context resets and browserControl actions invalidate older observations.
7. **Stale action rejection** - stale actions fail with `STALE_OBSERVATION` instead of acting on outdated visual state.
8. **Control lease** - one MCP client owns interactive control at a time. A second client receives `DEVICE_BUSY` until the lease expires or is released.
9. **Outbound-only Chrome connection** - the extension initiates the gateway connection; CDP itself is never remotely exposed.
10. **No screenshot persistence in the gateway** - current relay responses are forwarded in memory and are not intentionally persisted by browserControl.
11. **Local-only static device secret** - `BROWSERCONTROL_DEVICE_TOKEN` is a loopback development compatibility path only. Public gateways use revocable paired-device credentials.
12. **Separated privileges** - `BROWSERCONTROL_MCP_TOKEN` grants model-facing MCP access; `BROWSERCONTROL_ADMIN_TOKEN` grants pairing/device administration and must never be given to the AI client.

## Local end-to-end setup

### 1. Start the gateway

The easiest local setup is:

```bash
npm ci
npm run build
npm run gateway:setup
set -a; source .browsercontrol.env; set +a
npm run gateway
```

`gateway:setup` generates separate local-development device, MCP and admin credentials.

Local-development defaults:

- MCP: `http://127.0.0.1:8787/mcp`
- extension WebSocket: `ws://127.0.0.1:8787/extension`
- health: `http://127.0.0.1:8787/health`

Use `ws://` only for a loopback development gateway. Deployed gateways must use `wss://`/HTTPS.

### 2. Load and connect the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository's `extension/` directory.
5. Open the browserControl popup.
6. Enter the gateway WebSocket URL.
7. For local development, paste the generated local device token under **Existing device token** and choose **Save token & connect**.
8. Open the tab you want the AI to control.
9. Click **Share active tab**.

The extension requests access only to the configured gateway origin when HTTP access is needed for pairing/health checks. It no longer requests blanket `<all_urls>` host access.

Chrome displays its debugger/extension indicator while the selected tab is attached.

## Deployed device pairing

A public gateway should not set `BROWSERCONTROL_DEVICE_TOKEN`.

Create a one-time pairing code with the **admin** bearer token:

```bash
curl -X POST https://YOUR_GATEWAY_HOST/pairing/create \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chrome laptop"}'
```

The default code is eight digits, expires after five minutes and is single-use. Pairing claims are rate-limited.

In the extension popup:

1. Enter `wss://YOUR_GATEWAY_HOST/extension`.
2. Enter the returned pairing code.
3. Click **Pair & connect**.

The popup requests the exact gateway HTTP origin, claims the code, stores the returned revocable device token locally and connects automatically. Manual token copying is not required.

For API-driven setup, `/pairing/claim` remains available:

```bash
curl -X POST https://YOUR_GATEWAY_HOST/pairing/claim \
  -H "Content-Type: application/json" \
  -d '{"code":"12345678"}'
```

Review or revoke devices with the admin token:

```bash
curl https://YOUR_GATEWAY_HOST/devices \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

curl -X DELETE https://YOUR_GATEWAY_HOST/devices/DEVICE_ID \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

Revocation immediately closes currently connected WebSockets for that credential and prevents reconnect. The current credential registry is process-local; persistent shared storage is still required before multi-instance deployment.

## Connect an MCP client

For a local test client:

```text
http://127.0.0.1:8787/mcp
```

For a remote web client, deploy the gateway publicly behind HTTPS/WSS and use:

```text
https://YOUR_GATEWAY_HOST/mcp
```

Preferred authentication:

```text
Authorization: Bearer <BROWSERCONTROL_MCP_TOKEN>
```

For an MVP client that cannot supply a header, the gateway also accepts the same capability token in the MCP URL query string:

```text
https://YOUR_GATEWAY_HOST/mcp?token=<BROWSERCONTROL_MCP_TOKEN>
```

Treat that URL as a secret. Public production deployment should eventually replace static connector credentials with MCP-standard OAuth.

## Visual loop

```text
browser_observe(maxLongEdge=1280)
    -> scaled overview image + observationId

model can act immediately
    -> browser_click / browser_type / browser_keypress / ...
       (all mutations include observationId)

or request detail
    -> browser_inspect(observationId, region)
    -> native-detail crop + new observationId
    -> action relative to crop

then browser_observe again
```

`browser_observe` defaults to a maximum 1280-pixel long edge, reducing image bandwidth/token cost while preserving the full CSS viewport as the coordinate source. `browser_inspect` captures a native-detail region when the model needs more precision.

Example click:

```json
{
  "observationId": "123:7:...",
  "x": 650,
  "y": 410,
  "button": "left"
}
```

Example typing action:

```json
{
  "observationId": "123:7:...",
  "text": "hello"
}
```

If the page or user changes visual state after an observation was captured, the extension returns `STALE_OBSERVATION` and the model must observe again.

## Claude web target

```text
Claude.ai
  -> public browserControl MCP URL
  -> gateway
  -> extension
  -> Chrome
```

Claude is the recommended first external product canary. Exact connector availability is controlled by Anthropic and can change independently of browserControl.

## ChatGPT web target

The same remote MCP endpoint is intended for ChatGPT custom MCP/app surfaces that support image-returning and mutating tools. Plan/workspace availability and approval behavior are controlled by OpenAI and can change independently of browserControl.

## Validation

```bash
npm run build
npm run test:unit
npm run test:web
npx vitest run tests/extension
```

The GitHub Actions release gate also runs a headed Chrome-for-Testing canary over TLS/WSS. It verifies:

- deterministic `npm ci`
- extension JavaScript parsing
- the full core unit suite
- remote gateway/auth/pairing tests
- extension helper/keyboard tests
- MCP 2026-07-28 negotiation
- real unpacked MV3 extension loading
- real popup/service-worker/WSS connectivity
- scaled overview image metadata
- screenshot delivery as MCP image content
- observation-bound real Chrome click
- external DOM mutation invalidates a previous observation
- remote pause/resume remain unavailable
- active paired-device revocation closes the device socket

## Remaining production/integration work

The browser-control pipeline itself is implemented. Work that still depends on deployment/distribution or a larger account model includes:

- real Chrome release testing across macOS, Windows and Linux (CI currently proves Chrome for Testing on Linux)
- a real Claude.ai connector canary against a publicly deployed gateway
- a real ChatGPT connector canary where the user's ChatGPT plan/workspace exposes write-capable custom MCP
- MCP-standard OAuth instead of static connector capability tokens
- persistent shared credential storage before running multiple gateway replicas
- multi-user / multi-device routing instead of the current single active extension bridge
- packaged/signed Chrome Web Store distribution and store review

The existing Node/raw-CDP controller remains supported for local agents, CLI use, tests and environments where an extension is not appropriate.
