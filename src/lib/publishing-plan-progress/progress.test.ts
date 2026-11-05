import assert from "node:assert/strict";
import test from "node:test";
import type { ScannedPackage } from "@/lib/publishing";
import { deletedVideosBySlot, progressOfSlots } from "./progress";

// BL-225 stage 2 (WEEKLY_PUBLISHING_PLAN.md AC-WP-23; FO-REQ-0040 item 6): a slot named by a ready v2 package is `packaged`, one
// whose package is not ready but whose video is there is `built`; an uploaded package is `scheduled` / `published` by the
// channel's copy, with the video id. The row shows the package's translations, AI flag (the package's, else the channel's) and
// thumbnails. A package naming no asked slot, or none at all, gives nothing.

const pkgOf = (video: string, slotId: string | null, over: Record<string, unknown> = {}) => ({
  channelId: "UC_japan",
  video,
  mix: null,
  plannedPublishDate: null,
  files: { video: `${video}.mp4`, thumbnail: "T.jpg" },
  sizeBytes: 1,
  durationSeconds: 10800,
  title: `Title ${video}`,
  description: "",
  tags: [],
  defaultLanguage: "en",
  defaultAudioLanguage: "zxx",
  ready: true,
  problems: [],
  schemaVersion: 2 as const,
  slotId,
  localizations: { ja: { title: "t", description: "d" }, de: { title: "t", description: "d" } },
  containsSyntheticMedia: null,
  thumbnails: [
    { file: "T.jpg", role: "default" as const },
    { file: "B.jpg", role: "test" as const },
    { file: "C.jpg", role: "test" as const },
  ],
  ...over,
});
const scanned = (video: string, slotId: string | null, over: Partial<ScannedPackage> = {}, pkgOver: Record<string, unknown> = {}): ScannedPackage => ({
  manifestPath: `04 Videos/10 October/1026 ${video}/${video}_release.json`,
  folder: `04 Videos/10 October/1026 ${video}`,
  video,
  title: `Title ${video}`,
  plannedPublishDate: null,
  thumbnailPath: `04 Videos/10 October/1026 ${video}/T.jpg`,
  sizeBytes: 1,
  durationSeconds: 10800,
  state: "ready",
  problems: [],
  youtube: null,
  existsOnChannel: null,
  checkedAt: null,
  pkg: pkgOf(video, slotId, pkgOver),
  manifestSha256: "m",
  ...over,
});

test("AC-WP-23: ready -> packaged with the package's facts; the AI flag falls back to the channel's", () => {
  const map = progressOfSlots([scanned("V64", "s1")], ["s1"], true);
  assert.deepEqual(map.get("s1"), {
    status: "packaged",
    code: null,
    videoId: null,
    publishAt: null, // review #3 added the video's date (none before an upload)
    package: { video: "V64", title: "Title V64", durationSeconds: 10800, languages: ["de", "ja"], containsSyntheticMedia: true, thumbnailPath: "04 Videos/10 October/1026 V64/T.jpg", testThumbnails: 2, problems: [], manifestSha256: "m" }, // BL-242: the manifest's SHA-256 (ADR 0062 §2)
  });
  assert.equal(progressOfSlots([scanned("V64", "s1", {}, { containsSyntheticMedia: false })], ["s1"], true).get("s1")?.package?.containsSyntheticMedia, false);
});

test("AC-WP-23: not ready with its video -> built (problems listed); without its video -> nothing", () => {
  const built = progressOfSlots([scanned("V64", "s1", { state: "not_ready", problems: [{ code: "localizations_invalid" }] })], ["s1"], true).get("s1");
  assert.equal(built?.status, "built");
  assert.deepEqual(built?.package?.problems, ["localizations_invalid"]);
  assert.equal(progressOfSlots([scanned("V64", "s1", { state: "not_ready", problems: [{ code: "video_missing" }] })], ["s1"], true).size, 0);
});

