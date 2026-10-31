import assert from "node:assert/strict";
import test from "node:test";
import { channelNameOfFolder, isAllowedReleaseVideo } from "./allowlist";
import { decideLocally, decideOnContent, decideOnYoutube, isoDurationSeconds, type CleanupUploadFacts, type YoutubeVideoFacts } from "./decide";
import type { VideoTombstone } from "./contracts";

// BL-238 (FO-REQ-0051, ADR 0058). Expected values come from the request and the ADR's acceptance criteria, not from the code:
// AC-1 the one allowed path; AC-2 each check gives its own reason; AC-5 a tombstone left by a crash.

const OK_PATH = "04 Videos/11 November/1105 V72/V72 Tropico Jazz.mp4";

test("AC-1: the channel name is the folder name without its number prefix", () => {
  assert.equal(channelNameOfFolder("01 Tropico Jazz"), "Tropico Jazz");
  assert.equal(channelNameOfFolder("02 Japan Countryside Music"), "Japan Countryside Music");
});

test("AC-1: exactly the release's own final video is allowed", () => {
  assert.equal(isAllowedReleaseVideo(OK_PATH, "V72", "Tropico Jazz"), true);
  assert.equal(isAllowedReleaseVideo("04 Videos/08 August/0805 V1/V1 Japan Countryside Music.mp4", "V1", "Japan Countryside Music"), true);
});

test("AC-1: every other path is refused", () => {
  const no = (p: string, video = "V72", channel = "Tropico Jazz") => assert.equal(isAllowedReleaseVideo(p, video, channel), false, p);
  no("04 Videos/Live Segments/V72 Tropico Jazz.mp4");
  no("04 Videos/Live Segments/11 November/1105 V72/V72 Tropico Jazz.mp4");
  no("04 Videos/11 November/1105 V72/V72 Tropico Jazz.mp4", "V71"); // another video
  no("04 Videos/11 November/1105 V71/V72 Tropico Jazz.mp4"); // folder of another video
  no("04 Videos/11 November/1105 V72/V72 Japan Countryside Music.mp4"); // another channel's name
  no("04 Videos/2026-11/1105 V72/V72 Tropico Jazz.mp4"); // month folder not <MM> <Month>
  no("04 Videos/11 October/1105 V72/V72 Tropico Jazz.mp4"); // MM and name disagree
  no("04 Videos/11 November/1005 V72/V72 Tropico Jazz.mp4"); // MMDD of another month
  no("04 Videos/11 November/1100 V72/V72 Tropico Jazz.mp4"); // day 00
  no("04 Videos/11 November/1105 V72/../1105 V72/V72 Tropico Jazz.mp4");
  no("/Volumes/Samsung T9/YouTube/01 Tropico Jazz/04 Videos/11 November/1105 V72/V72 Tropico Jazz.mp4");
  no("04 Videos/11 November/1105 V72/V72 Tropico Jazz.mov");
  no("04 Videos/11 November/1105 V72/V72_release.json");
  no("04 Videos/11 November/1105 V72/Thumbnail_V72_A.jpg");
  no("04 Videos/11 November/1105 V72/sub/V72 Tropico Jazz.mp4");
  no("03 Images/11 November/1105 V72/V72 Tropico Jazz.mp4");
  no("01 Audio/V72 Tropico Jazz.mp4");
  no("06 Workflows/_data/loop-video-builder/jobs/2026-11-05 V72/render.mp4");
  no("04 Videos\\11 November\\1105 V72\\V72 Tropico Jazz.mp4");
  no(OK_PATH, "72");
  no(OK_PATH, "V72", "");
});

const upload: CleanupUploadFacts = { video: "V72", videoFile: OK_PATH, videoId: "fF-lZ2yR9aw", storedBytes: 3_519_496_568, totalBytes: 3_519_496_568 };
const file = { kind: "file" as const, bytes: 3_519_496_568, tombstone: null };
const local = (over: Partial<Parameters<typeof decideLocally>[0]> = {}) =>
  decideLocally({ upload, channelName: "Tropico Jazz", local: file, inLiveRotation: false, uploadActive: false, ...over });

