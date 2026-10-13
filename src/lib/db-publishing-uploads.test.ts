import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { claimPublishingUpload, createIsolatedDb, getPublishingUpload, initializeDatabaseSchema, insertPublishingUploads, listPublishingUploads, updatePublishingUpload } from "@/lib/db";

// BL-182 stage 2 (ADR 0037 §4, "never twice"; PUBLISHING_PLAN.md §2 stage 2 items 5–6): the upload queue keeps at most one live row
// per channel and video -- a second approval of the same package is refused whole -- and a failed or cancelled row lets the package
// be approved again. Every change is compare-and-set on the status, so two ticks never both advance one upload.

const row = (id: string, video: string, over: Record<string, unknown> = {}) => ({
  id,
  channelId: "UC_t",
  video,
  manifestPath: `04 Videos/10 October/x ${video}/${video}_release.json`,
  manifestSha256: "abc",
  packageJson: "{}",
  settingsJson: "{}",
  publishAt: null,
  approvedBy: "u1",
  approvedAt: new Date("2026-10-13T12:00:00Z"),
  status: "queued" as const,
  totalBytes: 1000,
  storedBytes: 0,
  publishAtAtInsert: false,
  stepsJson: "{}",
  attempts: 0,
  createdAt: new Date("2026-10-13T12:00:00Z"),
  updatedAt: new Date("2026-10-13T12:00:00Z"),
  ...over,
});

async function withDb(fn: (db: ReturnType<typeof createIsolatedDb>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "publishing-uploads-test-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(createIsolatedDb(client));
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("one live row per channel and video: a second approval is refused whole; after a failure it is allowed again", () =>
  withDb(async (db) => {
    assert.equal(await insertPublishingUploads([row("a", "V65")], db), true);
    assert.equal(await insertPublishingUploads([row("b", "V66"), row("c", "V65")], db), false, "V65 is already queued");
    assert.equal(await getPublishingUpload("b", db), null, "nothing of the refused approval was written");
    assert.equal(await insertPublishingUploads([row("d", "V65", { channelId: "UC_j" })], db), true, "another channel's V65 is another video");
    assert.equal(await updatePublishingUpload("a", "queued", { status: "failed" }, db), true);
    assert.equal(await insertPublishingUploads([row("e", "V65")], db), true);
    assert.equal(await updatePublishingUpload("e", "queued", { status: "done" }, db), true);
    assert.equal(await insertPublishingUploads([row("f", "V65")], db), false, "a done upload stays the one upload of V65");
  }));

test("updates are compare-and-set on the status; the list is newest first and filters by status", () =>
  withDb(async (db) => {
    await insertPublishingUploads([row("a", "V1"), row("b", "V2", { createdAt: new Date("2026-10-13T12:05:00Z") })], db);
    assert.equal(await updatePublishingUpload("a", "uploading", { storedBytes: 10 }, db), false, "not in that status: nothing written");
    assert.equal((await getPublishingUpload("a", db))?.storedBytes, 0);
    assert.equal(await updatePublishingUpload("a", "queued", { status: "uploading", sessionUri: "https://www.googleapis.com/upload/x" }, db), true);
    assert.deepEqual((await listPublishingUploads({ channelId: "UC_t", limit: 10 }, db)).map((r) => r.id), ["b", "a"]);
    assert.deepEqual((await listPublishingUploads({ statuses: ["uploading"], limit: 10 }, db)).map((r) => r.id), ["a"]);
  }));

// Review B1: a failed (or cancelled) upload whose video exists on YouTube still blocks the package -- only one that never made a
// video lets it be approved again.
test("a failed upload that made a video still blocks the package; one without a video does not", () =>
  withDb(async (db) => {
    assert.equal(await insertPublishingUploads([row("a", "V65")], db), true);
    assert.equal(await updatePublishingUpload("a", "queued", { status: "failed", videoId: "vid1" }, db), true);
    assert.equal(await insertPublishingUploads([row("b", "V65")], db), false, "the failed row has a video");
    assert.equal(await insertPublishingUploads([row("c", "V66")], db), true);
    assert.equal(await updatePublishingUpload("c", "queued", { status: "cancelled" }, db), true);
    assert.equal(await insertPublishingUploads([row("d", "V66")], db), true, "cancelled before YouTube: approvable again");
  }));

// Review should-fix 6: two runners on one database never both work on a row.
test("the lease: one runner holds a row until its lease ends; the holder renews it", () =>
  withDb(async (db) => {
    await insertPublishingUploads([row("a", "V65")], db);
    const t0 = new Date("2026-10-13T12:00:00Z");
    const until = new Date("2026-10-13T12:02:00Z");
    assert.equal(await claimPublishingUpload("a", "runner-1", until, t0, db), true);
    assert.equal(await claimPublishingUpload("a", "runner-2", until, new Date("2026-10-13T12:01:00Z"), db), false);
    assert.equal(await claimPublishingUpload("a", "runner-1", new Date("2026-10-13T12:03:00Z"), new Date("2026-10-13T12:01:00Z"), db), true, "the holder renews");
    assert.equal(await claimPublishingUpload("a", "runner-2", until, new Date("2026-10-13T12:03:00Z"), db), true, "an expired lease is taken over");
  }));

// Re-check 1: an unknown outcome (the last chunk went, no answer) holds the package until the owner releases it.
test("an unknown outcome holds the package until released", () =>
  withDb(async (db) => {
    await insertPublishingUploads([row("a", "V65")], db);
    assert.equal(await updatePublishingUpload("a", "queued", { status: "failed", errorCode: "unknown_outcome" }, db), true);
    assert.equal(await insertPublishingUploads([row("b", "V65")], db), false);
    assert.equal(await updatePublishingUpload("a", "failed", { errorCode: "unknown_outcome_released" }, db), true);
    assert.equal(await insertPublishingUploads([row("c", "V65")], db), true);
  }));
