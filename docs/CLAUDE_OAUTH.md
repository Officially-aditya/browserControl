# Claude.ai → browserControl

browserControl exposes a remote MCP endpoint to Claude.ai while keeping each Chrome profile isolated behind device-scoped credentials and OAuth.

The production user flow is intentionally short:

```text
Install extension
→ Connect browserControl
→ Add the browserControl connector to Claude
→ Authorize once
→ Ask Claude to use the browser
```

Users do not need to know the relay WebSocket URL, admin token, pairing code, device token, or MCP token.

## Production endpoints

The unpacked production extension uses the managed browserControl relay directly:

```text
WSS: https://browsercontrol-relay-production.up.railway.app/extension
MCP: https://browsercontrol-relay-production.up.railway.app/mcp
```

The WebSocket endpoint is stored internally as:

```text
wss://browsercontrol-relay-production.up.railway.app/extension
```

Many extensions/users connect to the same endpoint. The relay routes each connection by its independently issued `deviceId` and device credential.

A hidden loopback-only developer override remains available in extension storage for local testing. Alternate public relay URLs are not accepted by the production extension.

## One-click device enrollment

Clicking **Connect browserControl** performs enrollment automatically:

1. The extension generates a random 256-bit nonce locally.
2. It sends only the SHA-256 nonce digest to `/enroll/start`.
3. The relay creates a random high-entropy enrollment ticket valid for 60 seconds.
4. The extension immediately claims the ticket with the original nonce.
5. The ticket is atomically consumed and cannot be replayed.
6. The relay issues a device-scoped `deviceId`, WebSocket credential, and MCP credential.
7. The extension stores them in extension-local storage and opens the WSS connection.

Enrollment requests are rate-limited per client address and globally. The temporary enrollment ticket cannot authenticate `/extension` or `/mcp` and is unrelated to the long-lived device credential.

The admin bearer token remains an operator-only credential for device listing, connector rotation and revocation. It is no longer part of normal user onboarding.

## Automatic active-tab control

The extension does not attach the debugger merely because it is connected.

When an authenticated MCP client first invokes a browser action such as `browser_observe`:

1. browserControl finds the active Chrome tab in the last-focused window;
2. if it is a normal `http://` or `https://` page, the extension attaches the Chrome debugger;
3. the action proceeds against that tab;
4. the local extension badge shows that browserControl is active.

By default **Follow active tab** is enabled. While a control session is active, switching to another normal web tab moves the debugger attachment to that tab. Switching to a restricted Chrome/internal page detaches control.

After 15 minutes without remote browser activity the extension automatically detaches. **Pause** detaches immediately and blocks remote actions until resumed. **Disconnect** also closes the relay connection.

## Railway OAuth

Railway supplies `RAILWAY_PUBLIC_DOMAIN`. browserControl automatically uses:

```text
https://${RAILWAY_PUBLIC_DOMAIN}
```

as its OAuth issuer. On other hosts set:

```text
BROWSERCONTROL_PUBLIC_BASE_URL=https://relay.example.com
```

With Redis configured, enrollment tickets, OAuth clients, authorization codes, access-token records, refresh-token records, device metadata and presence records use shared state. Browser screenshots and browser RPC payloads do not pass through Redis.

## Verify the relay

```bash
curl https://browsercontrol-relay-production.up.railway.app/health
```

A production relay should include:

```json
{
  "ok": true,
  "oauthEnabled": true,
  "connectedDevices": 1,
  "extensionConnected": true
}
```

OAuth discovery endpoints are:

```text
https://browsercontrol-relay-production.up.railway.app/.well-known/oauth-protected-resource/mcp
https://browsercontrol-relay-production.up.railway.app/.well-known/oauth-authorization-server
```

An unauthenticated request to `/mcp` returns `401` with a `WWW-Authenticate` challenge pointing to the protected-resource metadata.

## Add browserControl to Claude.ai

In Claude.ai:

1. Open **Customize → Connectors**.
2. Add a custom connector.
3. Enter:

   ```text
   https://browsercontrol-relay-production.up.railway.app/mcp
   ```

4. Leave manually supplied OAuth client credentials empty.
5. Start authorization.

Claude discovers browserControl's OAuth metadata, performs Dynamic Client Registration, and uses authorization code + PKCE `S256`.

## Authorization UX

Claude opens browserControl's authorization page. When the browserControl extension is installed and connected, its content script recognizes only the managed browserControl authorization origin and obtains the local device MCP credential from the extension service worker.

The credential field is then hidden and filled only when the user clicks **Authorize**. The user still explicitly approves the OAuth grant, but no token copying or pasting is required.

The device MCP credential is verified by the browserControl relay and is not sent to Claude. Claude receives its own opaque OAuth access token and rotating refresh token.

If the device is revoked or its MCP connector credential is rotated, OAuth grants tied to the old credential version stop authenticating.

## End-to-end canary

Open a harmless normal web page and ask Claude:

```text
Use browserControl to inspect the browser and tell me what page is open.
```

Expected path:

```text
Claude.ai
  → OAuth access token
  → /mcp
  → browser_observe
  → Railway relay
  → device-routed WSS
  → browserControl extension
  → auto-attach active web tab
  → screenshot
  → Claude
```

Then ask for a visible action:

```text
Click the Issues tab in the browser.
```

Claude should call `browser_click` with the fresh `observationId` returned by `browser_observe`, and the real Chrome tab should change.

## Security properties

- one managed production relay endpoint; identity is device-scoped rather than URL-scoped;
- self-enrollment tickets are random, short-lived, single-use, proof-bound and rate-limited;
- long-lived device credentials are independent, revocable and stored only in extension-local storage;
- production extension WebSocket auth uses `Sec-WebSocket-Protocol`, not a credential in the URL;
- OAuth authorization uses PKCE `S256`;
- authorization codes are single-use and short-lived;
- refresh tokens rotate on use;
- OAuth grants are scoped to `browser:control` and the exact `/mcp` resource;
- redirect URIs are restricted to Claude's hosted callback or local loopback clients;
- automatic control attaches only normal HTTP(S) tabs;
- mutating actions remain bound to fresh observations;
- local Pause/Disconnect remain authoritative;
- idle sessions detach automatically.
