import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  findActiveProducerAgentTokenByHash,
  initializeDatabaseSchema,
  listActiveProducerAgentTokens,
  replaceProducerAgentToken,
  revokeProducerAgentTokens,
  type AppDb,
} from "@/lib/db";
import { createFactoryTokenServices } from "@/lib/factory-agent-tokens/services";
import type { RoleTokenStore } from "@/lib/role-agent-tokens";
import { isDomainError } from "./contracts";
import { createProducerTokenServices } from "./services";

// Expected behavior from docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3 (AC-PR-01, AC-PR-02 token part), written before this
// module: a `ytom_pr_` token, hash only, one active, issued / rotated / revoked / imported like the Factory Operator's, and
// refused by the other roles' verifiers (and the reverse).

function createMemoryStore() {
  const rows: Array<{ id: string; tokenHash: string; label: string | null; createdAt: Date; revoked: boolean }> = [];
  const store: RoleTokenStore = {
    async replace(input) {
      for (const row of rows) row.revoked = true;
      rows.push({ ...input, createdAt: new Date("2026-10-09T00:00:00Z"), revoked: false });
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
      return row ? { ...row, revokedAt: row.revoked ? new Date("2026-10-09T12:00:00Z") : null } : null;
    },
    async listActive() {
      return rows.filter((row) => !row.revoked);
    },
  };
  return { store, rows };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const isCode = (code: string) => (error: unknown) => isDomainError(error) && error.code === code;

test("AC-PR-01: issue returns ytom_pr_<secret> once and stores only its SHA-256; it binds no channel", async () => {
  const memory = createMemoryStore();
  const services = createProducerTokenServices({ store: memory.store, generateSecret: () => "s".repeat(43) });
  const issued = await services.issueToken({ label: "Producer" });
  assert.equal(issued.token, `ytom_pr_${"s".repeat(43)}`);
  assert.equal(memory.rows[0].tokenHash, sha256(issued.token));
  assert.equal(JSON.stringify(memory.rows).includes(issued.token), false);
  assert.deepEqual(await services.verifyToken(issued.token), { tokenId: issued.tokenId });
  await assert.rejects(services.issueToken({ channelId: "UC_A" }), isCode("validation_failed"));
});

test("AC-PR-01: rotating revokes the previous token, revoke is idempotent, and a revoked token cannot be imported back", async () => {
  const memory = createMemoryStore();
  let n = 0;
  const services = createProducerTokenServices({ store: memory.store, generateSecret: () => String(++n).padStart(43, "a") });
  const first = await services.issueToken({});
  const second = await services.issueToken({});
  await assert.rejects(services.verifyToken(first.token), isCode("AGENT_TOKEN_INVALID"));
  assert.equal((await services.getActiveToken())?.tokenId, second.tokenId);
  assert.deepEqual(await services.revokeToken(), { revoked: 1 });
  assert.deepEqual(await services.revokeToken(), { revoked: 0 });
  await assert.rejects(services.verifyToken(second.token), isCode("AGENT_TOKEN_INVALID"));
  await assert.rejects(services.importToken({ token: second.token }), isCode("AGENT_TOKEN_IMPORT_REVOKED"));
});

test("AC-PR-01: a producer token issued elsewhere can be imported here; a factory or channel token cannot", async () => {
  const memory = createMemoryStore();
  const services = createProducerTokenServices({ store: memory.store });
  const token = `ytom_pr_${"B".repeat(43)}`;
  const imported = await services.importToken({ token });
  assert.deepEqual(await services.verifyToken(token), { tokenId: imported.tokenId });
  for (const other of [`ytom_fo_${"B".repeat(43)}`, `ytom_ch_UC_A.${"B".repeat(43)}`, "ytom_pr_short"]) {
    await assert.rejects(services.importToken({ token: other }), isCode("AGENT_TOKEN_IMPORT_MALFORMED"));
  }
});

test("AC-PR-02: the producer verifier refuses a factory token and the factory verifier refuses a producer token", async () => {
  const secret = "C".repeat(43);
  const producerMemory = createMemoryStore();
  const factoryMemory = createMemoryStore();
  const producer = createProducerTokenServices({ store: producerMemory.store, generateSecret: () => secret });
  const factory = createFactoryTokenServices({ store: factoryMemory.store, generateSecret: () => secret });
  const producerToken = (await producer.issueToken({})).token;
  const factoryToken = (await factory.issueToken({})).token;
  await assert.rejects(producer.verifyToken(factoryToken), isCode("AGENT_TOKEN_INVALID"));
  await assert.rejects(factory.verifyToken(producerToken), isCode("AGENT_TOKEN_INVALID"));
});

test("AC-PR-01 (real database, schema v72): at most one active producer token, enforced by the table", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "producer-token-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    await replaceProducerAgentToken({ id: "p1", tokenHash: "h1", label: null }, database);
    await replaceProducerAgentToken({ id: "p2", tokenHash: "h2", label: "two" }, database);
    assert.deepEqual((await listActiveProducerAgentTokens(database)).map((row) => row.id), ["p2"]);
    assert.equal(await findActiveProducerAgentTokenByHash("h1", database), null);
    // A second active row is refused by the partial unique index, not only by the transaction above.
    await assert.rejects(client.execute("INSERT INTO producer_agent_tokens (id, token_hash, created_at) VALUES ('p3', 'h3', unixepoch())"));
    assert.equal(await revokeProducerAgentTokens(database), 1);
    assert.deepEqual(await listActiveProducerAgentTokens(database), []);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