test("AC-WP-23: uploaded packages give scheduled / published with the video id; the furthest package of a slot wins", () => {
  const scheduled = scanned("V64", "s1", { state: "scheduled", youtube: { videoId: "abcdefghijk", privacyStatus: "private", publishAt: "2026-10-26T09:00:00Z" } });
  const ready = scanned("V65", "s1");
  const map = progressOfSlots([ready, scheduled], ["s1"], true);
  assert.deepEqual([map.get("s1")?.status, map.get("s1")?.videoId], ["scheduled", "abcdefghijk"]);
  const published = scanned("V66", "s2", { state: "published", youtube: { videoId: "zzzzzzzzzzz", privacyStatus: "public", publishAt: null } });
  assert.equal(progressOfSlots([published], ["s2"], true).get("s2")?.status, "published");
});

test("AC-WP-23: a package without a slot, for another slot, or unparsed gives nothing", () => {
  const map = progressOfSlots([scanned("V64", null), scanned("V65", "other"), { ...scanned("V66", "s1"), pkg: null }], ["s1"], true);
  assert.equal(map.size, 0);
});

// BL-225 stage 3 (AC-WP-30/33, FO-REQ-0040 item 6 and acceptance 3/4): this computer's upload row for a slot says where it stands --
// under way: uploading; failed: its code; done: the first step that kept the date off, else scheduled until the date and published
// after it; the date counts only once it is on the video. The newest row of a slot wins over the package scan.
const uploadRow = (over: Partial<import("./progress").UploadRowForProgress> = {}) => ({
  slotId: "s1",
  status: "done",
  videoId: "vid64",
  publishAt: "2026-10-26T09:00:00.000Z",
  errorCode: null,
  stepsJson: JSON.stringify({ localizations: "verified", thumbnail: "set", playlist: "added", verify: { result: "verified" }, publishAt: "set" }),
  createdAt: new Date("2026-10-24T00:00:00Z"),
  ...over,
});
const NOW_MS = Date.parse("2026-10-25T12:00:00Z");

test("AC-WP-30/33: upload rows -> uploading, failed with the step's code, scheduled, published; the date counts once on the video", async () => {
  const { progressOfUploadRow } = await import("./progress");
  assert.deepEqual(progressOfUploadRow(uploadRow({ status: "uploading", videoId: null }), NOW_MS), { status: "uploading", code: null, videoId: null });
  assert.deepEqual(progressOfUploadRow(uploadRow({ status: "failed", errorCode: "processing_rejected" }), NOW_MS), { status: "failed", code: "processing_rejected", videoId: "vid64" });
  assert.equal(progressOfUploadRow(uploadRow(), NOW_MS)?.status, "scheduled");
  assert.equal(progressOfUploadRow(uploadRow(), Date.parse("2026-10-26T10:00:00Z"))?.status, "published");
  const failedThumbnail = uploadRow({ stepsJson: JSON.stringify({ localizations: "verified", thumbnail: "failed", playlist: "added", verify: { result: "verified" }, publishAt: "withheld" }) });
  assert.deepEqual(progressOfUploadRow(failedThumbnail, NOW_MS), { status: "failed", code: "thumbnail_failed", videoId: "vid64" });
  assert.equal(progressOfUploadRow(uploadRow({ stepsJson: JSON.stringify({ localizations: "mismatch" }) }), NOW_MS)?.code, "localizations_mismatch");
  assert.equal(progressOfUploadRow(uploadRow({ stepsJson: JSON.stringify({ thumbnail: "set", playlist: "none", verify: { result: "verified" } }) }), NOW_MS)?.status, "packaged", "a planned date not yet on the video");
  assert.equal(progressOfUploadRow(uploadRow({ publishAt: null }), NOW_MS)?.status, "packaged");
  assert.equal(progressOfUploadRow(uploadRow({ status: "cancelled" }), NOW_MS), null);
});

test("AC-WP-23/30: the newest upload row of a slot overrides the package scan, keeping the package's facts", async () => {
  const { progressWithUploads } = await import("./progress");
  const fromPackages = progressOfSlots([scanned("V64", "s1")], ["s1"], true);
  const merged = progressWithUploads(fromPackages, [uploadRow({ status: "failed", errorCode: "x", createdAt: new Date("2026-10-23T00:00:00Z") }), uploadRow()], ["s1"], NOW_MS);
  assert.equal(merged.get("s1")?.status, "scheduled");
  assert.equal(merged.get("s1")?.package?.video, "V64");
  assert.equal(progressWithUploads(new Map(), [uploadRow({ slotId: "other" })], ["s1"], NOW_MS).size, 0);
});

