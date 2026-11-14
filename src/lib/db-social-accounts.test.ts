import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { createIsolatedDb, deleteSocialAccounts, initializeDatabaseSchema, listSocialAccounts, SCHEMA_MIGRATIONS, upsertSocialAccount } from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";

// BL-252 (ADR 0068): schema v121 adds `social_accounts` -- one row per (channel, network); a second connect replaces the row.
// Device-local: the token is sealed with this computer's key, so the table never travels in a snapshot.

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-social-accounts-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const row = (over: Partial<Parameters<typeof upsertSocialAccount>[0]> = {}) => ({
  channelId: "UC1",
  network: "facebook" as const,
  externalId: "111",
  displayName: "WWE",
  username: null,
  pageId: "111",
  tokenSealed: '{"ciphertext":"x","iv":"y","authTag":"z"}',
  tokenExpiresAt: null,
  connectedAt: new Date("2026-11-14T10:00:00Z"),
  ...over,
});

test("schema v121 exists, creates social_accounts, and the table is device-local", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 121));
  assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES.social_accounts);
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'social_accounts'");
    assert.equal(t.rows.length, 1);
  });
});

test("one row per (channel, network): a second connect replaces it; delete by network or the whole channel", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    await upsertSocialAccount(row(), database);
    await upsertSocialAccount(row({ externalId: "222", displayName: "Other", pageId: "222" }), database);
    await upsertSocialAccount(row({ network: "instagram", externalId: "1784", username: "wwexplained" }), database);
    await upsertSocialAccount(row({ channelId: "UC2" }), database);
    const uc1 = await listSocialAccounts("UC1", database);
    assert.deepEqual(uc1.map((r) => [r.network, r.externalId, r.displayName]), [["facebook", "222", "Other"], ["instagram", "1784", "WWE"]]);
    assert.equal((await listSocialAccounts(null, database)).length, 3);
    assert.equal(await deleteSocialAccounts("UC1", "instagram", database), 1);
    assert.equal(await deleteSocialAccounts("UC1", null, database), 1);
    assert.deepEqual((await listSocialAccounts(null, database)).map((r) => r.channelId), ["UC2"]);
  });
});
