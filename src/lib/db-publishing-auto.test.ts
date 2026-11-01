import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import { getPublishingUpload, initializeDatabaseSchema, insertPublishingUploads, listPublishingUploads, listTriedManifestHashes, reorderQueuedPublishingUploads, SCHEMA_MIGRATIONS, type AppDb, type StoredPublishingUpload } from "@/lib/db";

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
  // BL-239 (schema v117): the queue place (0: the order falls back to createdAt) and who queued it.
  queueRank: 0,
  queuedBy: null,
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

// Review #6 (LOW): the plan schedule read the newest 500 done rows of every channel and then kept those with a slot -- a busy
// computer could push a slot's row out of the window. `withSlot` filters in SQL, so every done row with a slot is listed.
test("review #6: listPublishingUploads({ withSlot }) lists only rows with a slot, before the limit applies", () =>
  withDb(async (database) => {
    for (let i = 0; i < 5; i += 1) {
      await insertPublishingUploads([row({ id: `n${i}`, video: `V${70 + i}`, manifestSha256: `n${i}`, status: "done", createdAt: new Date(T.getTime() + 1000 * (i + 1)) })], database);
    }
    await insertPublishingUploads([row({ id: "s1", video: "V64", manifestSha256: "s1", status: "done", slotId: "w44-mon" })], database);
    const listed = await listPublishingUploads({ statuses: ["done"], withSlot: true, limit: 2 }, database);
    assert.deepEqual(listed.map((r) => r.id), ["s1"]);
  }));

// BL-239 (UPLOAD_QUEUE_CONTROL_PLAN.md AC-UQ-13, ADR 0059; ADR 0001 additive): schema v117 adds `queue_rank` (an older row's place is
// its creation time, so the old order stands) and `queued_by` (an older row's from its `automatic` flag); it converges when run again.
test("AC-UQ-13 v117: an older row's queue_rank is its created_at and its queued_by follows automatic; it runs again unchanged", () =>
  withDb(async (_database, client) => {
    for (const [id, automatic, createdAt] of [["old-a", 1, 5000], ["old-o", 0, 7000]] as const) {
      await client.execute({
        sql:
          "INSERT INTO publishing_uploads (id, channel_id, video, manifest_path, manifest_sha256, package_json, settings_json, approved_by, approved_at, status, total_bytes, stored_bytes, publish_at_at_insert, steps_json, attempts, created_at, updated_at, automatic, queue_rank, queued_by) " +
          "VALUES (?, 'UC1', ?, 'p', ?, '{}', '{}', 'u', 0, 'queued', 1, 0, 0, '{}', 0, ?, 0, ?, 0, NULL)",
        args: [id, id, `mf-${id}`, createdAt, automatic],
      });
    }
    const migration = SCHEMA_MIGRATIONS.find((m) => m.version === 117)!;
    await migration.apply(client);
    await migration.apply(client);
    const read = await client.execute("SELECT id, queue_rank, queued_by FROM publishing_uploads ORDER BY id");
    assert.deepEqual(read.rows.map((r) => [r.id, Number(r.queue_rank), r.queued_by]), [
      ["old-a", 5000, "automatic"],
      ["old-o", 7000, "owner"],
    ]);
  }));

test("AC-UQ-13: a new row joins the end (its creation time); an approval's rows keep their order", () =>
  withDb(async (database) => {
    await insertPublishingUploads([row({ id: "a", video: "V1", manifestSha256: "a", status: "queued" }), row({ id: "b", video: "V2", manifestSha256: "b", status: "queued" })], database);
    assert.deepEqual([(await getPublishingUpload("a", database))!.queueRank, (await getPublishingUpload("b", database))!.queueRank], [T.getTime(), T.getTime() + 1]);
  }));

// AC-UQ-03 / AC-UQ-04 at the store: the queued rows get places 1..N in the order given, all or none.
test("AC-UQ-03/04: reorderQueuedPublishingUploads renumbers the queued rows; one no longer queued changes nothing", () =>
  withDb(async (database) => {
    for (const [id, video] of [["a", "V1"], ["b", "V2"], ["c", "V3"]] as const) await insertPublishingUploads([row({ id, video, manifestSha256: id, status: "queued" })], database);
    assert.equal(await reorderQueuedPublishingUploads(["c", "a", "b"], database), true);
    const rank = async (id: string) => (await getPublishingUpload(id, database))!.queueRank;
    assert.deepEqual([await rank("c"), await rank("a"), await rank("b")], [1, 2, 3]);
    await insertPublishingUploads([row({ id: "s", video: "V4", manifestSha256: "s", status: "uploading" })], database);
    assert.equal(await reorderQueuedPublishingUploads(["s", "c", "a", "b"], database), false, "a row that is uploading cannot be ordered");
    assert.deepEqual([await rank("c"), await rank("a"), await rank("b")], [1, 2, 3], "nothing renumbered");
  }));
