import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isDomainError } from "./contracts";
import { createAgentTokenServices, type AgentTokenStore, type StoredAgentTokenRow } from "./services";

// Expected behavior from docs/roadmap/plans/PHASE_12_PLAN.md AC-P12-11 (hash-only, shown once,
// live identity check at issue, one active token per channel) and AC-P12-02 (revoked = invalid),
// written before this module.

type Row = StoredAgentTokenRow & { tokenHash: string; revoked: boolean };

function createMemoryStore() {
  const rows: Row[] = [];
  const store: AgentTokenStore = {
    async replace(input) {
      for (const row of rows) if (row.channelId === input.channelId) row.revoked = true;
      rows.push({ ...input, createdAt: new Date("2026-09-30T00:00:00Z"), revoked: false });
    },
    async revokeForChannel(channelId) {
      let n = 0;
      for (const row of rows) if (row.channelId === channelId && !row.revoked) { row.revoked = true; n++; }
      return n;
    },
    async findActiveByHash(tokenHash) {
      return rows.find((row) => row.tokenHash === tokenHash && !row.revoked) ?? null;
    },
    async listActive() {
      return rows.filter((row) => !row.revoked);
    },
  };
  return { store, rows };
}

function createServices(overrides: { live?: Record<string, string | null>; connected?: Record<string, string> } = {}) {
  const memory = createMemoryStore();
  const connected = overrides.connected ?? { UC_A: "user-a", UC_B: "user-b" };
  const live = overrides.live ?? { "user-a": "UC_A", "user-b": "UC_B" };
  let counter = 0;
  const services = createAgentTokenServices({
    store: memory.store,
    getChannelConnectedUserId: async (channelId) => connected[channelId] ?? null,
    getLiveChannelIdForUser: async (userId) => live[userId] ?? null,
    generateSecret: () => `secret-${++counter}`,
  });
  return { services, memory };
}

async function assertCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("issueToken returns the plaintext once, stores only its SHA-256, binds channel + recorded identity", async () => {
  const { services, memory } = createServices();
  const issued = await services.issueToken({ channelId: "UC_A", label: "Codex" });

  assert.equal(issued.token, "ytom_ch_secret-1");
  assert.equal(issued.channelId, "UC_A");
  assert.equal(issued.label, "Codex");
  const expectedHash = createHash("sha256").update("ytom_ch_secret-1").digest("hex");
  assert.equal(memory.rows[0].tokenHash, expectedHash);
  assert.equal(JSON.stringify(memory.rows).includes("ytom_ch_secret-1"), false, "plaintext must never be stored");
  assert.deepEqual(await services.verifyToken(issued.token), { tokenId: issued.tokenId, channelId: "UC_A", userId: "user-a" });
  assert.equal(JSON.stringify(await services.listActiveTokens()).includes("secret"), false, "listing never exposes the token");
});

test("issueToken refuses a channel that is not connected, or whose identity no longer owns it live", async () => {
  const { services, memory } = createServices({ live: { "user-a": "UC_SOMETHING_ELSE" } });
  await assertCode(services.issueToken({ channelId: "UC_UNKNOWN" }), "AGENT_TOKEN_CHANNEL_NOT_CONNECTED");
  await assertCode(services.issueToken({ channelId: "UC_A" }), "AGENT_TOKEN_IDENTITY_MISMATCH");
  assert.equal(memory.rows.length, 0);
});

test("one agent = one channel: issuing again revokes the previous token; other channels unaffected", async () => {
  const { services } = createServices();
  const first = await services.issueToken({ channelId: "UC_A" });
  const other = await services.issueToken({ channelId: "UC_B" });
  const second = await services.issueToken({ channelId: "UC_A" });

  await assertCode(services.verifyToken(first.token), "AGENT_TOKEN_INVALID");
  assert.equal((await services.verifyToken(second.token)).channelId, "UC_A");
  assert.equal((await services.verifyToken(other.token)).channelId, "UC_B");
  assert.deepEqual((await services.listActiveTokens()).map((t) => t.channelId).sort(), ["UC_A", "UC_B"]);
});

test("AC-P12-02: a revoked token is invalid; revoke is idempotent", async () => {
  const { services } = createServices();
  const issued = await services.issueToken({ channelId: "UC_A" });
  assert.deepEqual(await services.revokeToken({ channelId: "UC_A" }), { revoked: 1 });
  assert.deepEqual(await services.revokeToken({ channelId: "UC_A" }), { revoked: 0 });
  await assertCode(services.verifyToken(issued.token), "AGENT_TOKEN_INVALID");
});

test("verifyToken: missing, malformed, oversized and unknown tokens all fail with the same code", async () => {
  const { services } = createServices();
  for (const candidate of [undefined, null, "", "not-a-token", `ytom_ch_${"x".repeat(300)}`, "ytom_ch_unknown"]) {
    await assertCode(services.verifyToken(candidate), "AGENT_TOKEN_INVALID");
  }
});

// Review round 2: a token dies with its channel connection (disconnect, or reconnect under another
// Google identity) -- without the operator having to find and revoke it separately.
test("verifyToken rejects a token whose channel is no longer connected to the token's identity", async () => {
  const connected: Record<string, string> = { UC_A: "user-a" };
  const memory = createMemoryStore();
  const services = createAgentTokenServices({
    store: memory.store,
    getChannelConnectedUserId: async (channelId) => connected[channelId] ?? null,
    getLiveChannelIdForUser: async () => "UC_A",
    generateSecret: () => "s",
  });
  const issued = await services.issueToken({ channelId: "UC_A" });
  assert.equal((await services.verifyToken(issued.token)).channelId, "UC_A");

  connected.UC_A = "user-someone-else";
  await assertCode(services.verifyToken(issued.token), "AGENT_TOKEN_INVALID");
  delete connected.UC_A;
  await assertCode(services.verifyToken(issued.token), "AGENT_TOKEN_INVALID");
});
