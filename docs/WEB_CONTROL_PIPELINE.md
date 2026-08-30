# browserControl Web Control Pipeline

This document covers the new extension-first path for controlling a real Chrome tab from a remote MCP client such as Claude web or ChatGPT custom MCP when write-capable remote tools are available.

## Architecture

```text
Remote AI web client
        |
        | Streamable HTTP MCP
        v
browserControl gateway
        |
        | authenticated WebSocket (outbound from Chrome)
        v
browserControl Chrome extension
        |
        | chrome.debugger / CDP
        v
User-selected Chrome tab
```

The extension attaches only to the tab the user explicitly shares. The user's Chrome debugging port is never exposed to the internet.

## Current model-facing tools

- `browser_status` - connection/control lease state
- `browser_observe` - screenshot + observation metadata, normalized 0-1000 coordinates
- `browser_click` - observation-bound click
- `browser_scroll` - observation-bound wheel input
- `browser_type` - insert text into focused control
- `browser_keypress` - keyboard shortcut
- `browser_navigate` - navigate the shared tab
- `browser_tabs` - read-only tab list
- `browser_switch_tab` - explicitly switch the shared tab
- `browser_release_control` - release exclusive interactive control

The extension also implements nested `inspect_region` RPC internally. Exposing it as a public MCP tool is the next protocol step.

## Safety invariants

1. **Explicit tab sharing**: debugger access is attached to one chosen tab at a time.
2. **Normalized coordinates**: web models operate in a stable 0-1000 space, independent of DPR.
3. **Observation binding**: coordinate actions require the exact `observationId` they were planned from.
4. **Visual epoch**: navigation, load, dialog, input actions and tab changes invalidate older observations.
5. **Stale action rejection**: stale coordinate actions fail with `STALE_OBSERVATION` instead of clicking.
6. **Control lease**: one MCP session has interactive control at a time. Other sessions receive `DEVICE_BUSY`.
7. **Local kill switch**: the extension popup exposes Pause and Disconnect.
8. **Outbound connection**: the extension connects to the gateway; Chrome/CDP is never directly reachable remotely.

## Local end-to-end setup

### 1. Build and start the gateway

```bash
npm install
npm run build

export BROWSERCONTROL_DEVICE_TOKEN="replace-with-a-long-random-token"
# Optional for MCP clients that can provide a Bearer token:
export BROWSERCONTROL_MCP_TOKEN="replace-with-another-long-random-token"

npm run gateway
```

Defaults:

- MCP: `http://127.0.0.1:8787/mcp`
- extension WebSocket: `ws://127.0.0.1:8787/extension`
- health: `http://127.0.0.1:8787/health`

For a remote web AI, deploy the gateway behind HTTPS/WSS (for example a normal TLS reverse proxy or cloud service) and use a `wss://.../extension` URL in the extension.

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this repository's `extension/` directory.
5. Open the browserControl extension popup.
6. Set the gateway WebSocket URL.
7. Set the same `BROWSERCONTROL_DEVICE_TOKEN` used by the gateway.
8. Click **Save & connect**.
9. Open the Chrome tab you want to share.
10. Click **Share active tab**.

Chrome will show its debugger/extension indicator while browserControl is attached.

### 3. Test the remote MCP endpoint

Use any Streamable HTTP MCP client and point it to:

```text
https://YOUR_GATEWAY_HOST/mcp
```

If `BROWSERCONTROL_MCP_TOKEN` is enabled, the client must send:

```text
Authorization: Bearer <token>
```

First call:

```text
browser_status
```

Then:

```text
browser_observe
```

The response contains an image and metadata similar to:

```json
{
  "observationId": "123:7:...",
  "visualEpoch": 7,
  "targetId": "123",
  "coordinateSpace": "normalized_1000",
  "viewportWidth": 1440,
  "viewportHeight": 900
}
```

A model can then call:

```json
{
  "tool": "browser_click",
  "arguments": {
    "observationId": "123:7:...",
    "x": 650,
    "y": 410
  }
}
```

and observe again.

## Claude web target

The desired production flow is:

```text
Claude.ai
  -> browserControl remote MCP URL
  -> browserControl gateway
  -> browserControl extension
  -> shared Chrome tab
```

The gateway must be publicly reachable over HTTPS, and the extension must use the corresponding WSS URL. Production deployment should use MCP-standard OAuth instead of a static bearer token.

## ChatGPT web target

The same MCP endpoint can be used by ChatGPT custom MCP/app surfaces that support image-returning tools and write actions. Product availability/plan restrictions are controlled by ChatGPT and may change independently of browserControl.

## Remaining production hardening

Before calling the cloud path production-ready:

- expose `inspect_region` through MCP
- add drag/double-click/mouse move and richer keyboard parity
- add back/forward/reload/dialog actions
- replace single-device gateway state with user/device registry
- implement OAuth 2.1 / MCP authorization metadata
- add revocable device credentials and pairing flow
- persist no screenshot/browser content by default
- add gateway rate limiting and structured audit events
- package/publish the Chrome extension
- run real Claude.ai and ChatGPT web canary tests

The existing Node/CDP controller remains supported for local agents, CLI use, tests and environments where a Chrome extension is not appropriate.
