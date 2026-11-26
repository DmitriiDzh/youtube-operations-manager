import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import { createPackageCategory, PACKAGE_CATEGORY_QUOTA_UNITS_PER_VIDEO, type PackageCategoryDeps } from "./package-category";
import type { PackageMetadataActor } from "./package-metadata";
import { DEFAULT_PUBLISHING_SETTINGS } from "./settings";
import type { PublishingSettingsView } from "./settings-service";
import type { ReadVideoFields, UploadedPackageVideo } from "./video-publishing-check";

// BL-279 (owner TG 4963/4964; ADR 0072 amendment 2; docs/WRITE_AUTHORIZATIONS.md «Package metadata after upload», amended): the category
// of a video a release package of the channel put on YouTube, set only to the channel's SAVED `categoryId`. Requirements (by hand from
// the owner's words and the amendment): only package-uploaded videos (a foreign id is refused before any read); the category itself must
// be saved (else publishing_settings_not_saved, nothing read or written); a video already in that category is not written; the write is
// video-details' with the fresh etag, the untouched snippet/status fields verified unchanged (title, description, tags, both languages,
// privacy, publishAt -- never categoryId) and the translation languages read before and after; a read-back mismatch, Live writes off or a
// wrong channel is a failure that stops the run; the dry run reads and writes nothing; the owner binds the apply to the category shown.

const CH = "UC_wwe";
const OWNER: PackageMetadataActor = { kind: "owner", userId: "u-owner" };
const PRODUCER: PackageMetadataActor = { kind: "producer" };

const pkgVideo = (video: string, videoId: string): UploadedPackageVideo => ({ video, videoId, defaultLanguage: "en", defaultAudioLanguage: "en", containsSyntheticMedia: null, hasCaptions: false });
const view = (over: Partial<PublishingSettingsView> = {}): PublishingSettingsView => ({
  channelId: CH,
  settings: { ...DEFAULT_PUBLISHING_SETTINGS, categoryId: "27", captionsEnabled: true },
  defaults: DEFAULT_PUBLISHING_SETTINGS,
  saved: ["captionsEnabled", "categoryId"],
  conflictedFields: [],
  ...over,
});
const snap = (videoId: string, over: Partial<VideoDetailsSnapshot> = {}): VideoDetailsSnapshot => ({
  videoId,
  etag: `etag-${videoId}`,
  channelId: CH,
  title: "T",
  description: "D",
  tags: ["wwe"],
  categoryId: "10",
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  privacyStatus: "public",
  publishAt: null,
  license: "youtube",
  embeddable: true,
  publicStatsViewable: true,
  selfDeclaredMadeForKids: false,
  containsSyntheticMedia: true,
  recordingDate: null,
  ...over,
});
const fields = (categoryId: string | null, channelId: string = CH): ReadVideoFields => ({
  channelId,
  title: "T",
  categoryId,
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  privacyStatus: "public",
  license: "youtube",
  selfDeclaredMadeForKids: false,
  madeForKids: false,
  embeddable: true,
  containsSyntheticMedia: true,
  hasPaidProductPlacement: false,
});

function harness(over: Partial<PackageCategoryDeps> = {}, snapshots: Record<string, VideoDetailsSnapshot | "not_found"> = {}) {
  const calls = { applied: [] as Array<Parameters<PackageCategoryDeps["applyFields"]>[0]>, reads: 0, snapshots: 0, audits: [] as Array<{ eventType: string; detail: Record<string, unknown> }>, device: 0 };
  const videos = [pkgVideo("V1", "vidA"), pkgVideo("V2", "vidB"), pkgVideo("S3", "vidC")];
  const deps: PackageCategoryDeps = {
    settings: async () => view(),
    uploadedVideos: async () => videos,
    uploadRows: async () => [],
    assertDeviceAvailable: async () => {
      calls.device += 1;
    },
    credentialRef: async () => ({ userId: "u-owner" }),
    readVideos: async ({ videoIds }) => {
      calls.reads += 1;
      return new Map(videoIds.map((id) => [id, fields(id === "vidB" ? "27" : "10")]));
    },
    snapshot: async ({ videoId }) => {
      calls.snapshots += 1;
      return snapshots[videoId] ?? snap(videoId, { categoryId: videoId === "vidB" ? "27" : "10" });
    },
    localizationLanguages: async () => ["de", "ja"],
    applyFields: async (args) => {
      calls.applied.push(args);
      return { dryRun: false, videoId: args.videoId, before: snap(args.videoId), after: snap(args.videoId, { categoryId: "27" }), verified: true, backupPath: `/b/${args.videoId}.json` };
    },
    audit: async (event) => {
      calls.audits.push({ eventType: event.eventType, detail: event.detail });
    },
    ...over,
  };
  return { svc: createPackageCategory(deps), calls };
}

