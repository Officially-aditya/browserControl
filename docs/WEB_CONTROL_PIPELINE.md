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
public load balancer
        |
        v
browserControl relay replica
        |
        | shared credential -> deviceId
        | shared presence -> owning replica
        v
owning DeviceRouter[deviceId]
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

Pairing provisions two independent random credentials for each device:

- `deviceToken` authenticates the extension's WSS connection.
- `mcpToken` authenticates the remote MCP connector and identifies the target device.

Only SHA-256 credential digests are retained in shared state. A client-supplied `deviceId` is never trusted for routing. After authenticating the MCP token, the relay resolves the device server-side.

Each connected device has an independent WebSocket bridge and control lease. Reconnecting one device replaces only that device's previous socket; it does not disconnect another user's browser.

## Horizontal scaling

A browserControl cluster can sit behind a normal round-robin load balancer. The load balancer does **not** need to understand devices.

All replicas share a persistent Redis deployment. Redis contains only control-plane state:

- hashed extension/MCP credential indexes and device metadata
- one-time pairing tickets
- distributed pairing/MCP rate-limit counters
- short-lived `deviceId -> replicaId + internalUrl + connectionId` presence records

Screenshots, MCP response bodies and browser RPC traffic are **not** published through Redis.

When an extension connects to a replica, that replica becomes the device's current owner and writes a TTL-backed presence record. While the WebSocket remains healthy, the owner refreshes that record. If the replica crashes, the TTL expires; the extension's existing reconnect loop lands on a healthy replica and establishes new ownership.

When Claude sends MCP to any replica:

```text
MCP token
   -> shared Redis credential index
   -> deviceId
   -> shared presence lookup
   -> owning replica
   -> local ExtensionBridge
   -> Chrome
```

If the entry replica does not own the WebSocket, it forwards the MCP HTTP request directly to the owner's private per-replica URL using `BROWSERCONTROL_RELAY_CLUSTER_TOKEN`. The screenshot/action response travels directly back over that HTTP hop; Redis never carries the payload.

Device movement is race-safe: the internal owner returns a `device moved` signal if it no longer owns the socket, and the entry replica resolves presence once more before retrying. Presence includes a unique connection ID, so a stale socket closing cannot erase a newer owner's record.

### Cluster environment

Every replica uses the same:

```text
BROWSERCONTROL_REDIS_URL=rediss://...
BROWSERCONTROL_REDIS_PREFIX=browsercontrol
BROWSERCONTROL_RELAY_CLUSTER_TOKEN=<shared-long-random-secret>
BROWSERCONTROL_ADMIN_TOKEN=<shared-admin-secret>
```

Each replica also needs:

```text
BROWSERCONTROL_RELAY_REPLICA_ID=<unique-instance-id>
BROWSERCONTROL_RELAY_INTERNAL_URL=https://<this-specific-replica-private-origin>
```

`BROWSERCONTROL_RELAY_INTERNAL_URL` must reach that exact replica and must **not** be the public round-robin load-balancer URL, otherwise peer forwarding can loop. Kubernetes pod/service routing, ECS task discovery, Fly private networking, or an equivalent private per-instance address are suitable.

Optional:

```text
BROWSERCONTROL_PRESENCE_TTL_MS=60000
```

The relay refreshes presence at roughly one third of the TTL.

For a single replica, Redis is optional. The existing file-backed hash registry remains available through `BROWSERCONTROL_DEVICE_STORE_PATH`, but file mode must not be used as shared state across replicas.

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
11. **Cluster payload isolation** - Redis contains coordination metadata only; browser screenshots/actions are forwarded directly between relay processes.
12. **Immediate revocation** - revoking a device invalidates both its extension and MCP credentials and asks the owning replica to close its active WebSocket immediately; owner refresh also detects revocation as a fallback.
13. **Separated privileges** - `BROWSERCONTROL_ADMIN_TOKEN` administers pairing/devices and `BROWSERCONTROL_RELAY_CLUSTER_TOKEN` authenticates only peer relays. Neither is given to an AI connector.
14. **Public relays reject global credentials** - `BROWSERCONTROL_DEVICE_TOKEN` and `BROWSERCONTROL_MCP_TOKEN` are loopback-development compatibility paths only.

The intentionally deferred shared-tab-scope policy is unchanged: after initial sharing, the current tab-management surface can still enumerate/switch/close tabs as previously implemented.

## Public relay setup

A public single-replica relay needs a trusted HTTPS/WSS hostname and one admin credential:

```text
BROWSERCONTROL_GATEWAY_HOST=0.0.0.0
BROWSERCONTROL_ADMIN_TOKEN=<long-random-admin-secret>
BROWSERCONTROL_TRUST_PROXY=1   # only behind a trusted reverse proxy
```

Do **not** configure `BROWSERCONTROL_DEVICE_TOKEN` or `BROWSERCONTROL_MCP_TOKEN` on a public relay. Public MCP access is device-scoped and comes from pairing.

For a single replica that needs restart persistence without Redis:

```text
BROWSERCONTROL_DEVICE_STORE_PATH=/durable/path/browsercontrol-devices.json
```

For multiple replicas, configure the Redis/cluster variables described above instead.

### Create a pairing code

```bash
curl -X POST https://YOUR_RELAY/pairing/create \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chrome laptop"}'
```

The default code is eight digits, single-use, expires after five minutes and is rate-limited. With Redis configured, creation and claim can land on different replicas.

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

Clients that can configure headers should prefer:

```text
Authorization: Bearer <DEVICE_MCP_TOKEN>
```

## Device administration

List devices and cluster ownership:

```bash
curl https://YOUR_RELAY/devices \
  -H "Authorization: Bearer $BROWSERCONTROL_ADMIN_TOKEN"
```

Online records include the current `relayReplicaId`.

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

The request can hit any replica. Shared credentials are invalidated first, then the request is forwarded to the current owner to close the WebSocket.

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
       | outbound WSS to any healthy replica
       v
public browserControl relay cluster
       ^
       | HTTPS MCP to any healthy replica
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

CI runs Redis 7 and a two-replica horizontal-scaling test. It proves:

- pairing can be created on one replica and claimed on another
- two device WebSockets can be owned by different replicas concurrently
- MCP entering a non-owning replica is forwarded to the correct extension
- cross-device payloads never cross-route
- one device's control lease remains consistent when MCP clients enter through different replicas
- reconnecting a device on another replica moves ownership safely
- revocation from one replica disconnects the device on another

The GitHub Actions gate also runs the real unpacked MV3 extension through TLS/WSS and MCP against Chrome for Testing.

## Remaining deployment/integration work

Horizontal relay routing is implemented. Platform deployment still needs the infrastructure to supply persistent Redis plus unique, peer-reachable per-replica internal URLs. MCP-standard OAuth, Chrome Web Store packaging, broader OS release testing, and live Claude/ChatGPT account canaries remain distribution/integration work rather than relay-routing work.

The existing Node/raw-CDP controller remains supported for local agents, CLI use and environments where an extension is not appropriate.