test("AC-2 local: a complete upload of the allowed file goes on to YouTube's checks", () => {
  assert.equal(local(), null);
});

test("AC-2 local: each failing fact gives its own reason, none deletes", () => {
  assert.deepEqual(local({ upload: { ...upload, storedBytes: 1 } }), { action: "refuse", reason: "upload_incomplete" });
  assert.deepEqual(local({ upload: { ...upload, videoId: null } }), { action: "refuse", reason: "upload_incomplete" });
  assert.deepEqual(local({ upload: { ...upload, videoFile: "04 Videos/Live Segments/V72 Tropico Jazz.mp4" } }), { action: "refuse", reason: "path_not_allowed" });
  assert.deepEqual(local({ channelName: "Japan Countryside Music" }), { action: "refuse", reason: "path_not_allowed" });
  assert.deepEqual(local({ local: { kind: "unavailable" } }), { action: "wait", reason: "workspace_unavailable" });
  // ADR §3: the workspace not reachable WAITS -- also when its name (the channel's) could not be read: never a lasting refusal.
  assert.deepEqual(local({ local: { kind: "unavailable" }, channelName: "" }), { action: "wait", reason: "workspace_unavailable" });
  // An upload the runner finished with a problem is kept for the owner (review #6).
  assert.deepEqual(local({ upload: { ...upload, errorCode: "verify_mismatch" } }), { action: "wait", reason: "upload_problem" });
  assert.deepEqual(local({ local: { kind: "symlink" } }), { action: "refuse", reason: "symlink" });
  assert.deepEqual(local({ local: { kind: "not_a_file" } }), { action: "refuse", reason: "not_a_file" });
  assert.deepEqual(local({ local: { ...file, bytes: 3_519_496_567 } }), { action: "refuse", reason: "size_mismatch_upload" });
  assert.deepEqual(local({ inLiveRotation: true }), { action: "wait", reason: "in_live_rotation" });
  assert.deepEqual(local({ uploadActive: true }), { action: "wait", reason: "upload_active" });
});

const tombstone: VideoTombstone = {
  schema: "deleted-video/1",
  file: "V72 Tropico Jazz.mp4",
  bytes: 3_519_496_568,
  sha256: null,
  durationSec: 10800,
  youtubeVideoId: "fF-lZ2yR9aw",
  privacyStatus: "private",
  publishAt: "2026-11-05T15:00:00Z",
  deletedAt: "2026-11-05T10:00:00.000Z",
  deletedBy: "ytm-cleanup",
  tempDeleted: [],
};

test("AC-5: mp4 gone with our own tombstone is a recovered delete; gone otherwise is 'file_missing'; a tombstone next to the mp4 must match", () => {
  assert.deepEqual(local({ local: { kind: "missing", tombstone } }), { action: "recovered", bytes: 3_519_496_568 });
  assert.deepEqual(local({ local: { kind: "missing", tombstone: null } }), { action: "refuse", reason: "file_missing" });
  assert.deepEqual(local({ local: { kind: "missing", tombstone: { ...tombstone, deletedBy: "operator" } } }), { action: "refuse", reason: "file_missing" });
  assert.deepEqual(local({ local: { kind: "missing", tombstone: { ...tombstone, youtubeVideoId: "otherVideo1" } } }), { action: "refuse", reason: "file_missing" });
  assert.equal(local({ local: { ...file, tombstone } }), null);
  assert.deepEqual(local({ local: { ...file, tombstone: { ...tombstone, youtubeVideoId: "otherVideo1" } } }), { action: "refuse", reason: "tombstone_mismatch" });
  assert.deepEqual(local({ local: { ...file, tombstone: { ...tombstone, bytes: 1 } } }), { action: "refuse", reason: "tombstone_mismatch" });
});

const yt = (over: Partial<Extract<YoutubeVideoFacts, { kind: "ok" }>> = {}): YoutubeVideoFacts => ({
  kind: "ok",
  uploadStatus: "processed",
  processingStatus: "succeeded",
  privacyStatus: "public",
  publishAt: null,
  fileSize: 3_519_496_568,
  durationSeconds: 10800,
  ...over,
});
const onYt = (youtube: YoutubeVideoFacts) => decideOnYoutube({ localBytes: 3_519_496_568, youtube });

