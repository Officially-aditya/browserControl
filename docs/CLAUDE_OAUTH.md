# Claude.ai → browserControl OAuth

browserControl can expose its remote MCP endpoint to Claude.ai without putting a device credential in the connector URL.

The public relay acts as both:

- the MCP resource server at `/mcp`, and
- a small OAuth authorization server that supports protected-resource discovery, authorization-server metadata, Dynamic Client Registration (DCR), authorization code + PKCE (`S256`), rotating refresh tokens, and opaque device-scoped access tokens.

OAuth is additive: direct MCP clients may still use the paired device MCP token in an `Authorization: Bearer ...` header.

## Railway

Railway supplies `RAILWAY_PUBLIC_DOMAIN`. browserControl automatically uses:

```text
https://${RAILWAY_PUBLIC_DOMAIN}
```

as its OAuth issuer, so a Railway deployment needs no extra OAuth environment variable.

On other hosts set:

```text
BROWSERCONTROL_PUBLIC_BASE_URL=https://relay.example.com
```

The value must be an HTTPS origin with no path, query, or fragment.

With Redis configured, OAuth clients, authorization codes, access-token records, and refresh-token records use the same shared Redis control plane. Raw OAuth secrets are hashed before they are used as Redis keys. Browser screenshots and browser RPC payloads do not pass through Redis.

## Verify OAuth is enabled

```bash
curl https://YOUR_RELAY/health
```

A deployed public relay should include:

```json
{
  "ok": true,
  "oauthEnabled": true,
  "oauthIssuer": "https://YOUR_RELAY"
}
```

Protected resource metadata:

```text
https://YOUR_RELAY/.well-known/oauth-protected-resource/mcp
```

Authorization server metadata:

```text
https://YOUR_RELAY/.well-known/oauth-authorization-server
```

An unauthenticated request to `/mcp` returns `401` with a `WWW-Authenticate` challenge pointing to the protected-resource metadata.

## Pair Chrome first

1. Load `extension/` as an unpacked Chrome extension.
2. Pair it with the relay using the one-time pairing code.
3. Confirm the extension reports `Connected`.
4. Click **Share active tab** on the browser tab Claude should control.
5. In the connector section, **Copy MCP token** is available. Do not paste this token into Claude's connector URL.

The MCP token is used only on browserControl's own OAuth approval page to prove which paired browser the new OAuth grant should control.

## Add browserControl to Claude.ai

In Claude.ai:

1. Open **Customize → Connectors**.
2. Add a custom connector.
3. Enter the exact MCP URL:

   ```text
   https://YOUR_RELAY/mcp
   ```

4. Leave manually supplied OAuth client credentials empty. browserControl supports Dynamic Client Registration.
5. Start/connect the authorization flow.

Claude discovers browserControl's OAuth metadata and registers as a public OAuth client. Claude uses PKCE `S256` and redirects the authorization response to:

```text
https://claude.ai/api/mcp/auth_callback
```

browserControl explicitly allows that hosted Claude callback (and HTTP loopback callbacks for local MCP clients).

## Authorize the paired browser

Claude opens browserControl's authorization page.

1. Open the browserControl extension.
2. Click **Copy MCP token**.
3. Paste the token into the browserControl authorization page.
4. Check that the page says the requesting client is the Claude connector you just started.
5. Click **Authorize Claude**.

The relay validates the MCP token locally and binds the OAuth authorization code to that paired device. The underlying MCP token is never sent to Claude.

Claude exchanges the code using its PKCE verifier and receives an opaque access token plus a rotating refresh token. The access token resolves to the paired browser on every `/mcp` request.

If the paired device is revoked or its MCP connector token is rotated, existing OAuth access/refresh tokens for that credential version stop authenticating.

## End-to-end canary

With a harmless tab shared, ask Claude:

```text
Use browserControl to inspect the shared browser tab and tell me what page is open.
```

The expected path is:

```text
Claude.ai
  → OAuth access token
  → https://YOUR_RELAY/mcp
  → browser_observe
  → Railway relay
  → existing extension WebSocket
  → screenshot from the shared local Chrome tab
  → Claude
```

Then ask for a visible action, for example:

```text
Click the Issues tab in the shared browser.
```

Claude should call `browser_click` with the fresh `observationId` returned by `browser_observe`, and the real Chrome tab on the user's computer should change.

That is the full browserControl product proof: the model already running inside Claude.ai is the only reasoning model; browserControl supplies authenticated browser I/O.

## Security properties

- MCP credentials are never placed in query strings.
- OAuth authorization uses PKCE `S256`.
- Authorization codes are single-use and expire quickly.
- Refresh tokens rotate on use.
- OAuth grants are scoped to `browser:control` and the exact `/mcp` resource URL.
- Redirect URIs are restricted to Claude's hosted callback or RFC 8252-style local loopback callbacks.
- Authorization approval happens on the browserControl relay, not inside an untrusted webpage.
- Device revocation and MCP-token rotation invalidate grants tied to the previous device credential version.
- Existing observation freshness and local Pause/Disconnect controls remain unchanged.
