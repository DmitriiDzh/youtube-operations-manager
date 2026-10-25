import assert from "node:assert/strict";
import test from "node:test";
import type { ScannedPackage } from "@/lib/publishing";
import { progressOfSlots } from "./progress";

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
    package: { video: "V64", title: "Title V64", durationSeconds: 10800, languages: ["de", "ja"], containsSyntheticMedia: true, thumbnailPath: "04 Videos/10 October/1026 V64/T.jpg", testThumbnails: 2, problems: [] },
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
