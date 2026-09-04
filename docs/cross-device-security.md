# Cross-device remote authorization

browserControl can let an MCP client on one device control Chrome on another device. For example, Cuppet on Android can connect to browserControl running in Chrome on a Mac.

This is a high-authority capability. Cross-device authorization is therefore device-bound and requires an explicit approval on the Chrome device being granted.

## Trust model

```text
Remote app / MCP client
        │ OAuth + PKCE
        ▼
browserControl relay
        │ authenticated routing
        ▼
Chrome extension
        │ chrome.debugger
        ▼
existing Chrome
```

The roles are intentionally separate:

- the remote app can request browser actions only after OAuth authorization;
- the relay authenticates, authorizes, and routes requests to one device;
- the Chrome extension is the only component that executes browser actions;
- the extension's device credential never needs to be copied to the remote app.

Knowing the relay URL, client ID, device ID, source code, or MCP tool names is not sufficient to control a browser.

## First cross-device connection

Native/mobile clients use a short-lived human approval flow.

```text
1. Native app begins OAuth Authorization Code + PKCE S256.
2. browserControl creates a pending approval request.
3. The authorization page shows an 8-character approval code.
4. The user opens browserControl on the target Chrome computer.
5. The extension submits the code while authenticated with that Chrome device token.
6. The extension shows the claimed client name, callback scheme, scope, and expiry.
7. The user explicitly chooses Allow or Deny.
8. The first decision consumes the approval code.
9. Approval binds the OAuth request to that exact browser device and device-credential version.
10. The native browser is redirected to its registered callback with a short-lived authorization code.
11. Only the app holding the original PKCE verifier can exchange that code for tokens.
```

The approval code expires after roughly two minutes. It is generated from an alphabet that avoids visually ambiguous characters and carries about 40 bits of entropy. Lookup and decision attempts are rate-limited per enrolled device.

The code is a temporary pairing secret. Do not share it, and only enter a code that was produced by a connection flow you deliberately started.

## Device-bound grants

Every newly issued OAuth authorization creates a grant bound to:

- OAuth client ID;
- browserControl device ID;
- browser device credential version;
- `browser:control` scope;
- the browserControl MCP resource.

Access and refresh tokens carry the grant ID. A token is accepted only while both the device and grant are still valid.

Rotating or revoking the browser device invalidates grants through the device-version check. Revoking one app grant invalidates only that app's authorization and does not rotate the whole browser device identity.

Pre-grant OAuth credentials issued by older browserControl versions are intentionally rejected after this security model is deployed. Existing clients must complete a fresh OAuth authorization so every usable remote token is visible and individually revocable.

## Per-app revocation

The Chrome extension lists active remote app grants for that browser device.

A user can revoke one client without affecting other clients. Once a grant is deleted:

- access tokens referencing it are rejected on their next request;
- refresh tokens referencing it cannot mint new access tokens;
- another browser device cannot revoke it because the grant is bound to the original device ID.

The grant index is merge-only and backed by a Redis set in hosted deployments. The grant record itself is authoritative. This prevents concurrent relay replicas from losing a newly created grant through read/replace races. Stale index members have no authority and are ignored when the grant record no longer exists.

## Credentials and where they live

### Device token

Stored in the browserControl Chrome extension. It authenticates the browser device to relay/device-management endpoints and the extension WebSocket.

It is not sent to native/mobile MCP clients.

### Device MCP credential

Stored in the extension for same-browser OAuth compatibility and development flows. Native cross-device authorization does not accept this credential as a shortcut.

### OAuth authorization code

Short-lived and single-use. It is bound to the original client, exact redirect URI, browser device, resource, and PKCE challenge.

### OAuth access token

Short-lived (currently about one hour). It is bound to one client grant and one browser device.

### OAuth refresh token

Longer lived and rotating. Refresh tokens are one-time use and stop working immediately after the bound grant is revoked.

## Native callback security

browserControl accepts reverse-domain private-use URI schemes for native clients, such as:

```text
in.cuppet.app:/oauth/callback
```

Private-use schemes can be claimed by another installed application on some operating systems. PKCE prevents an application that merely intercepts the authorization code from exchanging it without the original verifier. Such interception can still cause denial of service, which is a limitation of private-use URI schemes themselves.

Where a native client supports verified/app-claimed HTTPS redirects, those can provide stronger operating-system-level callback ownership. browserControl should prefer verified native redirects as client support evolves.

DCR client names are self-declared metadata, not cryptographic identity. The Mac approval screen therefore shows both the client name and callback information. Users should approve only a connection they initiated and whose details match the requesting app.

## Multiple browser devices

The approval code intentionally does not preselect a device because browserControl has no central user account that can safely infer which Mac or Chrome profile the user means.

The device is selected by possession: the user enters the short-lived code into the extension on the exact Chrome profile they want to grant.

A different enrolled device cannot use the resulting OAuth token because tokens and grants are bound to the approving device. A different device also cannot revoke that grant through the device-management API.

If two devices know the same unconsumed approval code, the first valid explicit decision wins and consumes it. The code therefore must be treated as a short-lived pairing secret.

## Local authority

Remote authorization never removes local control from the user.

The Chrome extension remains the execution boundary and can:

- Pause browserControl immediately;
- disable the remote relay connection;
- reject stale observations;
- enforce URL/tab restrictions;
- enforce local-vs-remote control leases;
- revoke individual remote app grants.

Disabling remote connectivity is different from revoking a grant: disabling is a temporary connectivity switch; revocation removes that client's authorization.

## Relay data boundary

The relay necessarily sees remote MCP/browser RPC payloads in the current architecture because TLS terminates at the relay. Browser screenshots and input are not intended to be persisted in Redis; Redis stores authorization/routing state rather than browser payload history.

Application-layer end-to-end encryption between an MCP client and extension is not currently implemented. It is a potential future hardening layer if browserControl is distributed broadly.

## Security invariants

The implementation and tests are intended to preserve these invariants:

1. A native app never needs the Chrome device credential.
2. A native authorization cannot complete without an explicit decision from an enrolled browser device.
3. PKCE S256 is mandatory.
4. The redirect URI must exactly match the registered native URI, except for the existing RFC 8252 loopback-port rule.
5. Approval codes are short-lived and single-use.
6. Grants are scoped to one OAuth client and one browser device/version.
7. Per-client revocation invalidates access and refresh paths.
8. A second browser device cannot revoke another device's grant.
9. Grant indexes cannot lose concurrent authorizations when relay replicas race.
10. The Chrome extension remains the final authority over browser execution.