// Review #3: the progress carries the date the uploaded video has, so the plan does not call the slot released before it.
test("review #3: a scheduled row and an uploaded package give their video's date", async () => {
  const { progressOfUploadRow } = await import("./progress");
  assert.equal(progressOfUploadRow(uploadRow(), NOW_MS)?.publishAt, "2026-10-26T09:00:00.000Z");
  const scheduled = scanned("V64", "s1", { state: "scheduled", youtube: { videoId: "abcdefghijk", privacyStatus: "private", publishAt: "2026-10-30T09:00:00Z" } });
  assert.equal(progressOfSlots([scheduled], ["s1"], true).get("s1")?.publishAt, "2026-10-30T09:00:00Z");
});

// Round 3 review of BL-242 (b): an upload row of a slot describes the slot's package only when it is of that package's video -- once
// the slot names another package (the old video moved to another slot), the row is not that package's progress.
test("round 3 (b): a slot's upload row of another video does not override its current package", async () => {
  const { progressWithUploads } = await import("./progress");
  const fromPackages = progressOfSlots([scanned("V80", "s1")], ["s1"], true);
  const merged = progressWithUploads(fromPackages, [uploadRow({ video: "V73" })], ["s1"], NOW_MS);
  assert.deepEqual(merged.get("s1"), fromPackages.get("s1"));
  const same = progressWithUploads(progressOfSlots([scanned("V64", "s1")], ["s1"], true), [uploadRow({ video: "V64" })], ["s1"], NOW_MS);
  assert.equal(same.get("s1")?.status, "scheduled");
});

// BL-243 (WEEKLY_PUBLISHING_PLAN.md AC-WP-69): a package whose video was deleted on YouTube is the slot's word only when no other
// package names the slot; then the slot is `failed` with `video_deleted_on_youtube`, the video id kept, no date. An upload row of a
// removed video says nothing.
const deleted73 = () =>
  scanned("V73", "s1", {
    state: "deleted_on_youtube",
    problems: [{ code: "video_deleted_on_youtube" }],
    youtube: { videoId: "vid73", privacyStatus: null, publishAt: null, removedAt: "2026-11-03T19:54:00.000Z" },
    existsOnChannel: false,
  });

test("BL-243 AC-WP-69: deleted alone -> failed video_deleted_on_youtube; with another package naming the slot -> that one's word", async () => {
  const { progressWithUploads } = await import("./progress");
  const alone = progressOfSlots([deleted73()], ["s1"], false).get("s1");
  assert.equal(alone?.status, "failed");
  assert.equal(alone?.code, "video_deleted_on_youtube");
  assert.equal(alone?.videoId, "vid73");
  assert.equal(alone?.publishAt, null);
  assert.equal(alone?.package?.video, "V73");
  assert.deepEqual(alone?.package?.problems, ["video_deleted_on_youtube"]);

  const withFresh = progressOfSlots([deleted73(), scanned("V80", "s1")], ["s1"], false).get("s1");
  assert.equal(withFresh?.status, "packaged");
  assert.equal(withFresh?.videoId, null);
  assert.equal(withFresh?.package?.video, "V80");
  // The order of the packages does not matter.
  assert.equal(progressOfSlots([scanned("V80", "s1"), deleted73()], ["s1"], false).get("s1")?.package?.video, "V80");

  const noVideo = scanned("V80", "s1", { state: "not_ready", problems: [{ code: "video_missing" }] });
  assert.equal(progressOfSlots([deleted73(), noVideo], ["s1"], false).has("s1"), false, "another package names the slot: the deleted one is not its word");

  // A done, dated, verified upload row of vid73 (removed) says nothing; without the mark it would (BL-225).
  const row73 = uploadRow({ video: "V73", videoId: "vid73" });
  const excl = (packages: ScannedPackage[]) => ({ removedVideoIds: new Set(["vid73"]), deletedVideosBySlot: deletedVideosBySlot(packages) });
  assert.deepEqual(progressWithUploads(progressOfSlots([deleted73()], ["s1"], false), [row73], ["s1"], NOW_MS, excl([deleted73()])).get("s1"), alone);
  const freshSame = [deleted73(), scanned("V73", "s1", { manifestPath: "b/V73_release.json" })];
  assert.equal(progressWithUploads(progressOfSlots(freshSame, ["s1"], false), [row73], ["s1"], NOW_MS, excl(freshSame)).get("s1")?.status, "packaged");
  assert.equal(progressWithUploads(progressOfSlots([scanned("V73", "s1", { state: "uploaded_unknown", youtube: { videoId: "vid73", privacyStatus: null, publishAt: null } })], ["s1"], false), [row73], ["s1"], NOW_MS).get("s1")?.status, "scheduled", "not removed: the row speaks (BL-225)");
});

