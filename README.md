# browserControl

**Universal browser I/O for AI agents.**

browserControl gives an AI agent a screen, mouse, and keyboard connected to your existing Chrome session.

The agent keeps using its own model for reasoning. browserControl does not add another model, browser, or automation runtime in the middle. It exposes Chrome through MCP, returns screenshots to the agent, and turns the agent's tool calls into real mouse, keyboard, navigation, and tab actions in the browser you already use.

Local agents connect directly on the same machine. Remote agents use the browserControl relay only when they need a route back to your Chrome.

```text
                         AI agent
                            │
              ┌─────────────┴─────────────┐
              │                           │
         local agent                 remote agent
              │                           │
         stdio MCP                  HTTPS MCP + OAuth
              │                           │
              ▼                           ▼
     browserControl local          browserControl relay
              │                           │
              │ localhost WS              │ authenticated WSS
              └─────────────┬─────────────┘
                            ▼
                    Chrome extension
                            │
                     chrome.debugger
                            ▼
                     existing Chrome
```

Both modes expose the same browser tools and the same observation-safety rules. The transport changes; the browser-control interface does not.

That means an agent can work with the same tabs, cookies, logins, sessions, and websites you already have open instead of launching a separate automation browser.

## What browserControl does

browserControl exposes a visual computer-use interface over MCP.

The basic loop is:

```text
browser_observe
      ↓
Chrome screenshot
      ↓
agent's model understands the page
      ↓
browser_click / browser_type / browser_scroll / ...
      ↓
real Chrome changes
      ↓
observe again
```

The model sees the screenshot and decides what to do. browserControl only provides the browser I/O layer.

### Browser tools

Local and remote MCP clients receive the same tool surface:

```text
browser_status
browser_observe
browser_inspect
browser_move
browser_click
browser_double_click
browser_drag
browser_scroll
browser_type
browser_keypress
browser_navigate
browser_back
browser_forward
browser_reload
browser_tabs
browser_switch_tab
browser_new_tab
browser_close_tab
browser_handle_dialog
browser_release_control
```

A connected agent can:

- inspect browserControl and the current shared-tab state
- capture the current page as an image
- inspect a higher-detail region of an observation
- move, click, double-click, drag, and scroll
- type text and send keyboard shortcuts
- navigate, go back, go forward, and reload
- list, switch, open, and close tabs
- accept or dismiss JavaScript dialogs
- release its interactive-control lease when finished

Coordinates use a normalized `0-1000` space, so the agent can reason against screenshots without depending on a particular display resolution.

## Two connection modes

### Local mode

Use local mode when the AI agent and Chrome are running on the same computer.

```text
local MCP client
      │ stdio
      ▼
browserControl local process
      │ ws://127.0.0.1:8765
      ▼
Chrome extension
      │
      ▼
existing Chrome
```

The browserControl process binds its extension bridge to loopback only. The extension discovers it automatically and establishes the local connection.

In local mode:

- browser screenshots and browser RPCs do not pass through the hosted browserControl relay
- no browserControl OAuth flow is needed
- no Chrome remote-debugging port is required for the normal path
- the extension keeps the same Pause, tab-selection, stale-observation, and URL-safety behavior as remote mode
- a local agent gets the same `browser_*` MCP tools as a remote agent

The model provider chosen by your agent may still receive screenshots according to that agent's own configuration. Local mode specifically removes the browserControl relay from the data path.

### Remote mode

Use remote mode when the MCP client runs somewhere that cannot directly reach your computer, such as a hosted web agent.

```text
remote MCP client
      │ HTTPS + OAuth
      ▼
browserControl relay
      │ authenticated WSS
      ▼
Chrome extension
      │
      ▼
existing Chrome
```

The extension maintains an outbound connection, so the remote AI client does not need access to your localhost or Chrome debugger port.

Remote access is independent of local access. Disabling the remote connection does not stop local agents from using browserControl.

