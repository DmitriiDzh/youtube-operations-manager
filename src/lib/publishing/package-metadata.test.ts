import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import { createPackageMetadata, PACKAGE_METADATA_QUOTA_UNITS, type PackageMetadataActor, type PackageMetadataDeps, type PackageMetadataUploadRow } from "./package-metadata";
import type { ReleasePackage } from "./packages";

// BL-265 (MEDIA_GATE_PLAN.md §3.4, AC-MG-22..37; ADR 0072 §5, §7; AGENTS.md §F «Package metadata after upload»). Expected values are
// written from the plan: the patch is the manifest's title / description / tags (never free text), only the fields that differ; the
// three-way rule (YouTube now a, what the upload sent b, the manifest c): a = c nothing, a = b != c write c, otherwise CONFLICT --
// written only on the owner's per-field override, refused for the Producer; an unknown b makes every difference a conflict; the
// write goes through video-details with the preview's etag, the untouched fields verified unchanged and the localization languages
// read before and after; refusals before any backup or write.

const CH = "UC_wwe";
const VIDEO_ID = "vid61";
const OWNER: PackageMetadataActor = { kind: "owner", userId: "u-owner" };
const PRODUCER: PackageMetadataActor = { kind: "producer" };

const manifest = (over: Partial<ReleasePackage> = {}): ReleasePackage => ({
  channelId: CH,
  video: "V61",
  mix: null,
  plannedPublishDate: "2026-11-20",
  files: { video: "V61.mp4", thumbnail: "Thumbnail_V61.jpg" },
  sizeBytes: 1000,
  durationSeconds: 60,
  title: "New title",
  description: "New description\r\n",
  tags: ["wwe", "new"],
  defaultLanguage: "ja",
  defaultAudioLanguage: "ja",
  ready: true,
  problems: [],
  sha256: "e".repeat(64),
  ...over,
});