// BL-243 review (AC-WP-69): deleted V73 names its slot with V80, which has no progress yet (its video file is missing) -- the done,
// dated row of vid73 still says nothing. (Round 2: an unreadable removed list yields no deleted package at all, so the scan's ids
// are the one source; the deleted packages' numbers by slot cover the rows without a video id.)
test("BL-243 AC-WP-69: a deleted package's rows say nothing even when another package without progress names the slot", async () => {
  const { progressWithUploads } = await import("./progress");
  const noVideo = scanned("V80", "s1", { state: "not_ready", problems: [{ code: "video_missing" }] });
  const packages = [deleted73(), noVideo];
  // (round 3: each deleted package with its manifest and record time, to tell its tries from a fresh package's)
  assert.deepEqual([...deletedVideosBySlot(packages)], [["s1", [{ video: "V73", uploadedAt: null }]]]);
  const merged = progressWithUploads(progressOfSlots(packages, ["s1"], false), [uploadRow({ video: "V73", videoId: "vid73" })], ["s1"], NOW_MS, { removedVideoIds: new Set(["vid73"]), deletedVideosBySlot: deletedVideosBySlot(packages) });
  assert.equal(merged.has("s1"), false);
});

// BL-243 (AC-WP-75, the one rule of review round 5): a row counts for its slot only when created after the newest deleted upload of
// that slot and video number -- the removed video's row (its upload time, else its creation), else the deleted package's record
// uploadedAt; a deleted upload with no known time blocks every row of the number; the removed video's own row never counts.
test("BL-243 AC-WP-75: no try of a deleted package ever counts again; a later try of the number does", async () => {
  const { progressWithUploads } = await import("./progress");
  const olderFailed = uploadRow({ video: "V73", videoId: null, status: "failed", errorCode: "processing_rejected", createdAt: new Date("2026-10-20T00:00:00Z") });
  const removedRow = uploadRow({ video: "V73", videoId: "vid73", createdAt: new Date("2026-10-24T00:00:00Z") });
  const exclusions = (packages: ScannedPackage[]) => ({ removedVideoIds: new Set(["vid73"]), deletedVideosBySlot: deletedVideosBySlot(packages) });
  const alone = [deleted73()];
  const merged = progressWithUploads(progressOfSlots(alone, ["s1"], false), [olderFailed, removedRow], ["s1"], NOW_MS, exclusions(alone)).get("s1");
  assert.equal(merged?.status, "failed");
  assert.equal(merged?.code, "video_deleted_on_youtube");
  assert.equal(merged?.videoId, "vid73");
  // The older row alone (the removed row is on another computer) and the record without uploadedAt: no time known -> blocked.
  assert.equal(progressWithUploads(progressOfSlots(alone, ["s1"], false), [olderFailed], ["s1"], NOW_MS, exclusions(alone)).get("s1")?.code, "video_deleted_on_youtube");

  // A fresh V73 (any manifest -- it is not part of the rule); the deleted record says it was uploaded 10-22.
  const timed = scanned("V73", "s1", { ...deleted73(), youtube: { videoId: "vid73", privacyStatus: null, publishAt: null, removedAt: "2026-11-03T19:54:00.000Z", uploadedAt: "2026-10-22T00:00:00.000Z" } });
  const fresh = [timed, scanned("V73", "s1", { manifestPath: "b/V73_release.json", manifestSha256: "fresh" })];
  assert.equal(progressWithUploads(progressOfSlots(fresh, ["s1"], false), [olderFailed], ["s1"], NOW_MS, exclusions(fresh)).get("s1")?.status, "packaged", "before the deleted upload: not counted");
  const newTry = uploadRow({ video: "V73", videoId: null, status: "uploading", createdAt: new Date("2026-10-25T00:00:00Z") });
  assert.equal(progressWithUploads(progressOfSlots(fresh, ["s1"], false), [olderFailed, newTry], ["s1"], NOW_MS, exclusions(fresh)).get("s1")?.status, "uploading");
  // The removed row's own time wins over the record's: a try at 10-23 is before the removed row (10-24) -> not counted.
  const between = uploadRow({ video: "V73", videoId: null, status: "failed", errorCode: "x", createdAt: new Date("2026-10-23T00:00:00Z") });
  assert.equal(progressWithUploads(progressOfSlots(fresh, ["s1"], false), [between, removedRow], ["s1"], NOW_MS, exclusions(fresh)).get("s1")?.status, "packaged");
  // No time known at all (no removed row, a record without uploadedAt): even a later row of the number is not counted.
  const untimed = [deleted73(), scanned("V73", "s1", { manifestPath: "b/V73_release.json", manifestSha256: "fresh" })];
  assert.equal(progressWithUploads(progressOfSlots(untimed, ["s1"], false), [newTry], ["s1"], NOW_MS, exclusions(untimed)).get("s1")?.status, "packaged");
});

