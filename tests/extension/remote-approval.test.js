import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideRemoteApproval,
  listRemoteGrants,
  lookupRemoteApproval,
  revokeRemoteGrant,
} from "../../extension/remote-approval.js";

const DEVICE_TOKEN = "device-secret-that-must-stay-in-the-extension";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

describe("extension remote approval client", () => {
  beforeEach(() => {
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            gatewayUrl: "wss://browsercontrol-relay-production.up.railway.app/extension",
            developerGatewayUrl: "",
            deviceId: "device-mac",
            deviceToken: DEVICE_TOKEN,
            // Deliberately present in storage. remote-approval must never request or transmit it.
            mcpToken: "mcp-secret-that-must-not-leave-this-profile",
          }),
        },
      },
    };
    globalThis.fetch = vi.fn();
  });

  it("looks up an approval with the device token and never reads the MCP credential", async () => {
    fetch.mockResolvedValueOnce(response(200, {
      requestId: "request_abcdefghijklmnopqrstuvwxyz",
      clientName: "Cuppet Android",
      callback: "in.cuppet.app:",
      scope: "browser:control",
      expiresAt: Date.now() + 60_000,
    }));

    const result = await lookupRemoteApproval("abcd-2345");
    expect(result.code).toBe("ABCD2345");
    expect(chrome.storage.local.get).toHaveBeenCalledWith({
      gatewayUrl: "wss://browsercontrol-relay-production.up.railway.app/extension",
      developerGatewayUrl: "",
      deviceId: "",
      deviceToken: "",
    });

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain("/device-approvals/lookup");
    expect(init.headers.Authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(init.body).toBe(JSON.stringify({ code: "ABCD2345" }));
    expect(JSON.stringify(init)).not.toContain("mcp-secret-that-must-not-leave-this-profile");
  });

  it("uses the same device-bound authorization for decision, listing, and revocation", async () => {
    fetch
      .mockResolvedValueOnce(response(200, { success: true }))
      .mockResolvedValueOnce(response(200, { grants: [{ grantId: "grant_abc", clientName: "Cuppet Android" }] }))
      .mockResolvedValueOnce(response(200, { success: true }));

    await decideRemoteApproval({
      code: "ABCD2345",
      requestId: "request_abcdefghijklmnopqrstuvwxyz",
      decision: "approve",
    });
    const grants = await listRemoteGrants();
    await revokeRemoteGrant("grant_abc");

    expect(grants).toEqual([{ grantId: "grant_abc", clientName: "Cuppet Android" }]);
    for (const [, init] of fetch.mock.calls) {
      expect(init.headers.Authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
      expect(JSON.stringify(init)).not.toContain("mcp-secret-that-must-not-leave-this-profile");
    }
  });

  it("refuses approval work when remote access has not enrolled this Chrome", async () => {
    chrome.storage.local.get.mockResolvedValueOnce({
      gatewayUrl: "wss://browsercontrol-relay-production.up.railway.app/extension",
      developerGatewayUrl: "",
      deviceId: "",
      deviceToken: "",
    });

    await expect(lookupRemoteApproval("ABCD2345"))
      .rejects.toThrow("Enable remote access before approving a remote app connection");
    expect(fetch).not.toHaveBeenCalled();
  });
});
