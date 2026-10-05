import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createAgentTokenServices } from "@/lib/agent-tokens/services";
import { isDomainError } from "./contracts";
import { createFactoryTokenServices, type FactoryTokenStore } from "./services";

// Expected behavior comes from docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md §2.1 and §4
// (AC-FO-06 token part, AC-FO-10), written before this module. It is not derived from the implementation.

function createMemoryStore() {
  const rows: Array<{ id: string; tokenHash: string; label: string | null; createdAt: Date; revoked: boolean }> = [];
  const store: FactoryTokenStore = {
    async replace(input) {
      for (const row of rows) row.revoked = true;
      rows.push({ ...input, createdAt: new Date("2026-10-05T00:00:00Z"), revoked: false });
    },
    async revoke() {
      let n = 0;
      for (const row of rows) if (!row.revoked) { row.revoked = true; n++; }
      return n;
    },
    async findActiveByHash(tokenHash) {
      return rows.find((row) => row.tokenHash === tokenHash && !row.revoked) ?? null;
    },
    async findByHash(tokenHash) {
      const row = rows.find((candidate) => candidate.tokenHash === tokenHash);
      return row ? { ...row, revokedAt: row.revoked ? new Date("2026-10-05T12:00:00Z") : null } : null;
    },
    async listActive() {
      return rows.filter((row) => !row.revoked);
    },
  };
  return { store, rows };
}

function createServices() {
  const memory = createMemoryStore();
  let counter = 0;
  const services = createFactoryTokenServices({ store: memory.store, generateSecret: () => `secret-${++counter}` });
  return { services, memory };
}

async function assertInvalid(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === "AGENT_TOKEN_INVALID");
}

test("AC-FO-10: issueToken returns the plaintext once, stores only its SHA-256, binds nothing else", async () => {
  const { services, memory } = createServices();
  const issued = await services.issueToken({ label: "Factory Operator" });

  assert.equal(issued.token, "ytom_fo_secret-1");
  assert.equal(issued.label, "Factory Operator");
  assert.equal(memory.rows[0].tokenHash, createHash("sha256").update("ytom_fo_secret-1").digest("hex"));
  assert.equal(JSON.stringify(memory.rows).includes("ytom_fo_secret-1"), false, "plaintext must never be stored");
  assert.deepEqual(await services.verifyToken(issued.token), { tokenId: issued.tokenId });
  assert.equal(JSON.stringify(await services.getActiveToken()).includes("secret"), false, "status never exposes the token");
  assert.deepEqual(Object.keys((await services.getActiveToken()) ?? {}).sort(), ["createdAt", "label", "tokenId"]);
});

test("AC-FO-10: the issue input is strict -- a channelId / userId / credential field is rejected", async () => {
  const { services, memory } = createServices();
  for (const extra of [{ channelId: "UC_A" }, { userId: "u" }, { accessToken: "t" }]) {
    await assert.rejects(services.issueToken(extra), (error: unknown) => isDomainError(error) && error.code === "validation_failed");
  }
  assert.equal(memory.rows.length, 0);
  // No body at all is fine (label optional); a blank label is stored as null.
  assert.equal((await services.issueToken(undefined)).label, null);
  assert.equal((await services.issueToken({ label: "   " })).label, null);
});

test("AC-FO-10: issuing again revokes the previous token; exactly one stays active", async () => {
  const { services } = createServices();
  const first = await services.issueToken({});
  const second = await services.issueToken({});
  await assertInvalid(services.verifyToken(first.token));
  assert.deepEqual(await services.verifyToken(second.token), { tokenId: second.tokenId });
  assert.equal((await services.getActiveToken())?.tokenId, second.tokenId);
});

test("AC-FO-06: a revoked token is invalid and revoke is idempotent; status goes back to none", async () => {
  const { services } = createServices();
  const issued = await services.issueToken({});
  assert.deepEqual(await services.revokeToken(), { revoked: 1 });
  assert.deepEqual(await services.revokeToken(), { revoked: 0 });
  await assertInvalid(services.verifyToken(issued.token));
  assert.equal(await services.getActiveToken(), null);
});

test("AC-FO-06: missing, malformed, oversized, unknown and channel-prefixed tokens all fail with the same code", async () => {
  const { services } = createServices();
  await services.issueToken({});
  const bad: Array<string | null | undefined> = [
    undefined,
    null,
    "",
    "garbage",
    "ytom_fo_",
    "ytom_fo_unknown",
    "ytom_ch_secret-1",
    `ytom_fo_${"x".repeat(300)}`,
  ];
  const messages = new Set<string>();
  for (const token of bad) {
    await assert.rejects(services.verifyToken(token), (error: unknown) => {
      if (isDomainError(error) && error.code === "AGENT_TOKEN_INVALID") {
        messages.add(error.message);
        return true;
      }
      return false;
    });
  }
  assert.equal(messages.size, 1, "one indistinguishable error");
});

test("AC-FO-06: a factory token is rejected by the channel-token verifier, and a channel token by the factory verifier", async () => {
  const { services, memory } = createServices();
  const factory = await services.issueToken({});

  // A channel-token service that has a (hash-matching) row would still reject the factory prefix.
  const channelRows = [{ id: "c1", channelId: "UC_A", userId: "u-a", label: null, createdAt: new Date(), tokenHash: "", revoked: false }];
  const channelServices = createAgentTokenServices({
    store: {
      async replace() {},
      async revokeForChannel() { return 0; },
      async findActiveByHash(hash) { return channelRows.find((row) => row.tokenHash === hash) ?? null; },
      async findByHash() { return null; },
      async listActive() { return channelRows; },
    },
    getChannelConnectedUserId: async () => "u-a",
    getLiveChannelIdForUser: async () => "UC_A",
    generateSecret: () => "chsecret",
  });
  const issuedChannel = await channelServices.issueToken({ channelId: "UC_A" });
  assert.equal(issuedChannel.token.startsWith("ytom_ch_"), true);
  channelRows[0].tokenHash = createHash("sha256").update(issuedChannel.token).digest("hex");

  await assert.rejects(channelServices.verifyToken(factory.token), (error: unknown) => isDomainError(error) && error.code === "AGENT_TOKEN_INVALID");
  await assertInvalid(services.verifyToken(issuedChannel.token));
  assert.equal(memory.rows.length, 1);
});

test("AC-FO-10: revoking the factory token does not touch the channel token store, and the reverse", async () => {
  const { services } = createServices();
  const factory = await services.issueToken({});

  let channelRevokeCalls = 0;
  const channelServices = createAgentTokenServices({
    store: {
      async replace() {},
      async revokeForChannel() { channelRevokeCalls++; return 0; },
      async findActiveByHash() { return null; },
      async findByHash() { return null; },
      async listActive() { return []; },
    },
    getChannelConnectedUserId: async () => null,
    getLiveChannelIdForUser: async () => null,
  });
  await services.revokeToken();
  assert.equal(channelRevokeCalls, 0);

  const second = await services.issueToken({});
  await channelServices.revokeToken({ channelId: "UC_A" });
  assert.equal(channelRevokeCalls, 1);
  assert.deepEqual(await services.verifyToken(second.token), { tokenId: second.tokenId });
  await assertInvalid(services.verifyToken(factory.token));
});
