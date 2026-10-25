import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema, insertPublishingUploads, listTriedManifestHashes, SCHEMA_MIGRATIONS, type AppDb, type StoredPublishingUpload } from "@/lib/db";

// BL-209 (AUTO_PRIVATE_UPLOAD_PLAN.md §2 item 6, ADR 0046; ADR 0001: additive only) on a real migrated temporary database: schema
// v103 adds `publishing_uploads.automatic` (NOT NULL DEFAULT 0, so every older row reads as an approval), converges when run again,
// and the manifest hashes already tried are listed per channel whatever became of their rows -- automatic or the owner's own
// (review M1: an upload the owner cancelled, or one that failed, never comes back by itself).

async function withDb(run: (database: AppDb, client: ReturnType<typeof createLibsqlClient>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-auto-upload-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const T = new Date("2026-10-21T12:00:00.000Z");
const row = (over: Partial<StoredPublishingUpload>): StoredPublishingUpload => ({
  id: "u1",
  channelId: "UC1",
  video: "V65",
  manifestPath: "04 Videos/10 October/1024 V65/V65_release.json",
  manifestSha256: "mf-1",
  packageJson: "{}",
  settingsJson: "{}",
  publishAt: null,
  approvedBy: "u-owner",
  approvedAt: T,
  status: "queued",
  resumeStatus: null,
  pausedReason: null,
  pausedUntil: null,
  sessionUri: null,
  totalBytes: 1000,
  storedBytes: 0,
  videoId: null,
  publishAtAtInsert: false,
  stepsJson: "{}",
  errorCode: null,
  errorMessage: null,
  attempts: 0,
  nextAttemptAt: null,
  createdAt: T,
  updatedAt: T,
  finishedAt: null,
  leaseOwner: null,
  leaseUntil: null,
  automatic: false,
  slotId: null,
  ...over,
});

test("v103: an older row reads as not automatic; the migration runs again without change", () =>
  withDb(async (database, client) => {
    // A row written the way v89..v102 wrote it (no `automatic` column named).
    await client.execute(
      "INSERT INTO publishing_uploads (id, channel_id, video, manifest_path, manifest_sha256, package_json, settings_json, approved_by, approved_at, status, total_bytes, stored_bytes, publish_at_at_insert, steps_json, attempts, created_at, updated_at) " +
        "VALUES ('old', 'UC1', 'V60', 'p', 'mf-old', '{}', '{}', 'u', 0, 'done', 1, 1, 0, '{}', 1, 0, 0)"
    );
    await SCHEMA_MIGRATIONS.find((m) => m.version === 103)!.apply(client);
    const read = await client.execute("SELECT automatic FROM publishing_uploads WHERE id = 'old'");
    assert.equal(Number(read.rows[0].automatic), 0);
    // Review M1 changed the rule: an approval's row (here the old one) also counts as tried.
    assert.deepEqual([...(await listTriedManifestHashes("UC1", database))], ["mf-old"]);
  }));

test("BL-209 review M1: the tried manifest hashes -- every row of the channel, automatic or manual, any status", () =>
  withDb(async (database) => {
    assert.equal(await insertPublishingUploads([row({ id: "a1", automatic: true, manifestSha256: "mf-1", status: "failed", errorCode: "package_changed" })], database), true);
    assert.equal(await insertPublishingUploads([row({ id: "a2", automatic: true, manifestSha256: "mf-2", status: "cancelled" })], database), true);
    assert.equal(await insertPublishingUploads([row({ id: "m1", automatic: false, manifestSha256: "mf-manual", video: "V66" })], database), true);
    assert.equal(await insertPublishingUploads([row({ id: "o1", channelId: "UC2", automatic: true, manifestSha256: "mf-other" })], database), true);
    assert.deepEqual([...(await listTriedManifestHashes("UC1", database))].sort(), ["mf-1", "mf-2", "mf-manual"]);
    assert.deepEqual([...(await listTriedManifestHashes("UC2", database))], ["mf-other"]);
  }));

// BL-225 stage 2 (WEEKLY_PUBLISHING_PLAN.md stage 2, ADR 0051; ADR 0001 additive): schema v110 adds `publishing_uploads.slot_id`,
// nullable -- a row written before reads null, the migration converges when run again, and a row keeps the slot it was given.
test("v110: slot_id is null on an older row, kept on a new one; the migration runs again without change", () =>
  withDb(async (database, client) => {
    await client.execute(
      "INSERT INTO publishing_uploads (id, channel_id, video, manifest_path, manifest_sha256, package_json, settings_json, approved_by, approved_at, status, total_bytes, stored_bytes, publish_at_at_insert, steps_json, attempts, created_at, updated_at) " +
        "VALUES ('old', 'UC1', 'V60', 'p', 'mf-old', '{}', '{}', 'u', 0, 'done', 1, 1, 0, '{}', 1, 0, 0)"
    );
    await SCHEMA_MIGRATIONS.find((m) => m.version === 110)!.apply(client);
    assert.equal((await client.execute("SELECT slot_id FROM publishing_uploads WHERE id = 'old'")).rows[0].slot_id, null);
    assert.equal(await insertPublishingUploads([row({ id: "n1", video: "V64", manifestSha256: "mf-n1", slotId: "w44-mon" })], database), true);
    assert.equal((await client.execute("SELECT slot_id FROM publishing_uploads WHERE id = 'n1'")).rows[0].slot_id, "w44-mon");
  }));