// BL-243 review round 3, item 2 (AC-WP-79): a row whose plan change found the video gone (confirmed) is a failure with a code.
test("BL-243 AC-WP-79: a row with planSync video_missing is failed video_deleted_on_youtube, never packaged", async () => {
  const { progressOfUploadRow } = await import("./progress");
  const steps = { localizations: "verified", thumbnail: "set", playlist: "added", verify: { result: "verified" }, publishAt: "set" };
  // Round 7: a counted row (its video not marked removed) with video_missing is a plain failed plan change; a removed video's row
  // never reaches here (it is filtered out), so its kept date cannot make the slot look scheduled.
  const missingRow = uploadRow({ stepsJson: JSON.stringify({ ...steps, planSync: { action: "unscheduled", result: "video_missing" } }) });
  assert.deepEqual(progressOfUploadRow(missingRow, NOW_MS), { status: "failed", code: "plan_unscheduled_failed", videoId: "vid64" });
  const { progressWithUploads } = await import("./progress");
  const filtered = progressWithUploads(progressOfSlots([deleted73()], ["s1"], false), [{ ...missingRow, video: "V73", videoId: "vid73" }], ["s1"], NOW_MS, { removedVideoIds: new Set(["vid73"]) });
  assert.equal(filtered.get("s1")?.code, "video_deleted_on_youtube", "the removed video's row with its kept date is ignored");
  assert.equal(progressOfUploadRow(uploadRow({ stepsJson: JSON.stringify({ ...steps, planSync: { action: "unscheduled", result: "refused" } }) }), NOW_MS)?.code, "plan_unscheduled_failed");
});

// BL-243 review round 2, item 8, and round 3, item 7 (AC-WP-76): of two deleted packages naming one slot, the one uploaded last
// speaks -- by its record's uploadedAt, else by the uploadedAt its upload row here recorded (the same kind of time, never a row's
// creation); never by the scan's order alone.
test("BL-243 AC-WP-76: the newest deleted upload speaks for the slot", () => {
  const deleted = (video: string, videoId: string, uploadedAt: string | null) =>
    scanned(video, "s1", { state: "deleted_on_youtube", problems: [{ code: "video_deleted_on_youtube" }], youtube: { videoId, privacyStatus: null, publishAt: null, removedAt: "2026-11-03T19:54:00.000Z", uploadedAt }, existsOnChannel: false });
  const older = deleted("V72", "vid72", "2026-11-01T10:00:00.000Z");
  const newer = deleted("V73", "vid73", "2026-11-02T10:00:00.000Z");
  assert.equal(progressOfSlots([newer, older], ["s1"], false).get("s1")?.videoId, "vid73");
  assert.equal(progressOfSlots([older, newer], ["s1"], false).get("s1")?.videoId, "vid73");
  // No uploadedAt in the records: the upload times the rows recorded decide.
  const a = deleted("V72", "vid72", null);
  const b = deleted("V73", "vid73", null);
  // (round 4: the rows themselves, their steps' uploadedAt -- created in the other order, which must not matter)
  const rows = [
    uploadRow({ video: "V72", videoId: "vid72", createdAt: new Date("2026-10-01T00:00:00Z"), stepsJson: JSON.stringify({ uploadedAt: "2026-11-02T00:00:00.000Z" }) }),
    uploadRow({ video: "V73", videoId: "vid73", createdAt: new Date("2026-10-30T00:00:00Z"), stepsJson: JSON.stringify({ uploadedAt: "2026-11-01T00:00:00.000Z" }) }),
  ];
  assert.equal(progressOfSlots([b, a], ["s1"], false, rows).get("s1")?.videoId, "vid72");
});

