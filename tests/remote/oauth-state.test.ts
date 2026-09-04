import { describe, expect, it } from "vitest";
import { MemoryOAuthState, RedisOAuthState, type OAuthState } from "../../src/remote/oauth-state.js";

async function exerciseGrantIndex(state: OAuthState): Promise<void> {
  const deviceId = `device-${crypto.randomUUID()}`;
  const ttlMs = 60_000;

  await Promise.all([
    state.put("grant_index", deviceId, { grantIds: ["grant_alpha"] }, ttlMs),
    state.put("grant_index", deviceId, { grantIds: ["grant_beta"] }, ttlMs),
    state.put("grant_index", deviceId, { grantIds: ["grant_gamma"] }, ttlMs),
  ]);

  const merged = await state.get<{ grantIds: string[] }>("grant_index", deviceId);
  expect(new Set(merged?.grantIds)).toEqual(new Set(["grant_alpha", "grant_beta", "grant_gamma"]));

  // Grant indexes are intentionally merge-only. Revocation deletes the authoritative
  // grant record; a stale index member cannot authenticate or appear in the grant list.
  // This avoids read/replace races between relay replicas creating grants concurrently.
  await state.put("grant_index", deviceId, { grantIds: ["grant_delta"] }, ttlMs);
  const extended = await state.get<{ grantIds: string[] }>("grant_index", deviceId);
  expect(new Set(extended?.grantIds)).toEqual(
    new Set(["grant_alpha", "grant_beta", "grant_gamma", "grant_delta"])
  );
}

async function exerciseLegacyCredentialRejection(state: OAuthState): Promise<void> {
  const ttlMs = 60_000;
  const base = {
    clientId: "legacy-client",
    deviceId: "legacy-device",
    deviceVersion: 1,
    scope: "browser:control",
    resource: "https://example.test/mcp",
    expiresAt: Date.now() + ttlMs,
  };

  await state.put("access", "legacy-access", base, ttlMs);
  expect(await state.get("access", "legacy-access")).toBeNull();

  await state.put("refresh", "legacy-refresh", base, ttlMs);
  expect(await state.take("refresh", "legacy-refresh")).toBeNull();

  await state.put("code", "legacy-code", {
    ...base,
    redirectUri: "https://example.test/callback",
    codeChallenge: "challenge",
  }, ttlMs);
  expect(await state.take("code", "legacy-code")).toBeNull();

  const bound = { ...base, grantId: "grant_bound" };
  await state.put("access", "bound-access", bound, ttlMs);
  expect(await state.get("access", "bound-access")).toMatchObject({ grantId: "grant_bound" });
}

describe("OAuth grant state", () => {
  it("merges grant IDs in memory instead of losing concurrent writers", async () => {
    const state = new MemoryOAuthState();
    try {
      await exerciseGrantIndex(state);
    } finally {
      await state.close();
    }
  });

  it("merges grant IDs atomically in Redis across concurrent writers", async () => {
    const redisUrl = process.env.BROWSERCONTROL_TEST_REDIS_URL;
    if (!redisUrl) return;
    const state = RedisOAuthState.fromUrl(redisUrl, {
      prefix: `browsercontrol-oauth-index-test-${crypto.randomUUID()}`,
    });
    try {
      await exerciseGrantIndex(state);
    } finally {
      await state.close();
    }
  });

  it("rejects pre-grant OAuth credentials in memory", async () => {
    const state = new MemoryOAuthState();
    try {
      await exerciseLegacyCredentialRejection(state);
    } finally {
      await state.close();
    }
  });

  it("rejects pre-grant OAuth credentials in Redis", async () => {
    const redisUrl = process.env.BROWSERCONTROL_TEST_REDIS_URL;
    if (!redisUrl) return;
    const state = RedisOAuthState.fromUrl(redisUrl, {
      prefix: `browsercontrol-oauth-legacy-test-${crypto.randomUUID()}`,
    });
    try {
      await exerciseLegacyCredentialRejection(state);
    } finally {
      await state.close();
    }
  });
});
