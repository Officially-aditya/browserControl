# browserControl

**Universal browser I/O for AI agents.**

browserControl gives an AI agent a secure screen, mouse, and keyboard connected to your existing Chrome session.

The agent keeps using its own model for reasoning. browserControl does not add another model, browser, or automation runtime in the middle. It exposes Chrome through MCP, returns screenshots to the agent, and turns the agent's tool calls into real mouse, keyboard, navigation, and tab actions in the browser you already use.

```text
Your AI agent
     │
     │ MCP
     ▼
browserControl relay
     │
     │ authenticated outbound WebSocket
     ▼
Chrome extension
     │
     │ Chrome DevTools Protocol
     ▼
Your existing Chrome
```

That means the agent can work with the same tabs, cookies, logins, sessions, and websites you already have open instead of launching a separate automation browser.

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

A connected MCP client can:

- inspect the current browser state with `browser_status`
- capture the current page with `browser_observe`
- zoom into a region with `browser_inspect`
- move, click, double-click, drag, and scroll
- type text and send keyboard shortcuts
- navigate, go back, go forward, and reload
- list, switch, open, and close tabs
- accept or dismiss JavaScript dialogs
- release interactive control when finished

The main remote tools are:

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

Coordinates use a normalized `0-1000` space, so the agent can reason against screenshots without depending on a particular display resolution.

## Why use browserControl

### It uses your real Chrome

browserControl does not create a clean Playwright/Puppeteer browser profile for every task. The extension controls the Chrome session you are already using.

If you are signed into GitHub, Gmail, Linear, a dashboard, or any other website in Chrome, the agent sees that same authenticated browser state.

### It is model and harness independent

browserControl is an MCP server, not an AI agent framework.

The reasoning model can come from OpenAI, Anthropic, Google, NVIDIA, an open model, or another provider. The MCP client can be OpenCode, Claude.ai, a coding agent, a local harness, or another compatible MCP client.

The only important requirement for visual use is that the model/harness can consume image tool results. browserControl deliberately does not insert a second vision model.

### It is visual, not selector-driven

The remote interaction model is based on screenshots, coordinates, mouse input, and keyboard input.

The agent does not need browserControl-specific CSS selectors, DOM locators, accessibility references, or Playwright APIs in order to operate a page.

### It keeps browser authority local

The Chrome extension initiates an outbound authenticated connection to the relay. Remote AI clients do not connect directly to your localhost or Chrome debugger port.

The extension also keeps local authority over the session:

- **Pause** immediately stops remote control and detaches from the page.
- **Disconnect** closes the remote connection and detaches locally.
- control automatically detaches after inactivity.

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
4. open the browserControl extension
5. click **Connect browserControl**

The extension enrolls the Chrome profile automatically and connects to the hosted browserControl relay.

You do not need to enter a relay URL, device token, pairing code, or MCP token.

### 2. Add browserControl to your MCP client

Hosted MCP endpoint:

```text
https://browsercontrol-relay-production.up.railway.app/mcp
```

The same endpoint can be used by different compatible MCP clients. OAuth binds each authorized client to the Chrome device you approved.

## OpenCode

Add browserControl as a remote MCP server in your OpenCode configuration:

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

Complete the browserControl authorization page in the Chrome profile where the extension is connected.

Then start OpenCode with a vision-capable model and ask it to use browserControl, for example:

```text
Use browserControl to inspect the Chrome page I have open and tell me what is on it.
```

Or:

```text
Use browserControl to open the Issues tab in the GitHub repository currently open in Chrome.
```

The expected flow is:

```text
OpenCode model
    ↓
browser_observe
    ↓
screenshot from your Chrome
    ↓
model reasons about the image
    ↓
browser_click / browser_type / ...
    ↓
your Chrome changes
```

## Claude.ai

Add the same MCP endpoint to Claude.ai as a custom MCP connector:

```text
https://browsercontrol-relay-production.up.railway.app/mcp
```

Complete browserControl OAuth in the Chrome profile where the extension is connected.

