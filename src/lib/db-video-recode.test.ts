import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  appSettings,
  createIsolatedDb,
  initializeDatabaseSchema,
  insertPublishingUploads,
  insertSocialPostJob,
  insertVideoReservation,
  listPublishingUploads,
  recodeVideoRows,
  snapshotVideoRecodeRows,
  socialPostJobs,
  undoVideoRecodeRows,
  videoReservations,
  type AppDb,
  type VideoRecodePlan,
} from "@/lib/db";

// BL-263 (SHORT_VIDEO_CODE_PLAN.md §6.2 step 5, AC-SC-13/18/19): the recode's database step on a real schema. Expected rows by hand:
// the upload row of V14 names S12, the new manifest path and hash, keeps its video id; V14's reservation is cancelled with replacedBy
// S12 and S12 is in work with V14's working title; a finished cross-post job moves (code + hash); the orientation memo key moves.
// Another channel's rows never change. A row that moved meanwhile rolls the whole transaction back. The undo puts every value back and
// is idempotent (twice, or after a recode that never committed, changes nothing more).

async function withDb(run: (database: AppDb, client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-recode-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(createIsolatedDb(client), client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const FROM = "04 Videos/11 November/1105 V14 Short";
const TO = "04 Videos/11 November/1105 S12 Short";
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  channelId: "UC_wwe",
  video: "V14",
  manifestPath: `${FROM}/V14_release.json`,
  manifestSha256: "a".repeat(64),
  packageJson: JSON.stringify({ video: "V14", manifestPath: `${FROM}/V14_release.json` }),
  settingsJson: "{}",
  approvedBy: "owner",
  approvedAt: new Date(1),
  status: "done" as const,
  totalBytes: 10,
  storedBytes: 10,
  videoId: "6Zt6kYUUMVo",
  publishAtAtInsert: false,
  stepsJson: "{}",
  attempts: 0,
  createdAt: new Date(1),
  updatedAt: new Date(1),
  ...over,
});
const social = (jobId: string, channelId: string, status: "published" | "uploading") => ({
  jobId,
  channelId,
  slotId: "wwe-v14-s0012",
  video: "V14",
  network: "facebook" as const,
  manifestSha256: "a".repeat(64),
  plannedAt: new Date(1),
  status,
  createdAt: new Date(1),
  updatedAt: new Date(1),
});

async function seed(database: AppDb) {
  await insertPublishingUploads([row("u14"), row("other", { channelId: "UC_other" })], database);
  await insertVideoReservation({ channelId: "UC_wwe", video: "V14", workingTitle: "Piece 12", reservedAt: "2026-10-01T00:00:00.000Z", state: "in_work", cancelledAt: null, replacedBy: null }, database);
  await insertVideoReservation({ channelId: "UC_other", video: "V14", workingTitle: null, reservedAt: "2026-10-01T00:00:00.000Z", state: "in_work", cancelledAt: null, replacedBy: null }, database);
  await insertSocialPostJob(social("s1", "UC_wwe", "published"), database);
  await insertSocialPostJob(social("s2", "UC_other", "published"), database);
  await database.insert(appSettings).values({ key: "video_orientations", value: JSON.stringify({ UC_wwe: { V14: "vertical", V4: "horizontal" }, UC_other: { V14: "horizontal" } }) });
}

const NEW_SHA = "b".repeat(64);
const plan: VideoRecodePlan = {
  uploads: [{ id: "u14", manifestPath: `${TO}/S12_release.json`, manifestSha256: NEW_SHA, packageJson: JSON.stringify({ video: "S12", manifestPath: `${TO}/S12_release.json` }) }],
  at: "2026-11-16T12:00:00.000Z",
  manifestSha256: NEW_SHA,
};

async function dump(database: AppDb) {
  const uploads = (await listPublishingUploads({ limit: 50 }, database)).map((u) => [u.id, u.channelId, u.video, u.manifestPath, u.manifestSha256, u.videoId]).sort();
  const reservations = (await database.select().from(videoReservations)).map((r) => [r.channelId, r.video, r.workingTitle, r.state, r.replacedBy]).sort();
  const jobs = (await database.select().from(socialPostJobs)).map((j) => [j.jobId, j.video, j.manifestSha256]).sort();
  const [memo] = await database.select().from(appSettings);
  return { uploads, reservations, jobs, memo: memo ? JSON.parse(memo.value) : null };
}

test("BL-263: recodeVideoRows moves this channel's rows V14 → S12 in one transaction; undo puts every value back, twice changes nothing", async () => {
  await withDb(async (database) => {
    await seed(database);
    const before = await dump(database);
    const snapshot = await snapshotVideoRecodeRows("UC_wwe", "V14", "S12", ["u14"], database);
    assert.deepEqual(snapshot.uploads.map((u) => [u.id, u.videoId]), [["u14", "6Zt6kYUUMVo"]]);
    assert.deepEqual(snapshot.socialJobs, [{ jobId: "s1", manifestSha256: "a".repeat(64) }]);
    assert.equal(snapshot.orientation, "vertical");
    await recodeVideoRows(snapshot, plan, database);
    const after = await dump(database);
    assert.deepEqual(after.uploads, [
      ["other", "UC_other", "V14", `${FROM}/V14_release.json`, "a".repeat(64), "6Zt6kYUUMVo"],
      ["u14", "UC_wwe", "S12", `${TO}/S12_release.json`, NEW_SHA, "6Zt6kYUUMVo"],
    ]);
    assert.deepEqual(after.reservations, [
      ["UC_other", "V14", null, "in_work", null],
      ["UC_wwe", "S12", "Piece 12", "in_work", null],
      ["UC_wwe", "V14", "Piece 12", "cancelled", "S12"],
    ]);
    assert.deepEqual(after.jobs, [
      ["s1", "S12", NEW_SHA],
      ["s2", "V14", "a".repeat(64)],
    ]);
    assert.deepEqual(after.memo, { UC_wwe: { S12: "vertical", V4: "horizontal" }, UC_other: { V14: "horizontal" } });
    await undoVideoRecodeRows(snapshot, plan, database);
    assert.deepEqual(await dump(database), before);
    await undoVideoRecodeRows(snapshot, plan, database);
    assert.deepEqual(await dump(database), before, "idempotent");
  });
});

test("BL-263: a row that moved meanwhile (or a leased upload) rolls the whole transaction back; an undo after it changes nothing", async () => {
  await withDb(async (database) => {
    await seed(database);
    const before = await dump(database);
    const snapshot = await snapshotVideoRecodeRows("UC_wwe", "V14", "S12", ["u14"], database);
    // The upload row changed after the snapshot (another manifest hash): refused, nothing changed.
    await database.update((await import("@/lib/db")).publishingUploads).set({ manifestSha256: "c".repeat(64) });
    await assert.rejects(recodeVideoRows(snapshot, plan, database), /changed while the release was recoded/);
    const moved = await dump(database);
    assert.deepEqual(moved.reservations, before.reservations);
    assert.deepEqual(moved.jobs, before.jobs);
    assert.deepEqual(moved.memo, before.memo);
    await undoVideoRecodeRows(snapshot, plan, database);
    assert.deepEqual(await dump(database), moved);
  });
});

test("BL-263: an S12 reservation already there makes the transaction fail; this computer without a V14 reservation gets one cancelled", async () => {
  await withDb(async (database) => {
    await seed(database);
    await insertVideoReservation({ channelId: "UC_wwe", video: "S12", workingTitle: null, reservedAt: "2026-11-01T00:00:00.000Z", state: "cancelled", cancelledAt: "2026-11-01T00:00:00.000Z", replacedBy: null }, database);
    const before = await dump(database);
    const snapshot = await snapshotVideoRecodeRows("UC_wwe", "V14", "S12", ["u14"], database);
    await assert.rejects(recodeVideoRows(snapshot, plan, database));
    assert.deepEqual(await dump(database), before);
  });
  await withDb(async (database) => {
    await insertPublishingUploads([row("u14")], database);
    const snapshot = await snapshotVideoRecodeRows("UC_wwe", "V14", "S12", ["u14"], database);
    assert.equal(snapshot.reservation, null);
    await recodeVideoRows(snapshot, plan, database);
    assert.deepEqual((await dump(database)).reservations, [
      ["UC_wwe", "S12", null, "in_work", null],
      ["UC_wwe", "V14", null, "cancelled", "S12"],
    ]);
    await undoVideoRecodeRows(snapshot, plan, database);
    assert.deepEqual((await dump(database)).reservations, []);
  });
});
