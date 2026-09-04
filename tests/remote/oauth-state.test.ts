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

describe("OAuth grant index state", () => {
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
});