Claude then receives the browser tools through MCP and can use the same Chrome extension and browser session as any other authorized client.

For the detailed OAuth flow, see [`docs/CLAUDE_OAUTH.md`](docs/CLAUDE_OAUTH.md).

## Other MCP clients

browserControl is not tied to OpenCode or Claude.

A compatible remote client should support:

- Streamable HTTP MCP
- OAuth discovery
- Dynamic Client Registration for public clients
- Authorization Code flow with PKCE `S256`
- image tool results for visual browser use

Once authorized, it receives the same browserControl tool surface.

## How tab control works

Connecting the extension does not immediately attach Chrome's debugger to a page.

When an authenticated browser request arrives, browserControl automatically chooses a normal web tab and attaches only when control is needed.

By default:

- **Auto-use active tab** is enabled.
- **Follow active tab** is enabled.
- switching to another normal web tab can move the active control session there.
- Chrome internal pages are not controlled.
- AI control surfaces such as Claude.ai and ChatGPT are excluded from automatic targeting.
- browserControl remembers the most recent real target tab, so returning to the AI chat does not make the agent start controlling its own chat page.
- an inactive control session detaches automatically after about 15 minutes.

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

This prevents an agent from blindly applying coordinates to a page that no longer matches the screenshot it reasoned from.

## Authentication and device isolation

Each connected Chrome profile receives its own device identity and credentials.

The extension uses its device credential for the outbound WebSocket connection. MCP clients authorize separately through OAuth and receive their own access and refresh tokens.

The normal user flow never exposes the extension's raw device credentials to the AI client.

browserControl supports:

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

## Browser-side safety boundaries

browserControl applies policy below the model so it does not depend on the agent following a prompt correctly.

Current boundaries include:

- only normal `http://` and `https://` pages are navigable through remote browser navigation
- new tabs are limited to safe web URLs or `about:blank`
- stale screenshot actions are rejected
- text, keyboard, drag, and scroll inputs are size-bounded
- local Pause and Disconnect always take precedence over remote clients
- interactive control is leased so two AI clients do not simultaneously drive the same device
- browserControl control surfaces are excluded from automatic targeting

## Data flow

For remote use:

```text
MCP client
   │
   │ HTTPS + OAuth
   ▼
browserControl relay
   │
   │ authenticated WSS
   ▼
Chrome extension
   │
   │ CDP
   ▼
Chrome tab
```

Screenshots and browser RPC payloads are forwarded through the active connection. They are not used as Redis state.

Redis is used for control-plane data such as credential indexes, OAuth state, enrollment state, device presence, and routing metadata.

## Local usage without the hosted relay

The repository also contains the original Node/raw-CDP controller for local agents and development.

Requirements:

- Node.js 20+
- Google Chrome

Install and build:

```bash
npm ci
npm run build
```

Run connection diagnostics:

```bash
npm run doctor
```

Start the interactive CLI:

```bash
npm run cli
```

Start a local MCP server:

```bash
npm run mcp
```

or the HTTP MCP server:

```bash
npm run mcp:http
```

The raw-CDP controller supports automatic discovery, an explicit browser debugging URL, or a direct Chrome WebSocket debugger endpoint.

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

## Self-hosting

The hosted relay is only one deployment of browserControl. The relay, OAuth server, device routing, and extension connection path are all in this repository and can be self-hosted.

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

## Design principles

browserControl is built around a few deliberate choices:

1. **The user's model is the brain.** browserControl does not add another reasoning or vision model.
2. **The user's browser is the browser.** Tasks happen in the Chrome session the user already has.
3. **MCP is the adapter boundary.** Agent harnesses do not need a browserControl-specific plugin.
4. **Visual actions are observation-bound.** The page must still match what the model saw.
5. **Local browser authority wins.** The user can pause or disconnect control at any time.
6. **One browser layer should work across many agents.** The same extension, relay, and MCP endpoint can serve unrelated AI clients.

## License

MIT
