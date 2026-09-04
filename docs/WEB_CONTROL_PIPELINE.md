# browserControl Web Control Pipeline

browserControl lets a remote MCP client such as Claude.ai control a real Chrome tab while the web AI remains the only reasoning model.

## Production architecture

Claude does **not** connect to the user's localhost. The browser extension maintains an outbound authenticated WebSocket to the public relay, while Claude reaches the same relay through HTTPS MCP + OAuth.

```text
Claude / remote AI cloud
        |
        | HTTPS Streamable HTTP MCP + OAuth
        v
public load balancer
        |
        v
browserControl relay replica
        |
        | authenticated principal -> deviceId
        | shared presence -> owning replica
        v
owning DeviceRouter[deviceId]
        |
        | outbound authenticated WSS
        v
browserControl Chrome extension
        |
        | chrome.debugger / CDP
        v
User's active Chrome tab
```

The Chrome debugging port is never exposed to the internet. NAT, residential IP changes and local firewalls do not require inbound access because the extension initiates the relay connection.

## Production user flow

```text
Install/load extension
        ↓
Connect browserControl
        ↓
Add https://browsercontrol-relay-production.up.railway.app/mcp to Claude once
        ↓
Authorize once
        ↓
Ask Claude to use the browser
```

The normal user never handles:

- relay WebSocket URLs
- admin tokens
- pairing codes
- device tokens
- MCP bearer tokens

The extension contains the managed production relay internally. A hidden loopback-only gateway override remains available for development.

## Device self-enrollment

Clicking **Connect browserControl** performs a proof-bound, short-lived enrollment flow:

```text
extension generates 256-bit nonce
        ↓
POST /enroll/start with SHA-256(nonce)
        ↓
random 60-second enrollment ticket
        ↓
POST /enroll/claim with ticket + nonce
        ↓
atomic single-use claim
        ↓
deviceId + deviceToken + mcpToken
        ↓
WSS connection authenticated with deviceToken
```

The enrollment ticket cannot authenticate `/extension` or `/mcp`. It is consumed on the first claim attempt and expires after 60 seconds. Enrollment is rate-limited per client address and globally.

The older admin-created pairing endpoints remain available for operator/testing compatibility, but they are not part of production onboarding.

## Multi-device routing model

Every enrolled Chrome profile receives independent random credentials:

- `deviceToken` authenticates the extension's WSS connection.
- `mcpToken` anchors device-scoped connector/OAuth authorization.

Only SHA-256 credential digests are retained in shared relay state. A client-supplied `deviceId` is never trusted for routing.

Each connected device has an independent WebSocket bridge and control lease. Reconnecting one device replaces only that device's previous socket; it does not disconnect another user's browser. This is why many users can share the same public endpoint:

```text
wss://browsercontrol-relay-production.up.railway.app/extension
```

## Claude OAuth

Unauthenticated MCP requests receive an OAuth `WWW-Authenticate` challenge. browserControl exposes protected-resource metadata, authorization-server discovery, Dynamic Client Registration, authorization code + PKCE `S256`, opaque access tokens, and rotating refresh tokens.

During authorization, the browserControl extension recognizes browserControl's managed authorization page and supplies its local device MCP credential internally. The user still clicks **Authorize**, but does not copy or expose that secret to Claude.

Claude receives its own device-scoped OAuth access token. If the underlying device is revoked or the MCP connector credential is rotated, grants tied to the previous credential version stop authenticating.

## Automatic active-tab sessions

A connected extension does not attach Chrome's debugger immediately.

On the first authenticated browser action:

1. browserControl finds the active tab in the last-focused Chrome window;
2. only a normal `http://` or `https://` page is eligible;
3. the extension attaches via `chrome.debugger`;
4. the requested observation/action proceeds;
5. the local badge shows that browserControl is active.

By default, **Follow active tab** is enabled while a control session is active. When the user selects another normal web tab, browserControl moves the debugger attachment to that tab. Selecting a restricted Chrome/internal tab detaches control.

