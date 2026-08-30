# browserControl Web Control Pipeline

browserControl's extension-first path lets a remote MCP client such as Claude web or ChatGPT custom MCP control a real Chrome tab while the web AI remains the only reasoning model.

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

The Chrome debugging port is never exposed to the internet. The extension must be connected and the user must explicitly share a tab before any browser observation or action can occur.

## Current model-facing tools

### Observation

- `browser_status` - extension, shared-tab and lease state
- `browser_observe` - full shared-tab screenshot + observation metadata
- `browser_inspect` - high-detail nested crop of an existing observation
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

1. **Explicit tab sharing** - a remote request cannot implicitly attach a tab. Until the user presses **Share active tab**, observation/action requests fail with `NO_TAB_SHARED`.
2. **Local Pause wins** - Pause is controlled from the extension popup. A remote AI cannot resume a user-paused browserControl session.
3. **Disconnect stays disconnected** - explicit local Disconnect detaches the debugger and suppresses automatic reconnect until the user chooses Save & connect again.
4. **Normalized coordinates** - web models operate in a stable 0-1000 coordinate system independent of DPR.
5. **Observation binding** - coordinate actions require the exact `observationId` they were planned from.
6. **Visual epoch** - navigation, load, dialogs, input actions and tab changes invalidate older observations.
7. **Stale action rejection** - stale coordinate actions fail with `STALE_OBSERVATION` instead of clicking an outdated location.
8. **Control lease** - one MCP session owns interactive control at a time. A second session receives `DEVICE_BUSY` until the lease expires or is released.
9. **Outbound-only Chrome connection** - the extension initiates the gateway connection; CDP itself is never remotely exposed.
10. **No screenshot persistence in the gateway** - current relay responses are forwarded in memory and are not intentionally persisted by browserControl.

## Local end-to-end setup

### 1. Start the gateway

```bash
npm ci
npm run build

export BROWSERCONTROL_DEVICE_TOKEN="replace-with-a-long-random-token"
export BROWSERCONTROL_MCP_TOKEN="replace-with-another-long-random-token"

npm run gateway
```

Local-development defaults:

- MCP: `http://127.0.0.1:8787/mcp`
- extension WebSocket: `ws://127.0.0.1:8787/extension`
- health: `http://127.0.0.1:8787/health`

`Dockerfile` is included for deploying the gateway to an HTTPS/WSS-capable host. It honors the platform `PORT` environment variable.

The extension starts with no gateway URL configured. Use the `ws://` endpoint only for a loopback development gateway; deployed gateways must use `wss://`.

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository's `extension/` directory.
5. Open the browserControl popup.
6. Enter the gateway WebSocket URL.
7. Enter the same `BROWSERCONTROL_DEVICE_TOKEN` used by the gateway.
8. Click **Save & connect**.
9. Open the tab you want the AI to control.
10. Click **Share active tab**.

Chrome displays its debugger/extension indicator while the selected tab is attached.

### Pair a device without sharing a static device secret

Create a one-time pairing code with the MCP bearer token:

```bash
curl -X POST https://YOUR_GATEWAY_HOST/pairing/create \
  -H "Authorization: Bearer $BROWSERCONTROL_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chrome laptop"}'
```

Claim it on the device being paired:

```bash
curl -X POST https://YOUR_GATEWAY_HOST/pairing/claim \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}'
```

Put the returned `deviceToken` in the extension popup and use `wss://YOUR_GATEWAY_HOST/extension`. Issued credentials can be reviewed with authenticated `GET /devices` and revoked with `DELETE /devices/:deviceId`. The current registry is process-local; persistent storage is required for multi-instance deployments.

### 3. Connect an MCP client

For a local test client:

```text
http://127.0.0.1:8787/mcp
```

For Claude/ChatGPT web, deploy the gateway publicly behind HTTPS/WSS and use:

```text
https://YOUR_GATEWAY_HOST/mcp
```

If the MCP client supports custom headers:

```text
Authorization: Bearer <BROWSERCONTROL_MCP_TOKEN>
```

For an MVP client that cannot supply a header, the gateway also accepts the same capability token in the MCP URL query string:

```text
https://YOUR_GATEWAY_HOST/mcp?token=<BROWSERCONTROL_MCP_TOKEN>
```

Treat that URL as a secret. Production deployment should replace this static-token path with MCP-standard OAuth.

## Visual loop

```text
browser_observe
    -> overview image + observationId

model can act immediately
    -> browser_click / browser_scroll / ...

or request detail
    -> browser_inspect(observationId, region)
    -> high-detail crop + new observationId
    -> action relative to crop

then browser_observe again
```

Example click:

```json
{
  "observationId": "123:7:...",
  "x": 650,
  "y": 410,
  "button": "left"
}
```

If the screen changed after that observation was captured, the extension returns `STALE_OBSERVATION` and the model must observe again.

## Claude web target

```text
Claude.ai
  -> public browserControl MCP URL
  -> gateway
  -> extension
  -> explicitly shared Chrome tab
```

This is the first recommended external canary because Claude supports custom remote MCP connectors capable of invoking tools. Exact account/product availability is controlled by Anthropic and can change independently of browserControl.

## ChatGPT web target

The same remote MCP endpoint is intended for ChatGPT custom MCP/app surfaces that support image-returning and mutating tools. ChatGPT's plan-level availability and approval behavior are controlled by OpenAI and can change independently of browserControl.

## Validation

```bash
npm run build
npm run test:web
```

The focused web-pipeline CI verifies:

- extension JavaScript parses
- TypeScript gateway builds
- official MCP client connects over Streamable HTTP
- screenshots are returned as MCP image content
- normalized actions route to the extension connection
- `browser_inspect` returns a new image observation
- only one MCP session can hold interactive control

## Remaining production work

The hackathon/product MVP transport is implemented, but production deployment still needs:

- real Chrome extension canary testing across Chrome/macOS/Windows/Linux
- real Claude.ai and ChatGPT web connector canaries
- MCP-standard OAuth 2.1 authorization instead of static capability tokens
- persistent multi-instance storage for the currently revocable device pairing credentials
- multi-user / multi-device gateway routing instead of the current single connected device
- gateway rate limits, abuse controls and privacy-safe audit metadata
- packaged/signed Chrome Web Store distribution
- richer extension keyboard compatibility testing
- current MCP SDK/spec compatibility review before public launch

The existing Node/raw-CDP controller remains supported for local agents, CLI use, tests and environments where an extension is not appropriate.