test("AC-2 YouTube: public or private with a date, processed, same size: delete", () => {
  assert.deepEqual(onYt(yt()), { action: "delete" });
  assert.deepEqual(onYt(yt({ privacyStatus: "private", publishAt: "2026-11-05T15:00:00Z" })), { action: "delete" });
  assert.deepEqual(onYt(yt({ processingStatus: null, uploadStatus: "processed" })), { action: "delete" });
  assert.deepEqual(onYt(yt({ fileSize: null })), { action: "delete" }, "without a size the duration decides (decideOnContent)");
});

test("AC-2 YouTube: waits and refusals", () => {
  assert.deepEqual(onYt({ kind: "unavailable" }), { action: "wait", reason: "youtube_unavailable" });
  assert.deepEqual(onYt({ kind: "missing" }), { action: "wait", reason: "video_not_on_youtube" });
  assert.deepEqual(onYt(yt({ uploadStatus: "uploaded", processingStatus: "processing" })), { action: "wait", reason: "processing" });
  assert.deepEqual(onYt(yt({ uploadStatus: "rejected", processingStatus: null })), { action: "refuse", reason: "youtube_rejected" });
  assert.deepEqual(onYt(yt({ uploadStatus: "failed", processingStatus: null })), { action: "refuse", reason: "youtube_rejected" });
  assert.deepEqual(onYt(yt({ uploadStatus: "uploaded", processingStatus: "failed" })), { action: "refuse", reason: "youtube_rejected" });
  assert.deepEqual(onYt(yt({ privacyStatus: "unlisted" })), { action: "wait", reason: "not_public_or_scheduled" });
  assert.deepEqual(onYt(yt({ privacyStatus: "private", publishAt: null })), { action: "wait", reason: "not_public_or_scheduled" });
  assert.deepEqual(onYt(yt({ fileSize: 3_519_496_569 })), { action: "refuse", reason: "size_mismatch_youtube" });
});

test("AC-2 content: the package's sha256 must match; without YouTube's size the duration within 2 s", () => {
  const base = { expectedSha256: null, actualSha256: null, youtubeFileSize: 5, youtubeDurationSeconds: 100, localDurationSeconds: 100 } as const;
  assert.deepEqual(decideOnContent(base), { action: "delete" });
  assert.deepEqual(decideOnContent({ ...base, expectedSha256: "AB", actualSha256: "ab" }), { action: "delete" });
  assert.deepEqual(decideOnContent({ ...base, expectedSha256: "ab", actualSha256: "cd" }), { action: "refuse", reason: "sha256_mismatch" });
  assert.deepEqual(decideOnContent({ ...base, expectedSha256: "ab", actualSha256: null }), { action: "wait", reason: "cannot_verify" });
  const noSize = { ...base, youtubeFileSize: null };
  assert.deepEqual(decideOnContent({ ...noSize, localDurationSeconds: 102 }), { action: "delete" });
  assert.deepEqual(decideOnContent({ ...noSize, localDurationSeconds: 97.5 }), { action: "refuse", reason: "duration_mismatch" });
  assert.deepEqual(decideOnContent({ ...noSize, localDurationSeconds: "no_ffprobe" }), { action: "wait", reason: "cannot_verify" });
  assert.deepEqual(decideOnContent({ ...noSize, youtubeDurationSeconds: null }), { action: "wait", reason: "cannot_verify" });
});

test("YouTube's ISO 8601 durations", () => {
  assert.equal(isoDurationSeconds("PT3H0M12S"), 10812);
  assert.equal(isoDurationSeconds("PT2M"), 120);
  assert.equal(isoDurationSeconds("P1DT1S"), 86401);
  assert.equal(isoDurationSeconds("PT"), null);
  assert.equal(isoDurationSeconds("3h"), null);
  assert.equal(isoDurationSeconds(null), null);
});