// BL-243 review round 4, item 6: one time rule -- the record's uploadedAt, else the row's own steps.uploadedAt, never createdAt.
test("BL-243: uploadTimeOf takes the record's uploadedAt, else the row's recorded uploadedAt, else nothing", async () => {
  const { uploadTimeOf } = await import("./progress");
  const row = { stepsJson: JSON.stringify({ uploadedAt: "2026-11-02T00:00:00.000Z" }) };
  assert.equal(uploadTimeOf({ uploadedAt: "2026-11-01T00:00:00.000Z" }, row), Date.parse("2026-11-01T00:00:00.000Z"));
  assert.equal(uploadTimeOf({ uploadedAt: null }, row), Date.parse("2026-11-02T00:00:00.000Z"));
  assert.equal(uploadTimeOf(null, { stepsJson: "{}" }), null);
  assert.equal(uploadTimeOf(null, { stepsJson: "{ broken" }), null);
  assert.equal(uploadTimeOf(undefined, null), null);
});

// BL-243 review round 4, item 1 (AC-WP-81): the owner moved V73's Vn_youtube.json away to upload it again -- the package is ready,
// no deleted package names the slot any more. The removed video's row (uploaded 10-24T02:00Z) still blocks every older row of the
// number on that slot: the slot is packaged (approvable), not the old failure; a new try after it counts.
test("BL-243 AC-WP-81: after the re-upload path an old try of the deleted video does not come back", async () => {
  const { progressWithUploads } = await import("./progress");
  const ready = [scanned("V73", "s1")];
  const oldFailed = uploadRow({ video: "V73", videoId: null, status: "failed", errorCode: "processing_rejected", createdAt: new Date("2026-10-20T00:00:00Z") });
  const removedRow = uploadRow({ video: "V73", videoId: "vid73", createdAt: new Date("2026-10-24T00:00:00Z"), stepsJson: JSON.stringify({ uploadedAt: "2026-10-24T02:00:00.000Z" }) });
  const exclusions = { removedVideoIds: new Set(["vid73"]), deletedVideosBySlot: deletedVideosBySlot(ready) };
  assert.equal(exclusions.deletedVideosBySlot.size, 0);
  const merged = progressWithUploads(progressOfSlots(ready, ["s1"], false), [oldFailed, removedRow], ["s1"], NOW_MS, exclusions).get("s1");
  assert.equal(merged?.status, "packaged");
  assert.equal(merged?.code, null);
  assert.equal(merged?.videoId, null);
  // Created before the removed upload's time (02:00Z) -> blocked; after it -> a new try that counts.
  const during = uploadRow({ video: "V73", videoId: null, status: "failed", errorCode: "x", createdAt: new Date("2026-10-24T01:00:00Z") });
  assert.equal(progressWithUploads(progressOfSlots(ready, ["s1"], false), [oldFailed, removedRow, during], ["s1"], NOW_MS, exclusions).get("s1")?.status, "packaged");
  const newTry = uploadRow({ video: "V73", videoId: null, status: "uploading", createdAt: new Date("2026-11-05T00:00:00Z") });
  assert.equal(progressWithUploads(progressOfSlots(ready, ["s1"], false), [oldFailed, removedRow, newTry], ["s1"], NOW_MS, exclusions).get("s1")?.status, "uploading");
  // Round 5: the manifest is not part of the rule -- an older row of the number with another manifest is blocked too.
  const otherManifest = uploadRow({ video: "V73", videoId: null, status: "failed", errorCode: "y", createdAt: new Date("2026-10-21T00:00:00Z") });
  assert.equal(progressWithUploads(progressOfSlots(ready, ["s1"], false), [otherManifest, removedRow], ["s1"], NOW_MS, exclusions).get("s1")?.status, "packaged");
});
