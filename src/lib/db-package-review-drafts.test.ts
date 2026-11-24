import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { createIsolatedDb, deletePackageReviewDraft, getPackageReviewDraft, initializeDatabaseSchema, SCHEMA_MIGRATIONS, setPackageReviewDraft } from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";

// Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-03): schema v124 adds `package_review_drafts` -- one row per (channel, manifest), replaced
// whole, removed on send or when emptied. Device-local: never in a snapshot.

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-package-review-drafts-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("schema v124 exists, creates package_review_drafts, and the table is device-local", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 124));
  assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES.package_review_drafts);
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'package_review_drafts'");
    assert.equal(t.rows.length, 1);
  });
});

test("AC-TC-03: one draft per (channel, manifest): a second save replaces it; another channel's draft is separate; delete removes one", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const m = "a".repeat(64);
    const t1 = new Date("2026-11-24T10:00:00Z");
    const t2 = new Date("2026-11-24T10:05:00Z");
    assert.equal(await getPackageReviewDraft("UC1", m, database), null);
    await setPackageReviewDraft("UC1", m, '[{"id":"a","atSeconds":1,"text":"x"}]', t1, database);
    await setPackageReviewDraft("UC1", m, '[{"id":"b","atSeconds":2,"text":"y"}]', t2, database);
    await setPackageReviewDraft("UC2", m, "[]", t1, database);
    assert.deepEqual(await getPackageReviewDraft("UC1", m, database), { commentsJson: '[{"id":"b","atSeconds":2,"text":"y"}]', updatedAt: t2 });
    await deletePackageReviewDraft("UC1", m, database);
    assert.equal(await getPackageReviewDraft("UC1", m, database), null);
    assert.deepEqual(await getPackageReviewDraft("UC2", m, database), { commentsJson: "[]", updatedAt: t1 });
  });
});