const refused = (code: string) => (error: unknown) => isDomainError(error) && error.code === code;

test("BL-279: the dry run lists every package-uploaded video with its category now and what would be written -- nothing is written", async () => {
  const h = harness();
  const preview = await h.svc.preview(CH, OWNER);
  assert.equal(preview.targetCategoryId, "27");
  assert.deepEqual(
    preview.videos.map((v) => [v.video, v.current, v.status]),
    [
      ["V1", "10", "write"],
      ["V2", "27", "same"],
      ["S3", "10", "write"],
    ]
  );
  assert.equal(preview.toWrite, 2);
  // By hand: one batch read of 3 ids (1 unit) + 2 writes × 55.
  assert.equal(preview.quotaUnits, 1 + 2 * PACKAGE_CATEGORY_QUOTA_UNITS_PER_VIDEO);
  assert.equal(h.calls.applied.length, 0);
  assert.deepEqual(h.calls.audits.map((a) => a.eventType), ["DRY_RUN"]);
});

test("BL-279: the apply writes only the saved category, through video-details with the fresh etag, verifying every other field unchanged", async () => {
  const h = harness();
  const result = await h.svc.apply(CH, { expectedCategoryId: "27" }, OWNER);
  assert.deepEqual(result.written, ["vidA", "vidC"]);
  assert.equal(result.verified, true);
  assert.deepEqual(result.videos.find((v) => v.videoId === "vidB")?.status, "same", "a video already in the saved category is not written");
  assert.equal(h.calls.applied.length, 2);
  const first = h.calls.applied[0];
  assert.deepEqual(first.patch, { categoryId: "27" }, "only the category, never free text, never another field");
  assert.equal(first.expectedChannelId, CH);
  assert.equal(first.expectedEtag, "etag-vidA");
  assert.deepEqual([...first.verifyUnchanged].sort(), ["defaultAudioLanguage", "defaultLanguage", "description", "privacyStatus", "publishAt", "tags", "title"]);
  assert.equal(first.auditContext.source, "package_category");
  assert.equal(result.videos[0].backupPath, "/b/vidA.json");
  assert.ok(h.calls.audits.some((a) => a.eventType === "VERIFICATION" && a.detail.event === "package_category.applied" && a.detail.verified === true));
});

test("BL-279: a channel whose category was never saved is refused before any read or write -- even when other fields were saved", async () => {
  for (const saved of [[], ["channelTags", "playlistId"]] as const) {
    const h = harness({ settings: async () => view({ settings: DEFAULT_PUBLISHING_SETTINGS, saved: [...saved] }) });
    await assert.rejects(h.svc.preview(CH, OWNER), refused("publishing_settings_not_saved"));
    await assert.rejects(h.svc.apply(CH, { expectedCategoryId: "10" }, OWNER), refused("publishing_settings_not_saved"));
    assert.equal(h.calls.reads + h.calls.snapshots + h.calls.applied.length, 0);
  }
});

test("BL-279: a category in conflict between the computers, or saved differently since the preview, refuses the whole call", async () => {
  const conflicted = harness({ settings: async () => view({ conflictedFields: ["categoryId"] }) });
  await assert.rejects(conflicted.svc.apply(CH, { expectedCategoryId: "27" }, OWNER), refused("publishing_settings_changed"));
  const changed = harness();
  await assert.rejects(changed.svc.apply(CH, { expectedCategoryId: "10" }, OWNER), refused("publishing_settings_changed"));
  assert.equal(changed.calls.applied.length, 0);
  const owner = harness();
  await assert.rejects(owner.svc.apply(CH, {}, OWNER), refused("validation_failed"), "the owner applies what the preview showed");
});

test("BL-279: a video no release package of the channel uploaded is refused before anything is read", async () => {
  const h = harness();
  await assert.rejects(h.svc.apply(CH, { expectedCategoryId: "27", videoIds: ["vidA", "studioVideo"] }, PRODUCER), (error: unknown) =>
    isDomainError(error) && error.code === "package_metadata_not_uploaded" && JSON.stringify((error.details as { videoIds: string[] }).videoIds) === JSON.stringify(["studioVideo"])
  );
  assert.equal(h.calls.snapshots + h.calls.applied.length, 0);
});

