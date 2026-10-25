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
