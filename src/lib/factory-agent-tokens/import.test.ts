import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAgentTokenServices } from "@/lib/agent-tokens/services";
import { isDomainError } from "./contracts";
import { createFactoryTokenServices, type FactoryTokenStore } from "./services";

// Expected behavior from docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md §2.3 and §4 (AC-TI-04..08, AC-TI-11),
// written before the implementation. Each "device" is its own in-memory store: token tables are device-local.

function createDevice(secrets: string[] = []) {
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
  const queue = [...secrets];
  const services = createFactoryTokenServices({
    store,
    generateSecret: () => {
      const next = queue.shift();
      assert.ok(next, "test ran out of secrets");
      return next;
    },
  });
  return { services, rows };
}

const SECRET_1 = `${"f".repeat(41)}_1`;
const SECRET_2 = `${"g".repeat(41)}-2`;

async function assertCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("AC-TI-01 (factory): a token issued on device A, imported on device B, verifies on B; A is unaffected", async () => {
  const deviceA = createDevice([SECRET_1]);
  const deviceB = createDevice();
  const issued = await deviceA.services.issueToken({ label: "FO" });
  assert.equal(issued.token, `ytom_fo_${SECRET_1}`);

  const imported = await deviceB.services.importToken({ token: issued.token, label: "FO on B" });
  assert.equal(imported.label, "FO on B");
  assert.equal("token" in imported, false);
  assert.deepEqual(await deviceB.services.verifyToken(issued.token), { tokenId: imported.tokenId });
  assert.equal(deviceA.rows.length, 1);
  assert.deepEqual(await deviceA.services.verifyToken(issued.token), { tokenId: issued.tokenId });
});

test("AC-TI-04 (factory): malformed and channel tokens are rejected; nothing stored, the active token unchanged", async () => {
  const device = createDevice([SECRET_2]);
  const active = (await device.services.issueToken({})).token;
  for (const token of [
    `ytom_ch_${SECRET_1}`,
    `ytom_ch_UC_A.${SECRET_1}`,
    `ytom_fo_${SECRET_1.slice(1)}`,
    `ytom_fo_${SECRET_1}x`,
    `ytom_fo_${SECRET_1.slice(1)}.`,
    "",
    "ytom_fo_",
    `ytom_fo_${"a".repeat(300)}`,
  ]) {
    await assertCode(device.services.importToken({ token }), "AGENT_TOKEN_IMPORT_MALFORMED");
  }
  await assertCode(device.services.importToken({ token: `ytom_fo_${SECRET_1}`, channelId: "UC_A" }), "validation_failed");
  assert.equal(device.rows.length, 1);
  assert.deepEqual(await device.services.verifyToken(active), { tokenId: device.rows[0].id });
});

test("AC-TI-04 (factory): whitespace around a pasted token is trimmed before hashing", async () => {
  const device = createDevice();
  const token = `ytom_fo_${SECRET_1}`;
  await device.services.importToken({ token: `\t${token}  ` });
  assert.equal(device.rows[0].tokenHash, createHash("sha256").update(token, "utf8").digest("hex"));
});

test("AC-TI-05 (factory): an import revokes the previously active factory token on this device", async () => {
  const device = createDevice([SECRET_2]);
  const previous = (await device.services.issueToken({})).token;
  const imported = `ytom_fo_${SECRET_1}`;
  await device.services.importToken({ token: imported });
  await assertCode(device.services.verifyToken(previous), "AGENT_TOKEN_INVALID");
  assert.equal((await device.services.getActiveToken())?.tokenId, device.rows[1].id);
});

test("AC-TI-06 (factory): re-importing the active token is a no-op; a token revoked here stays revoked", async () => {
  const device = createDevice();
  const token = `ytom_fo_${SECRET_1}`;
  const first = await device.services.importToken({ token });
  assert.equal((await device.services.importToken({ token })).tokenId, first.tokenId);
  assert.equal(device.rows.length, 1);

  await device.services.revokeToken();
  await assertCode(device.services.importToken({ token }), "AGENT_TOKEN_IMPORT_REVOKED");
  await assertCode(device.services.verifyToken(token), "AGENT_TOKEN_INVALID");
});

test("AC-TI-07 (factory): errors never carry the submitted plaintext; rows never store it", async () => {
  const device = createDevice();
  const token = `ytom_fo_${SECRET_1}`;
  await device.services.importToken({ token });
  await device.services.revokeToken();
  for (const input of [{ token: `${token}!` }, { token }]) {
    await assert.rejects(device.services.importToken(input), (error: unknown) => {
      assert.ok(isDomainError(error));
      assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(SECRET_1), false);
      return true;
    });
  }
  assert.equal(JSON.stringify(device.rows).includes(SECRET_1), false);
});

test("AC-TI-08 (factory): revoking on device B leaves the same token valid on device A", async () => {
  const deviceA = createDevice([SECRET_1]);
  const deviceB = createDevice();
  const token = (await deviceA.services.issueToken({})).token;
  await deviceB.services.importToken({ token });
  await deviceB.services.revokeToken();
  await assertCode(deviceB.services.verifyToken(token), "AGENT_TOKEN_INVALID");
  assert.deepEqual(await deviceA.services.verifyToken(token), { tokenId: deviceA.rows[0].id });
});

test("AC-TI-11: an imported factory token is still rejected by the channel-token verifier", async () => {
  const device = createDevice();
  const token = `ytom_fo_${SECRET_1}`;
  await device.services.importToken({ token });
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const channelServices = createAgentTokenServices({
    store: {
      async replace() {},
      async revokeForChannel() { return 0; },
      // Even a channel store that (impossibly) held this hash must not accept the factory prefix.
      async findActiveByHash(candidate) {
        return candidate === hash ? { id: "x", channelId: "UC_A", userId: "u", label: null, createdAt: new Date() } : null;
      },
      async findByHash() { return null; },
      async listActive() { return []; },
    },
    getChannelConnectedUserId: async () => "u",
    getLiveChannelIdForUser: async () => "UC_A",
  });
  await assertCode(channelServices.verifyToken(token), "AGENT_TOKEN_INVALID");
  await assertCode(channelServices.importToken({ channelId: "UC_A", token }), "AGENT_TOKEN_IMPORT_MALFORMED");
});