## Why use browserControl

### It uses your real Chrome

browserControl does not create a clean Playwright/Puppeteer browser profile for every task. The extension controls the Chrome session you are already using.

If you are signed into GitHub, Gmail, Linear, a dashboard, or another website in Chrome, the agent operates that same authenticated browser state.

### It takes the shortest available path

A local agent should not send a screenshot out to a relay just to get it back on the same machine.

browserControl therefore separates browser semantics from transport:

```text
                 same browser_* tools
                         │
              ┌──────────┴──────────┐
              │                     │
           local WS            remote relay
              │                     │
              └──────────┬──────────┘
                         ▼
                  same extension
                         ▼
                   same Chrome
```

Local agents use the local bridge. Hosted agents use the relay because they need it.

### It is model and harness independent

browserControl is browser I/O, not an AI agent framework.

The reasoning model can come from OpenAI, Anthropic, Google, NVIDIA, an open model, or another provider. The MCP client can be OpenCode, Claude.ai, a coding agent, a local harness, or another compatible MCP client.

For visual use, the model/harness needs to be able to consume image tool results. browserControl deliberately does not insert a second vision model.

### It is visual, not selector-driven

The main interaction model is based on screenshots, normalized coordinates, mouse input, and keyboard input.

The agent does not need browserControl-specific CSS selectors, DOM locators, accessibility references, or Playwright APIs in order to operate a page.

### Browser authority stays local

The Chrome extension owns the final connection to Chrome and keeps local authority over the session.

- **Pause** immediately stops browser actions and detaches from the controlled page.
- remote access can be disabled without disabling local browserControl
- browser control automatically detaches after inactivity
- local interactive actions take precedence if local and remote transports are both active

## Quick start

### 1. Install the Chrome extension

Clone the repository:

```bash
git clone https://github.com/Officially-aditya/browserControl.git
cd browserControl
```

Open:

```text
chrome://extensions
```

Then:

1. enable **Developer mode**
2. click **Load unpacked**
3. select the repository's `extension/` directory
4. keep the extension enabled

The extension can now discover a local browserControl process automatically. You only need to enable remote access in the popup if you want to connect a hosted agent.

## Local agents

Local mode is the preferred path for OpenCode, Codex, Claude Code, local agent harnesses, and other stdio MCP clients running on the same computer as Chrome.

Install and build from the repository:

```bash
npm ci
npm run build
```

Start the local browserControl MCP runtime:

```bash
npm run local
```

The process exposes MCP over stdio and listens only on `127.0.0.1:8765` for the browserControl Chrome extension.

When the extension sees the local process, its popup shows **Local agents · Connected**.

For an MCP client that accepts an executable path, point it at the built runtime:

```text
node /absolute/path/to/browserControl/dist/local/runtime.js
```

The package also exposes a `browsercontrol` binary when installed as a package. This repository is not assuming an npm publication in the setup above; running from source works today.

Once connected, ask a vision-capable model something like:

```text
Use browserControl to inspect the Chrome page I have open and tell me what is on it.
```

or:

```text
Use browserControl to open the Issues tab in the GitHub repository currently open in Chrome.
```

The local data path is:

```text
agent model
    ↓
browser_observe
    ↓
local browserControl process
    ↓
Chrome extension
    ↓
screenshot from your Chrome
    ↓
agent model
    ↓
browser_click / browser_type / ...
    ↓
your Chrome changes
```

The browserControl relay is not part of this path.

## Remote agents

Hosted clients connect through the browserControl remote MCP endpoint:

```text
https://browsercontrol-relay-production.up.railway.app/mcp
```

Open the browserControl extension and enable **Remote agents**. The extension securely enrolls that Chrome profile and connects to the relay.

You do not need to copy a device token, pairing code, MCP token, or admin credential.

### OpenCode over the remote relay