const snapshot = (over: Partial<VideoDetailsSnapshot> = {}): VideoDetailsSnapshot => ({
  videoId: VIDEO_ID,
  etag: "etag-1",
  channelId: CH,
  title: "Old title",
  description: "Old description",
  tags: ["old", "wwe"],
  categoryId: "10",
  defaultLanguage: "ja",
  defaultAudioLanguage: "ja",
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

/** The finished upload row of V61 here: what the upload sent (b). */
const doneRow = (texts: { title: string; description: string; tags: string[] } = { title: "Old title", description: "Old description", tags: ["wwe", "old"] }): PackageMetadataUploadRow => ({
  status: "done",
  videoId: VIDEO_ID,
  packageJson: JSON.stringify({ ...texts, thumbnailFile: "04 Videos/11 November/1120 V61/Thumbnail_V61.jpg" }),
  finishedAt: new Date("2026-11-10T10:00:00Z"),
});

function harness(options: {
  pkg?: ReleasePackage;
  now?: VideoDetailsSnapshot | "not_found";
  rows?: PackageMetadataUploadRow[];
  videoId?: string | null;
  channelTags?: string[];
  device?: () => Promise<void>;
  applyFails?: Error;
  languages?: Array<string[] | null>;
} = {}) {
  const calls: string[] = [];
  const applied: Array<Parameters<PackageMetadataDeps["applyFields"]>[0]> = [];
  const audits: Array<{ eventType: string; detail: Record<string, unknown> }> = [];
  const languages = [...(options.languages ?? [["de", "en"], ["de", "en"]])];
  const deps: PackageMetadataDeps = {
    findPackage: async (channelId, video) =>
      channelId === CH && video === "V61"
        ? { pkg: options.pkg ?? manifest(), manifestSha256: "m".repeat(64), manifestPath: "04 Videos/11 November/1120 V61/V61_release.json", folder: "04 Videos/11 November/1120 V61", videoId: options.videoId === undefined ? VIDEO_ID : options.videoId, thumbnailPath: "04 Videos/11 November/1120 V61/Thumbnail_V61.jpg" }
        : "not_found",
    channelTags: async () => options.channelTags ?? [],
    uploadRows: async () => options.rows ?? [doneRow()],
    lastApplied: async () => null,
    lastThumbnailSha256: async () => null,
    fileSha256: async () => "t".repeat(64),
    assertDeviceAvailable: async () => {
      calls.push("device");
      if (options.device) await options.device();
    },
    credentialRef: async (_c, actor) => ({ userId: actor.kind === "owner" ? actor.userId : "u-connected" }),
    snapshot: async () => {
      calls.push("read");
      return options.now ?? snapshot();
    },
    localizationLanguages: async () => {
      calls.push("languages");
      return languages.shift() ?? null;
    },
    applyFields: async (args) => {
      calls.push("write");
      if (options.applyFails) throw options.applyFails;
      applied.push(args);
      return { dryRun: false, videoId: args.videoId, before: snapshot(), after: snapshot(), verified: true, backupPath: "/backups/v61.json" };
    },
    audit: async ({ eventType, detail }) => void audits.push({ eventType, detail }),
  };
  return { service: createPackageMetadata(deps), calls, applied, audits };
}

const refusedWith = (code: string) => (error: unknown) => isDomainError(error) && error.code === code;

test("AC-MG-22: the preview makes every read and check, no backup and no write; it returns the diff and 54 quota units", async () => {
  const h = harness();
  const preview = await h.service.preview(CH, { video: "V61" }, OWNER);
  assert.deepEqual(h.applied, []);
  assert.equal(h.calls.includes("write"), false);
  assert.equal(preview.quotaUnits, 54);
  assert.equal(PACKAGE_METADATA_QUOTA_UNITS, 1 + 50 + 1 + 2);
  assert.deepEqual(preview.fields.map((f) => [f.field, f.status]), [["title", "write"], ["description", "write"], ["tags", "write"]]);
  assert.equal(preview.etag, "etag-1");
  assert.equal(preview.baseline, "upload_row");
  assert.deepEqual(h.audits.map((a) => [a.eventType, a.detail.source]), [["DRY_RUN", "package_metadata"]]);
});

test("AC-MG-26: success -- only the manifest's title/description/tags (description as YouTube keeps it), the preview's etag, untouched fields verified, the localization set read before and after, audited", async () => {
  const h = harness();
  const result = await h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER);
  assert.deepEqual(h.applied.length, 1);
  const call = h.applied[0];
  assert.deepEqual(call.patch, { title: "New title", description: "New description", tags: ["wwe", "new"] });
  assert.equal("localizations" in call.patch || "privacyStatus" in call.patch || "publishAt" in call.patch, false);
  assert.equal(call.expectedEtag, "etag-1");
  assert.equal(call.expectedChannelId, CH);
  assert.deepEqual(call.verifyUnchanged, ["categoryId", "defaultLanguage", "defaultAudioLanguage", "privacyStatus", "publishAt"]);
  assert.deepEqual([call.auditContext.source, call.auditContext.actor], ["package_metadata", "owner"]);
  assert.deepEqual(h.calls, ["device", "read", "languages", "write", "languages"]);
  assert.deepEqual([result.changed, result.verified, result.written, result.backupPath], [true, true, ["title", "description", "tags"], "/backups/v61.json"]);
  const applied = h.audits.find((a) => a.detail.event === "package_metadata.applied");
  assert.deepEqual(applied?.detail.afterTexts, { title: "New title", description: "New description", tags: ["wwe", "new"] });
});

test("AC-MG-23: a wrong channel identity in the write path (video-details' assertWriteChannel) -> the error, nothing written", async () => {
  const h = harness({ applyFails: new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "wrong channel" }) });
  await assert.rejects(h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER), refusedWith("WRITE_CHANNEL_MISMATCH"));
  assert.deepEqual(h.applied, []);
  assert.equal(h.audits.some((a) => a.detail.event === "package_metadata.applied"), false);
});

test("AC-MG-24 (service): Live writes off -> video-details refuses before its write; the error is returned, nothing recorded as applied", async () => {
  const h = harness({ applyFails: new DomainError({ code: "live_writes_disabled", message: "off" }) });
  await assert.rejects(h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER), refusedWith("live_writes_disabled"));
  assert.deepEqual(h.applied, []);
});

test("AC-MG-25: no such video on YouTube -> video_missing; another channel's video -> video_not_in_channel; nothing written", async () => {
  const missing = harness({ now: "not_found" });
  await assert.rejects(missing.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER), refusedWith("video_missing"));
  const foreign = harness({ now: snapshot({ channelId: "UC_other" }) });
  await assert.rejects(foreign.service.preview(CH, { video: "V61" }, OWNER), refusedWith("video_not_in_channel"));
  assert.deepEqual([...missing.calls, ...foreign.calls].filter((c) => c === "write"), []);
});