test("BL-279: a category equal to the setting already writes nothing (no backup, no write)", async () => {
  const h = harness({}, { vidA: snap("vidA", { categoryId: "27" }) });
  const result = await h.svc.apply(CH, { videoIds: ["vidA"] }, PRODUCER);
  assert.deepEqual(result.written, []);
  assert.equal(result.videos[0].status, "same");
  assert.equal(h.calls.applied.length, 0);
});

test("BL-279: a video on another channel or gone from YouTube is not written", async () => {
  const h = harness({}, { vidA: snap("vidA", { channelId: "UC_other" }), vidC: "not_found" });
  const result = await h.svc.apply(CH, { expectedCategoryId: "27" }, OWNER);
  assert.deepEqual(result.videos.map((v) => v.status), ["not_in_channel", "same", "not_on_youtube"]);
  assert.equal(h.calls.applied.length, 0);
});

test("BL-279: an upload of the video still running on this computer is skipped, never written", async () => {
  const h = harness({ uploadRows: async () => [{ status: "processing", video: "V1", videoId: "vidA" }] });
  const result = await h.svc.apply(CH, { expectedCategoryId: "27" }, OWNER);
  assert.equal(result.videos[0].status, "upload_pending");
  assert.deepEqual(result.written, ["vidC"]);
});

test("BL-279: Live writes off (or a wrong channel) on the first video refuses with that code, nothing written, the rest not tried", async () => {
  for (const code of ["live_writes_disabled", "WRITE_CHANNEL_MISMATCH"] as const) {
    const h = harness({
      applyFields: async () => {
        throw new DomainError({ code, message: code });
      },
    });
    await assert.rejects(h.svc.apply(CH, { expectedCategoryId: "27" }, OWNER), refused(code));
    assert.equal(h.calls.snapshots, 1, "the run stops at the first failure");
  }
});

test("BL-279: a read-back mismatch after a write stops the run and reports it, keeping what was written before", async () => {
  let n = 0;
  const h = harness({
    applyFields: async (args) => {
      n += 1;
      if (n === 2) throw new DomainError({ code: "update_failed", message: "Post-write verification found a field that was not written changed: title" });
      return { dryRun: false, videoId: args.videoId, before: snap(args.videoId), after: snap(args.videoId, { categoryId: "27" }), verified: true, backupPath: "/b" };
    },
  });
  const result = await h.svc.apply(CH, { expectedCategoryId: "27" }, OWNER);
  assert.deepEqual(result.written, ["vidA"]);
  assert.equal(result.verified, false);
  assert.equal(result.stoppedAt, "vidC");
  assert.equal(result.videos.at(-1)?.error?.code, "update_failed");
});

test("BL-279: translation languages that differ after the write are a failure (update_failed), never a silent success", async () => {
  let calls = 0;
  const h = harness({ localizationLanguages: async () => (++calls % 2 === 1 ? ["de", "ja"] : ["de"]) });
  const result = await h.svc.apply(CH, { expectedCategoryId: "27", videoIds: ["vidA"] }, OWNER);
  assert.equal(result.verified, false);
  assert.equal(result.videos[0].status, "failed");
  assert.equal(result.videos[0].error?.code, "update_failed");
  assert.equal(result.videos[0].backupPath, "/b/vidA.json", "the write went through: its backup is reported, not hidden behind an error");
});

test("BL-279: a read-back mismatch on the only video is returned as that video's failure (the write may have been sent), not thrown", async () => {
  const h = harness({
    applyFields: async () => {
      throw new DomainError({ code: "update_failed", message: "Post-write verification found at least one field did not match what was sent" });
    },
  });
  const result = await h.svc.apply(CH, { videoIds: ["vidA"] }, PRODUCER);
  assert.deepEqual([result.verified, result.stoppedAt, result.videos[0].error?.code], [false, "vidA", "update_failed"]);
});

test("BL-279: an audio language read as zxx is not compared after the write (it is left out of the snippet, RISK-102)", async () => {
  const h = harness({}, { vidA: snap("vidA", { defaultAudioLanguage: "zxx" }) });
  await h.svc.apply(CH, { videoIds: ["vidA"] }, PRODUCER);
  assert.equal(h.calls.applied[0].verifyUnchanged.includes("defaultAudioLanguage"), false);
  assert.equal(h.calls.applied[0].verifyUnchanged.includes("title"), true);
});