OpenCode can also use the remote mode when that is useful. Add browserControl as a remote MCP server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "browserControl": {
        "type": "remote",
        "url": "https://browsercontrol-relay-production.up.railway.app/mcp",
        "codemode": false
      }
    }
  }
}
```

Authorize it:

```bash
opencode mcp auth browserControl
```

Complete the browserControl authorization page in the Chrome profile where the extension has remote access enabled.

### Claude.ai

Add the same endpoint to Claude.ai as a custom MCP connector:

```text
https://browsercontrol-relay-production.up.railway.app/mcp
```

Complete browserControl OAuth in the Chrome profile where the extension is connected.

Claude then receives the same browser tools used by local clients.

For the detailed OAuth flow, see [`docs/CLAUDE_OAUTH.md`](docs/CLAUDE_OAUTH.md).

### Other remote MCP clients

browserControl is not tied to OpenCode or Claude.

A compatible remote client should support:

- Streamable HTTP MCP
- OAuth discovery
- Dynamic Client Registration for public clients
- Authorization Code flow with PKCE `S256`
- image tool results for visual browser use

Once authorized, it receives the canonical browserControl tool surface.

## How tab control works

Connecting either transport does not immediately attach Chrome's debugger to a page.

When a browser request arrives, browserControl automatically chooses a normal web tab and attaches only when control is needed.

By default:

- **Auto-use active tab** is enabled
- **Follow active tab** is enabled
- switching to another normal web tab can move the active control session there
- Chrome internal pages are not controlled
- AI control surfaces such as Claude.ai and ChatGPT are excluded from automatic targeting
- browserControl remembers the most recent real target tab, so returning to an AI chat does not make the agent start controlling its own chat page
- an inactive control session detaches automatically after about 15 minutes

These behaviors can be tightened from the extension popup.

## Observation safety

Visual browser actions are tied to the screenshot the model actually saw.

`browser_observe` returns an `observationId`. Mutating actions such as click, type, scroll, navigation, or tab switching must include a current observation.

```text
observe page
    ↓
observationId = A
    ↓
model plans a click
    ↓
click using A
    ↓
page changes
    ↓
A becomes stale
    ↓
observe again before the next action
```

If the page changes, the user interacts with it, navigation occurs, or the visual state otherwise changes, old observations are invalidated and stale actions are rejected.

This contract is enforced by the Chrome-side browser runtime and behaves the same in local and remote modes.

## Local and remote control arbitration

Each MCP connection has an exclusive interactive lease. The Chrome extension also arbitrates between local and remote transports.

If a local agent is actively mutating Chrome, a remote mutation is rejected rather than racing the local agent against a different observation. Local interactive control takes precedence for the short active lease window.

Read-only browser observations can still report state without giving two agents permission to mutate the same page concurrently.

## Remote authentication and device isolation

Remote mode gives each enrolled Chrome profile its own device identity and credentials.

The extension uses its device credential for the outbound WebSocket connection. MCP clients authorize separately through OAuth and receive their own access and refresh tokens.

The normal user flow never exposes the extension's raw device credentials to the AI client.

browserControl remote authorization supports:

- OAuth Protected Resource Metadata
- Authorization Server Metadata
- Dynamic Client Registration
- Authorization Code flow
- PKCE `S256`
- opaque access tokens
- rotating refresh tokens
- device-bound grants
- device credential rotation and revocation

Multiple Chrome devices can use the same relay endpoint without sharing browser sessions or credentials.

Local mode does not require this OAuth/device-routing layer because both ends are already on the same machine. Its extension bridge is loopback-only and uses a short-lived, single-use extension-bound handshake before accepting the WebSocket.

## Browser-side safety boundaries

browserControl applies policy below the model so it does not depend on the agent following a prompt correctly.

Current boundaries include:

- only normal `http://` and `https://` pages are navigable through browserControl
- new tabs are limited to safe web URLs or `about:blank`
- stale screenshot actions are rejected
- text, keyboard, drag, and scroll inputs are size-bounded
- local Pause always takes precedence over AI clients
- interactive control is leased so independent agents do not simultaneously drive the same device
- local mutations take precedence over remote mutations while the local transport lease is active
- browserControl control surfaces are excluded from automatic targeting