test("AC-MG-27: YouTube's audio language zxx -> stated in the result and not verified afterwards (it is left out of the write, RISK-102)", async () => {
  const h = harness({ now: snapshot({ defaultAudioLanguage: "zxx" }) });
  const result = await h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER);
  assert.equal(result.audioLanguageLeftOut, true);
  assert.deepEqual(h.applied[0].verifyUnchanged, ["categoryId", "defaultLanguage", "privacyStatus", "publishAt"]);
});

test("AC-MG-28: the read-back finds an untouched field changed (video-details throws update_failed) -> never a success", async () => {
  const h = harness({ applyFails: new DomainError({ code: "update_failed", message: "changed: defaultLanguage", details: { changedUntouched: ["defaultLanguage"] } }) });
  await assert.rejects(h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER), (error: unknown) => isDomainError(error) && error.code === "update_failed" && JSON.stringify(error.details).includes("defaultLanguage"));
});

test("ADR 0072 §5: the localization languages changed across the write -> update_failed (audited verified: false), never a success", async () => {
  const h = harness({ languages: [["de", "en"], ["en"]] });
  await assert.rejects(h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER), refusedWith("update_failed"));
  const verification = h.audits.find((a) => a.detail.event === "package_metadata.applied");
  assert.equal(verification?.detail.verified, false);
});

test("AC-MG-29: YouTube's title differs from both the uploaded and the manifest title -> CONFLICT; not written without the owner's override; the Producer is refused", async () => {
  const changedInStudio = snapshot({ title: "Studio title" });
  const h = harness({ now: changedInStudio });
  const preview = await h.service.preview(CH, { video: "V61" }, OWNER);
  assert.equal(preview.fields.find((f) => f.field === "title")?.status, "conflict");
  const plain = await h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER);
  assert.deepEqual([plain.written, plain.skippedConflicts], [["description", "tags"], ["title"]]);
  assert.equal("title" in h.applied[0].patch, false);
  const overridden = harness({ now: changedInStudio });
  const forced = await overridden.service.apply(CH, { video: "V61", expectedEtag: "etag-1", overwrite: ["title"] }, OWNER);
  assert.deepEqual(forced.written, ["title", "description", "tags"]);
  assert.equal(overridden.applied[0].patch.title, "New title");
  const producer = harness({ now: changedInStudio });
  await assert.rejects(producer.service.apply(CH, { video: "V61", overwrite: ["title"] }, PRODUCER), refusedWith("package_metadata_conflict"));
  assert.deepEqual(producer.applied, []);
});

test("AC-MG-30: the etag changed between preview and apply -> video-details' video_details_conflict, no write", async () => {
  const h = harness({ applyFails: new DomainError({ code: "video_details_conflict", message: "changed" }) });
  await assert.rejects(h.service.apply(CH, { video: "V61", expectedEtag: "etag-0" }, OWNER), refusedWith("video_details_conflict"));
  assert.deepEqual(h.applied, []);
  // the owner must name the etag his preview showed
  await assert.rejects(harness().service.apply(CH, { video: "V61" }, OWNER), refusedWith("validation_failed"));
});

test("AC-MG-31: an upload row of that video here that has not finished its read-back -> upload_steps_pending, no read, no write", async () => {
  for (const status of ["queued", "uploading", "processing", "finishing", "paused"]) {
    const h = harness({ rows: [{ ...doneRow(), status, videoId: status === "finishing" ? VIDEO_ID : null }] });
    await assert.rejects(h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER), refusedWith("upload_steps_pending"), status);
    assert.deepEqual(h.calls, [], status);
  }
});

test("AC-MG-32: a device handoff (operation lock) or recovery mode -> refused before any read, backup or write", async () => {
  for (const code of ["operation_lock_held", "device_in_recovery_mode"]) {
    const h = harness({ device: async () => Promise.reject(Object.assign(new Error(code), { code })) });
    await assert.rejects(h.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER), (error: unknown) => (error as { code?: string }).code === code);
    assert.deepEqual(h.calls, ["device"]);
  }
});

