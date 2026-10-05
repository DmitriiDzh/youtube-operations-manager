import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isDomainError } from "./contracts";
import { createAgentTokenServices, type AgentTokenStore, type StoredAgentTokenRow } from "./services";

// Expected behavior from docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md §2.2-§2.3 and §4 (AC-TI-01..09),
// written before the implementation. Each "device" is its own in-memory store: token tables are device-local.

type Row = StoredAgentTokenRow & { tokenHash: string; revoked: boolean };

function createDevice(options: { connected?: Record<string, string>; live?: Record<string, string | null>; secrets?: string[] } = {}) {
  const rows: Row[] = [];
  const store: AgentTokenStore = {
    async replace(input) {
      for (const row of rows) if (row.channelId === input.channelId) row.revoked = true;
      rows.push({ ...input, createdAt: new Date("2026-10-05T00:00:00Z"), revoked: false });
    },
    async revokeForChannel(channelId) {
      let n = 0;
      for (const row of rows) if (row.channelId === channelId && !row.revoked) { row.revoked = true; n++; }
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
  const secrets = [...(options.secrets ?? [])];
  const services = createAgentTokenServices({
    store,
    getChannelConnectedUserId: async (channelId) => (options.connected ?? { UC_A: "user-a", UC_B: "user-b" })[channelId] ?? null,
    getLiveChannelIdForUser: async (userId) => (options.live ?? { "user-a": "UC_A", "user-b": "UC_B" })[userId] ?? null,
    generateSecret: () => {
      const next = secrets.shift();
      assert.ok(next, "test ran out of secrets");
      return next;
    },
  });
  return { services, rows };
}

// 43 base64url chars = what 32 random bytes encode to.
const SECRET_1 = `${"a".repeat(41)}_1`;
const SECRET_2 = `${"b".repeat(41)}-2`;
const SECRET_3 = `${"c".repeat(42)}3`;

async function assertCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("new channel tokens embed their channel id: ytom_ch_<channelId>.<secret>", async () => {
  const deviceA = createDevice({ secrets: [SECRET_1] });
  const issued = await deviceA.services.issueToken({ channelId: "UC_A" });
  assert.equal(issued.token, `ytom_ch_UC_A.${SECRET_1}`);
});

test("issue refuses a channel id the embedded format cannot carry, before any identity lookup", async () => {
  const device = createDevice({ connected: { "UC.A": "user-a" }, live: { "user-a": "UC.A" }, secrets: [SECRET_1] });
  await assertCode(device.services.issueToken({ channelId: "UC.A" }), "validation_failed");
  assert.equal(device.rows.length, 0);
});

test("AC-TI-01: a token issued on device A, imported on device B, verifies on B with the same channel binding; A is unaffected", async () => {
  const deviceA = createDevice({ secrets: [SECRET_1] });
  const deviceB = createDevice();
  const issued = await deviceA.services.issueToken({ channelId: "UC_A", label: "Codex" });

  const imported = await deviceB.services.importToken({ channelId: "UC_A", token: issued.token, label: "Codex on B" });
  assert.equal(imported.channelId, "UC_A");
  assert.equal(imported.label, "Codex on B");
  assert.equal("token" in imported, false, "import never returns the plaintext");

  const binding = await deviceB.services.verifyToken(issued.token);
  assert.equal(binding.channelId, "UC_A");
  assert.equal(binding.userId, "user-a");
  assert.equal(binding.tokenId, imported.tokenId);
  assert.equal(deviceA.rows.length, 1);
  assert.equal((await deviceA.services.verifyToken(issued.token)).channelId, "UC_A");
});

test("AC-TI-02: importing channel A's token into channel B's row fails and leaves B's active token in place", async () => {
  const deviceA = createDevice({ secrets: [SECRET_1] });
  const deviceB = createDevice({ secrets: [SECRET_2] });
  const tokenForA = (await deviceA.services.issueToken({ channelId: "UC_A" })).token;
  const tokenForB = (await deviceB.services.issueToken({ channelId: "UC_B" })).token;

  await assertCode(deviceB.services.importToken({ channelId: "UC_B", token: tokenForA }), "AGENT_TOKEN_CHANNEL_MISMATCH");
  assert.equal(deviceB.rows.length, 1);
  assert.equal((await deviceB.services.verifyToken(tokenForB)).channelId, "UC_B");
  await assertCode(deviceB.services.verifyToken(tokenForA), "AGENT_TOKEN_INVALID");
});

test("AC-TI-03: import needs the channel connected on this device and its identity owning it live -- nothing stored otherwise", async () => {
  const token = `ytom_ch_UC_A.${SECRET_1}`;
  const notConnected = createDevice({ connected: {} });
  await assertCode(notConnected.services.importToken({ channelId: "UC_A", token }), "AGENT_TOKEN_CHANNEL_NOT_CONNECTED");
  assert.equal(notConnected.rows.length, 0);

  const notOwner = createDevice({ live: { "user-a": "UC_OTHER" } });
  await assertCode(notOwner.services.importToken({ channelId: "UC_A", token }), "AGENT_TOKEN_IDENTITY_MISMATCH");
  assert.equal(notOwner.rows.length, 0);
});

test("AC-TI-04: malformed, wrong-kind and legacy tokens are rejected; nothing stored, the active token unchanged", async () => {
  const device = createDevice({ secrets: [SECRET_3] });
  const active = (await device.services.issueToken({ channelId: "UC_A" })).token;

  const cases: Array<[string, string]> = [
    [`ytom_fo_${SECRET_1}`, "AGENT_TOKEN_IMPORT_MALFORMED"],
    [`ytom_ch_${SECRET_1}`, "AGENT_TOKEN_IMPORT_LEGACY_FORMAT"],
    [`ytom_ch_UC_A.${SECRET_1.slice(1)}`, "AGENT_TOKEN_IMPORT_MALFORMED"],
    [`ytom_ch_UC_A.${SECRET_1}x`, "AGENT_TOKEN_IMPORT_MALFORMED"],
    [`ytom_ch_UC_A.${SECRET_1.slice(1)}=`, "AGENT_TOKEN_IMPORT_MALFORMED"],
    [`ytom_ch_UC A.${SECRET_1}`, "AGENT_TOKEN_IMPORT_MALFORMED"],
    [`ytom_ch_.${SECRET_1}`, "AGENT_TOKEN_IMPORT_MALFORMED"],
    ["", "AGENT_TOKEN_IMPORT_MALFORMED"],
    ["ytom_ch_", "AGENT_TOKEN_IMPORT_MALFORMED"],
    [`ytom_ch_${"U".repeat(160)}.${SECRET_1}`, "AGENT_TOKEN_IMPORT_MALFORMED"],
  ];
  for (const [token, code] of cases) {
    await assertCode(device.services.importToken({ channelId: "UC_A", token }), code);
  }
  await assertCode(device.services.importToken({ channelId: "UC_A", token: 42 }), "validation_failed");
  assert.equal(device.rows.length, 1);
  assert.equal((await device.services.verifyToken(active)).channelId, "UC_A");
});

test("AC-TI-04: surrounding whitespace from a paste is trimmed; the stored hash is of the trimmed token", async () => {
  const device = createDevice();
  const token = `ytom_ch_UC_A.${SECRET_1}`;
  await device.services.importToken({ channelId: "UC_A", token: `  ${token}\n` });
  assert.equal(device.rows[0].tokenHash, createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal((await device.services.verifyToken(token)).channelId, "UC_A");
});

test("AC-TI-05: an import revokes the channel's previously active token on this device", async () => {
  const device = createDevice({ secrets: [SECRET_2] });
  const previous = (await device.services.issueToken({ channelId: "UC_A" })).token;
  const imported = `ytom_ch_UC_A.${SECRET_1}`;

  await device.services.importToken({ channelId: "UC_A", token: imported });
  await assertCode(device.services.verifyToken(previous), "AGENT_TOKEN_INVALID");
  assert.equal((await device.services.verifyToken(imported)).channelId, "UC_A");
  assert.deepEqual((await device.services.listActiveTokens()).map((entry) => entry.channelId), ["UC_A"]);
});

test("AC-TI-06: re-importing the active token is a no-op; a token revoked on this device stays revoked", async () => {
  const device = createDevice();
  const token = `ytom_ch_UC_A.${SECRET_1}`;
  const first = await device.services.importToken({ channelId: "UC_A", token });
  const again = await device.services.importToken({ channelId: "UC_A", token });
  assert.equal(again.tokenId, first.tokenId);
  assert.equal(device.rows.length, 1);
  assert.equal(device.rows[0].revoked, false);

  await device.services.revokeToken({ channelId: "UC_A" });
  await assertCode(device.services.importToken({ channelId: "UC_A", token }), "AGENT_TOKEN_IMPORT_REVOKED");
  assert.equal(device.rows.length, 1);
  await assertCode(device.services.verifyToken(token), "AGENT_TOKEN_INVALID");
});

test("AC-TI-07: no error raised by import carries the submitted plaintext, and no row stores it", async () => {
  const token = `ytom_ch_UC_A.${SECRET_1}`;
  const attempts: Array<[ReturnType<typeof createDevice>, unknown]> = [
    [createDevice(), { channelId: "UC_B", token }],
    [createDevice({ connected: {} }), { channelId: "UC_A", token }],
    [createDevice({ live: {} }), { channelId: "UC_A", token }],
    [createDevice(), { channelId: "UC_A", token: `${token}!` }],
    [createDevice(), { channelId: "UC_A", token: `ytom_ch_${SECRET_1}` }],
  ];
  for (const [device, input] of attempts) {
    await assert.rejects(device.services.importToken(input), (error: unknown) => {
      assert.ok(isDomainError(error));
      const serialized = JSON.stringify({ message: error.message, details: error.details, code: error.code });
      assert.equal(serialized.includes(SECRET_1), false, `plaintext leaked in ${error.code}`);
      return true;
    });
  }
  const device = createDevice();
  await device.services.importToken({ channelId: "UC_A", token });
  assert.equal(JSON.stringify(device.rows).includes(SECRET_1), false);
});

test("AC-TI-08: revoking on device B leaves the same token valid on device A", async () => {
  const deviceA = createDevice({ secrets: [SECRET_1] });
  const deviceB = createDevice();
  const token = (await deviceA.services.issueToken({ channelId: "UC_A" })).token;
  await deviceB.services.importToken({ channelId: "UC_A", token });

  await deviceB.services.revokeToken({ channelId: "UC_A" });
  await assertCode(deviceB.services.verifyToken(token), "AGENT_TOKEN_INVALID");
  assert.equal((await deviceA.services.verifyToken(token)).channelId, "UC_A");
});

test("AC-TI-09: a token naming a channel verifies only against that channel's row; legacy tokens still verify", async () => {
  const device = createDevice();
  const namesA = `ytom_ch_UC_A.${SECRET_1}`;
  // A row for channel B holding the hash of a token that names channel A (only reachable by tampering).
  device.rows.push({
    id: "tampered", channelId: "UC_B", userId: "user-b", label: null, createdAt: new Date(), revoked: false,
    tokenHash: createHash("sha256").update(namesA, "utf8").digest("hex"),
  });
  await assertCode(device.services.verifyToken(namesA), "AGENT_TOKEN_INVALID");

  const legacy = `ytom_ch_${SECRET_2}`;
  device.rows.push({
    id: "legacy", channelId: "UC_A", userId: "user-a", label: null, createdAt: new Date(), revoked: false,
    tokenHash: createHash("sha256").update(legacy, "utf8").digest("hex"),
  });
  assert.deepEqual(await device.services.verifyToken(legacy), { tokenId: "legacy", channelId: "UC_A", userId: "user-a" });
});

test("independent review: re-importing a token recorded under a Google identity the channel no longer has is refused, not a false success", async () => {
  const connected: Record<string, string> = { UC_A: "user-a" };
  const live: Record<string, string | null> = { "user-a": "UC_A", "user-a2": "UC_A" };
  const device = createDevice({ connected, live });
  const token = `ytom_ch_UC_A.${SECRET_1}`;
  await device.services.importToken({ channelId: "UC_A", token });

  connected.UC_A = "user-a2"; // reconnected under another account that also owns the channel live
  await assertCode(device.services.importToken({ channelId: "UC_A", token }), "AGENT_TOKEN_IDENTITY_MISMATCH");
  await assertCode(device.services.verifyToken(token), "AGENT_TOKEN_INVALID");
  assert.equal(device.rows.length, 1);
});

test("independent review: losing a concurrent import race returns the winner's row instead of failing", async () => {
  const device = createDevice();
  const token = `ytom_ch_UC_A.${SECRET_1}`;
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  // Simulate the race on the real store contract: the first lookup misses, and by the time this call
  // inserts, a concurrent import has inserted the same hash (UNIQUE violation, this transaction rolls back).
  const services = createAgentTokenServices({
    store: {
      async replace() {
        device.rows.push({ id: "winner", channelId: "UC_A", userId: "user-a", label: null, createdAt: new Date(), tokenHash, revoked: false });
        throw new Error("UNIQUE constraint failed: agent_channel_tokens.token_hash");
      },
      async revokeForChannel() { return 0; },
      async findActiveByHash() { return null; },
      async findByHash(hash) {
        const row = device.rows.find((candidate) => candidate.tokenHash === hash);
        return row ? { ...row, revokedAt: null } : null;
      },
      async listActive() { return []; },
    },
    getChannelConnectedUserId: async () => "user-a",
    getLiveChannelIdForUser: async () => "UC_A",
  });
  const result = await services.importToken({ channelId: "UC_A", token });
  assert.equal(result.tokenId, "winner");
});

test("independent review: a label that looks like a token is refused (labels are stored in plaintext)", async () => {
  const device = createDevice({ secrets: [SECRET_2] });
  const token = `ytom_ch_UC_A.${SECRET_1}`;
  await assertCode(device.services.importToken({ channelId: "UC_A", token, label: token }), "validation_failed");
  await assertCode(device.services.issueToken({ channelId: "UC_A", label: ` ${token}` }), "validation_failed");
  assert.equal(device.rows.length, 0);
});