After 15 minutes without remote browser activity, the session detaches automatically. **Pause** detaches immediately and blocks remote actions until the user resumes. **Disconnect** closes the relay connection and detaches locally.

Users can disable **Auto-use active tab** or **Follow active tab** in the extension popup if they want a stricter local boundary.

## Horizontal scaling

A browserControl cluster can sit behind a normal round-robin load balancer. The load balancer does not need to understand devices.

All replicas share persistent Redis control-plane state:

- hashed extension/MCP credential indexes and device metadata
- short-lived enrollment/pairing records
- OAuth clients, codes, access-token and refresh-token records
- distributed rate-limit counters
- short-lived `deviceId -> replicaId + internalUrl + connectionId` presence records

Screenshots, MCP response bodies and browser RPC traffic are **not** published through Redis.

When an extension connects to a replica, that replica becomes the device's current owner and writes a TTL-backed presence record. While the WebSocket remains healthy, the owner refreshes that record. If the replica dies, ownership expires and the extension reconnects to another healthy replica.

An MCP request may hit any replica:

```text
OAuth/direct device principal
   -> deviceId
   -> shared presence lookup
   -> owning replica
   -> local ExtensionBridge
   -> Chrome
```

If the entry replica does not own the WebSocket, it forwards the MCP request directly to the owner's private per-replica URL using `BROWSERCONTROL_RELAY_CLUSTER_TOKEN`. Redis never carries the browser payload.

## Railway deployment

Current production configuration uses one Railway relay service plus Railway Redis:

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

Railway supplies `RAILWAY_PUBLIC_DOMAIN`, which browserControl uses as the OAuth issuer. Other hosts can set `BROWSERCONTROL_PUBLIC_BASE_URL` explicitly.

Do **not** configure `BROWSERCONTROL_DEVICE_TOKEN` or `BROWSERCONTROL_MCP_TOKEN` on a public relay. They are loopback-development compatibility options.

## Model-facing tools

### Observation

- `browser_status`
- `browser_observe`
- `browser_inspect`
- `browser_tabs`

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

1. **No eager debugger attachment** — connecting the extension alone does not expose a tab; the first browser action starts the local control session.
2. **Normal web tabs only** — automatic attachment is limited to HTTP(S) pages.
3. **Local Pause wins** — a remote AI cannot resume a user-paused session.
4. **Local Disconnect wins** — disconnect closes WSS and detaches the debugger.
5. **Idle detach** — inactive control sessions end automatically.
6. **Observation binding** — every mutation requires the exact `observationId` it was planned from.
7. **External-change invalidation** — DOM changes, user input, navigation and execution-context changes invalidate old observations.
8. **Stale action rejection** — stale mutations fail with `STALE_OBSERVATION`.
9. **Per-device control lease** — concurrent MCP clients contend only for the same browser device.
10. **Credential-scoped routing** — the authenticated principal selects its device server-side.
11. **Outbound-only browser connection** — CDP is never internet-facing.
12. **No screenshot persistence in relay/Redis** — screenshots are forwarded in memory.
13. **Immediate revocation** — revocation invalidates credentials and closes the active device socket.
14. **Separated privileges** — admin and cluster credentials remain operator/infrastructure secrets.
15. **Public relay credentials are device-scoped** — global development credentials are not accepted in public mode.

## Device administration

The admin token is operator-only:

```bash
curl https://YOUR_RELAY/devices \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

curl -X POST https://YOUR_RELAY/devices/DEVICE_ID/connector/rotate \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"

curl -X DELETE https://YOUR_RELAY/devices/DEVICE_ID \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

## Local development

The production popup intentionally hides gateway configuration. For local development, a loopback-only override can be stored in extension local storage, for example:

```text
developerGatewayUrl=ws://127.0.0.1:8787/extension
```

Production builds refuse non-loopback developer overrides.

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