test("AC-MG-33: a field equal on YouTube and in the manifest is not in the patch; all three equal -> nothing written, changed: false", async () => {
  const partly = harness({ now: snapshot({ title: "New title" }) });
  const result = await partly.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER);
  assert.deepEqual(Object.keys(partly.applied[0].patch), ["description", "tags"]);
  assert.deepEqual(result.written, ["description", "tags"]);
  const same = harness({ now: snapshot({ title: "New title", description: "New description", tags: ["new", "wwe"] }) });
  const nothing = await same.service.apply(CH, { video: "V61", expectedEtag: "etag-1" }, OWNER);
  assert.deepEqual([nothing.changed, nothing.written, same.applied.length], [false, [], 0]);
  assert.equal(same.calls.includes("write"), false);
});

test("AC-MG-34 (service): the Producer -- dry run writes nothing; no conflict -> applied with its own fresh etag, audited actor producer; wrong channel, Live writes off and a missing video refused like the owner's", async () => {
  const dry = harness();
  await dry.service.preview(CH, { video: "V61" }, PRODUCER);
  assert.deepEqual(dry.applied, []);
  const h = harness();
  const result = await h.service.apply(CH, { video: "V61" }, PRODUCER);
  assert.equal(result.changed, true);
  assert.deepEqual([h.applied[0].expectedEtag, h.applied[0].auditContext.actor, h.applied[0].credentialRef.userId], ["etag-1", "producer", "u-connected"]);
  await assert.rejects(harness({ applyFails: new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "x" }) }).service.apply(CH, { video: "V61" }, PRODUCER), refusedWith("WRITE_CHANNEL_MISMATCH"));
  await assert.rejects(harness({ applyFails: new DomainError({ code: "live_writes_disabled", message: "x" }) }).service.apply(CH, { video: "V61" }, PRODUCER), refusedWith("live_writes_disabled"));
  await assert.rejects(harness({ now: "not_found" }).service.apply(CH, { video: "V61" }, PRODUCER), refusedWith("video_missing"));
});

test("AC-MG-36: YouTube's description = manifest + \\n\\n or with CRLF, tags in another order -> no patch field, no conflict", async () => {
  const h = harness({ now: snapshot({ title: "New title", description: "New description\n\n", tags: ["new", "wwe"] }) });
  const preview = await h.service.preview(CH, { video: "V61" }, OWNER);
  assert.deepEqual(preview.fields.map((f) => f.status), ["same", "same", "same"]);
  assert.equal(preview.changed, false);
});

test("AC-MG-37: the upload ran on the other computer (no row, no earlier fix here) and YouTube's title != the manifest's -> CONFLICT; the Producer is refused", async () => {
  const h = harness({ rows: [] });
  const preview = await h.service.preview(CH, { video: "V61" }, OWNER);
  assert.equal(preview.baseline, "unknown");
  assert.deepEqual(preview.fields.map((f) => f.status), ["conflict", "conflict", "conflict"]);
  await assert.rejects(harness({ rows: [] }).service.apply(CH, { video: "V61" }, PRODUCER), refusedWith("package_metadata_conflict"));
});

test("the patch is never free text and the texts must pass YouTube's limits; a package not uploaded is refused; no tags of its own -> the channel's tags (as uploaded)", async () => {
  await assert.rejects(harness({ pkg: manifest({ title: "x".repeat(101) }) }).service.preview(CH, { video: "V61" }, OWNER), refusedWith("package_metadata_invalid"));
  await assert.rejects(harness({ videoId: null }).service.preview(CH, { video: "V61" }, OWNER), refusedWith("package_metadata_not_uploaded"));
  await assert.rejects(harness().service.preview(CH, { video: "V99" }, OWNER), refusedWith("upload_package_not_ready"));
  // A package without tags uploaded the channel's tags; YouTube still has them -> tags are "same", never cleared.
  const h = harness({ pkg: manifest({ tags: [] }), channelTags: ["wwe", "old"] });
  const preview = await h.service.preview(CH, { video: "V61" }, OWNER);
  assert.equal(preview.fields.find((f) => f.field === "tags")?.status, "same");
  // free text in the input is ignored: only the manifest's values are ever sent
  const free = harness();
  await free.service.apply(CH, { video: "V61", expectedEtag: "etag-1", title: "Injected" } as never, OWNER);
  assert.equal(free.applied[0].patch.title, "New title");
});