## Data flow

### Local

```text
MCP client
   │ stdio
   ▼
browserControl local
   │ loopback WebSocket
   ▼
Chrome extension
   │ CDP
   ▼
Chrome tab
```

The hosted browserControl relay is not involved.

### Remote

```text
MCP client
   │ HTTPS + OAuth
   ▼
browserControl relay
   │ authenticated WSS
   ▼
Chrome extension
   │ CDP
   ▼
Chrome tab
```

Remote screenshots and browser RPC payloads are forwarded through the active connection. They are not used as Redis state.

Redis is used for remote control-plane data such as credential indexes, OAuth state, enrollment state, device presence, and routing metadata.

## Direct CDP compatibility

browserControl also retains the original lower-level Node/raw-CDP controller for development and compatibility.

Run connection diagnostics:

```bash
npm run doctor
```

Start the interactive direct-CDP CLI:

```bash
npm run cli
```

The older direct-CDP MCP entry points remain available:

```bash
npm run mcp
npm run mcp:http
```

These entry points connect to Chrome through a debugging endpoint and retain their legacy tool interface. New local-agent integrations should use `npm run local`, which uses the Chrome extension and the same canonical `browser_*` interface as remote mode.

The direct controller supports automatic discovery, an explicit browser debugging URL, or a direct Chrome WebSocket debugger endpoint.

## TypeScript API

The lower-level controller can also be used directly:

```typescript
import { ChromeController } from "chrome-computer-use";

const controller = new ChromeController({ mode: "auto" });
await controller.connect();

const observation = await controller.observe({ showCursor: true });

await controller.executeComputerAction({
  type: "click",
  observationId: observation.observationId,
  x: 250,
  y: 180,
  button: "left",
});

await controller.executeComputerAction({
  type: "type",
  text: "Hello from browserControl",
  method: "auto",
});

await controller.disconnect();
```

## Self-hosting remote mode

The hosted relay is one deployment of browserControl's remote transport. The relay, OAuth server, device routing, and extension connection path are all in this repository and can be self-hosted.

A public deployment needs HTTPS/WSS, persistent shared state for multi-instance routing, and appropriate secrets for administrative and internal relay operations.

For the implementation and relay architecture, see [`docs/WEB_CONTROL_PIPELINE.md`](docs/WEB_CONTROL_PIPELINE.md).

## Development

Run the main test suites with:

```bash
npm run test:unit
npm run test:web
npx vitest run tests/extension
npm run test:integration
npm test
```

CI also runs two real-Chrome transport canaries:

```text
local browser tools → localhost bridge → real extension → real Chrome
remote MCP → WSS relay → real extension → real Chrome
```

The local canary verifies real screenshots, observation-bound clicks, and stale-observation rejection without a relay. The remote canary verifies the hosted-style WSS/MCP path remains compatible.

## Design principles

browserControl is built around a few deliberate choices:

1. **The user's model is the brain.** browserControl does not add another reasoning or vision model.
2. **The user's browser is the browser.** Tasks happen in the Chrome session the user already has.
3. **Local when possible, routed when necessary.** Local agents bypass the relay; remote agents use it because they need a route to the device.
4. **MCP is the adapter boundary.** Agent harnesses do not need a browserControl-specific plugin.
5. **Transport does not change semantics.** Local and remote clients receive the same canonical `browser_*` tools.
6. **Visual actions are observation-bound.** The page must still match what the model saw.
7. **Local browser authority wins.** The user can pause control at any time, and local interactive actions take precedence over remote ones.
8. **One browser layer should work across many agents.** The same Chrome extension can serve unrelated local and remote AI clients.

## License

MIT
