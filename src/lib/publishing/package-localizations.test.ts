import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { createLiveLocalizationsWriter } from "@/lib/shared-video-localizations/services";
import type { VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import {
  createPackageLocalizations,
  expectedSnippetOf,
  localizationBaselineOf,
  PACKAGE_LOCALIZATIONS_QUOTA_UNITS,
  type AuditEventLike,
  type LocalizationBaseline,
  type PackageLocalizationsDeps,
} from "./package-localizations";
import { withPackageVideoLock } from "./package-metadata";
import type { PackageMetadataActor, PackageMetadataUploadRow } from "./package-metadata";
import type { ReleasePackage } from "./packages";

// Package localizations after upload (owner TG 4839/4842, 2026-11-24; ADR 0072 amendment; AGENTS.md §F «Package metadata after
// upload»). Every expected value is written by hand from the requirement, before looking at a run:
//   - source: only the package's current manifest `localizations`; never the video's own default language (YouTube's);
//   - per language and field, three-way: YouTube now Y / what the upload sent U / the package P --
//       Y = P same; U known and Y = U (absent = absent included) write; otherwise conflict;
//       U is known from this computer's finished upload row whose translations step read back `verified` (its frozen set; a
//       language not in it was not sent), `none` (nothing sent), or the latest verified fix here; anything else unknown;
//   - any conflict refuses the whole call (owner and Producer), nothing read-backed up or written;
//   - a language YouTube has that the package lacks is kept exactly; the snippet, privacy and publishAt never change;
//   - dryRun: every read, nothing written; Live writes off, a wrong channel, an unfinished upload: refused before any write;
//   - a read-back that differs is reported (update_failed).
// The write path runs the REAL shared translations writer over a fake YouTube, so the merge and the read-back are the production ones.

const CH = "UC_japan";
const VIDEO_ID = "vidJ25";
const OWNER: PackageMetadataActor = { kind: "owner", userId: "u-owner" };
const PRODUCER: PackageMetadataActor = { kind: "producer" };
const M = "m".repeat(64);

type Entry = { title: string; description: string };
type Video = {
  channelId: string;
  snippet: { title: string; description: string; defaultLanguage: string | null; defaultAudioLanguage: string | null; tags: string[]; categoryId: string };
  localizations: Record<string, Entry>;
  privacyStatus: string;
  publishAt: string | null;
  version: number;
};

const UPLOADED_JA: Entry = { title: "ジャズ A", description: "説明 A" };
const UPLOADED_DE: Entry = { title: "Jazz A", description: "Beschreibung A" };
const PACKAGE_JA: Entry = { title: "ジャズ B", description: "説明 B" };

const baseVideo = (): Video => ({
  channelId: CH,
  snippet: { title: "Jazz A (en)", description: "Desc A", defaultLanguage: "en", defaultAudioLanguage: "zxx", tags: ["jazz"], categoryId: "10" },
  // ja and de as the upload sent them; fr added later by someone else (the package has no fr). YouTube also returns the default
  // language's own entry (en) inside `localizations`: it is the snippet, never a translation, never "kept" or written.
  localizations: { en: { title: "Jazz A (en)", description: "Desc A" }, ja: { ...UPLOADED_JA }, de: { ...UPLOADED_DE }, fr: { title: "Jazz FR", description: "Desc FR" } },
  privacyStatus: "private",
  publishAt: "2026-11-25T13:00:00Z",
  version: 1,
});

const manifest = (localizations: Record<string, Entry> | null, over: Partial<ReleasePackage> = {}): ReleasePackage => ({
  channelId: CH,
  video: "V25",
  mix: null,
  plannedPublishDate: "2026-11-25",
  files: { video: "V25.mp4", thumbnail: "Thumbnail_V25.jpg" },
  sizeBytes: 1000,
  durationSeconds: 60,
  title: "Jazz A (en)",
  description: "Desc A",
  tags: ["jazz"],
  defaultLanguage: "en",
  defaultAudioLanguage: "zxx",
  ready: true,
  problems: [],
  sha256: "e".repeat(64),
  schemaVersion: 2,
  localizations,
  ...over,
});

/** This computer's finished upload row of V25: its frozen translations and the translations step's outcome. */
const doneRow = (sent: Record<string, Entry> | null, step: string): PackageMetadataUploadRow => ({
  status: "done",
  videoId: VIDEO_ID,
  packageJson: JSON.stringify({ title: "Jazz A (en)", description: "Desc A", tags: ["jazz"], ...(sent ? { localizations: sent } : {}) }),
  finishedAt: new Date("2026-11-20T10:00:00Z"),
  stepsJson: JSON.stringify({ localizations: step }),
});

function harness(options: {
  video?: Video;
  pkg?: ReleasePackage;
  rows?: PackageMetadataUploadRow[];
  liveWrites?: boolean;
  wrongWriteChannel?: boolean;
  /** What YouTube stores for the update instead of the payload (a read-back mismatch). */
  storeInstead?: (payload: { localizations: Record<string, Entry> }, video: Video) => void;
  /** A change on YouTube right before the writer's n-th read (1 = its first). */
  changeBeforeWriterRead?: { read: number; change: (video: Video) => void };
  /** A change to the status right after the update (the status read-back). */
  afterUpdate?: (video: Video) => void;
  /** Audit rows already on this computer (oldest first), before the harness's own. */
  events?: AuditEventLike[];
  /** The first n writer reads (and, with `snapshotLags`, the snapshot) come from a lagging replica showing this older snippet text. */
  lagging?: { reads: number; title: string; description?: string; snapshotLags?: boolean };
} = {}) {
  const video = options.video ?? baseVideo();
  const calls: string[] = [];
  const updates: Array<{ snippet: Record<string, unknown>; localizations: Record<string, Entry> }> = [];
  const audits: Array<{ channelId: string; eventType: string; detail: Record<string, unknown>; occurredAt: Date }> = (options.events ?? []).map((e) => ({
    channelId: e.channelId,
    eventType: e.eventType,
    detail: e.detail as Record<string, unknown>,
    occurredAt: e.occurredAt ?? new Date(),
  }));
  let lagReads = options.lagging?.reads ?? 0;
  let writerReads = 0;

  const snapshotOf = (): VideoDetailsSnapshot => ({
    videoId: VIDEO_ID,
    etag: `etag-${video.version}`,
    channelId: video.channelId,
    title: options.lagging?.snapshotLags ? options.lagging.title : video.snippet.title,
    description: options.lagging?.snapshotLags ? (options.lagging.description ?? video.snippet.description) : video.snippet.description,
    tags: [...video.snippet.tags],
    categoryId: video.snippet.categoryId,
    defaultLanguage: video.snippet.defaultLanguage,
    defaultAudioLanguage: video.snippet.defaultAudioLanguage,
    privacyStatus: video.privacyStatus as VideoDetailsSnapshot["privacyStatus"],
    publishAt: video.publishAt,
    license: "youtube",
    embeddable: true,
    publicStatsViewable: true,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
    recordingDate: null,
  });

  const writer = createLiveLocalizationsWriter({
    auth: { resolve: async () => ({ credentialRef: { userId: "u" }, accessToken: "t", scopeSet: new Set() }) as never },
    writeContext: {
      assertWriteChannel: async ({ expectedChannelId }) => {
        calls.push("identity");
        if (options.wrongWriteChannel) throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH" as never, message: `authorized channel is not ${expectedChannelId}` });
        return { expectedChannelId };
      },
    },
    youtube: {
      readFresh: async () => {
        calls.push("writer.read");
        writerReads += 1;
        if (options.changeBeforeWriterRead?.read === writerReads) {
          options.changeBeforeWriterRead.change(video);
          video.version += 1;
        }
        const read = structuredClone({ snippet: video.snippet, localizations: video.localizations });
        if (lagReads > 0 && options.lagging) {
          lagReads -= 1;
          read.snippet.title = options.lagging.title;
          if (options.lagging.description !== undefined) read.snippet.description = options.lagging.description;
        }
        return read;
      },
      assertLiveWritesAuthorized: async () => {
        calls.push("liveWrites");
        if (options.liveWrites === false) throw new DomainError({ code: "live_writes_disabled", message: "Real YouTube write execution is disabled" });
      },
      update: async (_credentials, _videoId, payload) => {
        calls.push("videos.update");
        updates.push(structuredClone(payload) as never);
        if (options.storeInstead) options.storeInstead(payload, video);
        else video.localizations = structuredClone(payload.localizations);
        video.version += 1;
        options.afterUpdate?.(video);
      },
    },
    backup: {
      checkInfrastructureHealth: async () => ({ healthy: true }),
      captureBackup: async (args) => {
        calls.push("backup");
        assert.deepEqual(args.snapshot.existingLocalizations, video.localizations, "the backup holds the translations as they are right before the write");
        return { path: "/backups/v25.json", capturedAt: "2026-11-24T10:00:00Z" };
      },
    },
    audit: { record: async ({ channelId, eventType, detail }) => void audits.push({ channelId, eventType, detail: detail as Record<string, unknown>, occurredAt: new Date() }) },
    sleep: async () => undefined,
    newId: () => "op1",
    source: "package_localizations",
    readBack: { attempts: 3, delayMs: 0 },
  });

  const deps: PackageLocalizationsDeps = {
    findPackage: async (channelId, code) =>
      channelId === CH && code === "V25"
        ? { pkg: options.pkg ?? manifest({ ja: PACKAGE_JA, de: UPLOADED_DE }), manifestSha256: M, manifestPath: "04 Videos/1125 V25/V25_release.json", folder: "04 Videos/1125 V25", videoId: VIDEO_ID, thumbnailPath: null }
        : "not_found",
    uploadRows: async () => options.rows ?? [doneRow({ ja: UPLOADED_JA, de: UPLOADED_DE }, "verified")],
    assertDeviceAvailable: async () => void calls.push("device"),
    credentialRef: async (_c, actor) => ({ userId: actor.kind === "owner" ? actor.userId : "u-connected" }),
    snapshot: async () => {
      calls.push("snapshot");
      return snapshotOf();
    },
    readLocalizations: async () => {
      calls.push("readLocalizations");
      return { defaultLanguage: video.snippet.defaultLanguage, localizations: structuredClone(video.localizations) };
    },
    // As production: this computer's audit rows of the video (the service parses them itself).
    auditEvents: async (channelId) => audits.filter((a) => a.channelId === channelId).map((a) => ({ ...a })),
    writeLocalizations: (args) =>
      writer.apply({ credentialRef: args.credentialRef, channelId: args.channelId, videoId: args.videoId, localizations: args.localizations, expectedCurrent: args.expectedCurrent, expected: args.expected, auditContext: args.auditContext }),
    audit: async ({ channelId, eventType, detail }) => void audits.push({ channelId, eventType, detail, occurredAt: new Date() }),
  };
  return { service: createPackageLocalizations(deps), video, calls, updates, audits };
}

const refusedWith = (code: string) => (error: unknown) => isDomainError(error) && error.code === code;
const statusOf = (preview: { languages: Array<{ language: string; status: string }> }) => Object.fromEntries(preview.languages.map((l) => [l.language, l.status]));

test("dry run: per-language table (ja write, de same), fr kept, 56 units -- every read, no backup and no write", async () => {
  const h = harness();
  const preview = await h.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.kind, "localizations");
  assert.equal(preview.baseline, "upload_row");
  assert.equal(preview.defaultLanguage, "en");
  assert.deepEqual(statusOf(preview), { ja: "write", de: "same" });
  const ja = preview.languages.find((l) => l.language === "ja")!;
  assert.deepEqual(ja.fields, [
    { field: "title", youtube: "ジャズ A", uploaded: "ジャズ A", package: "ジャズ B", status: "write" },
    { field: "description", youtube: "説明 A", uploaded: "説明 A", package: "説明 B", status: "write" },
  ]);
  assert.deepEqual(preview.kept, ["fr"]);
  assert.deepEqual(preview.ownLanguageSkipped, []);
  assert.equal(preview.changed, true);
  assert.equal(preview.quotaUnits, 56);
  assert.equal(PACKAGE_LOCALIZATIONS_QUOTA_UNITS, 56);
  assert.equal(preview.etag, "etag-1");
  assert.ok(!h.calls.includes("backup") && !h.calls.includes("videos.update") && !h.calls.includes("liveWrites"));
  assert.deepEqual(h.audits.map((a) => a.eventType), ["DRY_RUN"]);
  assert.equal(h.audits[0].detail.source, "package_localizations");
});

test("apply (Producer): only ja is sent, fr and de kept exactly, never the default language; snippet sent back as read; audited", async () => {
  const h = harness();
  const result = await h.service.apply(CH, { video: "V25", expectedManifestSha256: M }, PRODUCER);
  assert.deepEqual(result, { dryRun: false, kind: "localizations", channelId: CH, video: "V25", videoId: VIDEO_ID, manifestSha256: M, kept: ["fr"], changed: true, written: ["ja"], verified: true });
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.updates[0].localizations, { ja: PACKAGE_JA, de: UPLOADED_DE, fr: { title: "Jazz FR", description: "Desc FR" } });
  assert.ok(!("en" in h.updates[0].localizations), "the video's own language is never a translation");
  assert.equal(h.updates[0].snippet.title, "Jazz A (en)");
  assert.equal(h.updates[0].snippet.description, "Desc A");
  assert.equal(h.updates[0].snippet.defaultLanguage, "en");
  assert.equal(h.updates[0].snippet.categoryId, "10");
  // Identity before the backup, Live writes immediately before the one update.
  const i = h.calls.indexOf("identity");
  const b = h.calls.indexOf("backup");
  const u = h.calls.indexOf("videos.update");
  assert.ok(i < b && b < u);
  assert.equal(h.calls[u - 1], "liveWrites");
  const writerRows = h.audits.filter((a) => a.detail.source === "package_localizations" && a.detail.event === undefined);
  assert.deepEqual(writerRows.map((a) => a.eventType), ["BACKUP", "RESULT", "VERIFICATION"]);
  assert.ok(writerRows.every((a) => a.detail.actor === "producer"));
  const applied = h.audits.find((a) => a.detail.event === "package_localizations.applied")!;
  assert.equal(applied.detail.verified, true);
  assert.equal(applied.detail.actor, "producer");
});

test("after a fix the next check compares with what the fix sent: everything same, baseline localizations_apply", async () => {
  const h = harness();
  await h.service.apply(CH, { video: "V25" }, PRODUCER);
  const again = await h.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.equal(again.baseline, "localizations_apply");
  assert.deepEqual(statusOf(again), { ja: "same", de: "same" });
  assert.equal(again.changed, false);
  const result = await h.service.apply(CH, { video: "V25" }, PRODUCER);
  assert.equal(result.changed, false);
  assert.equal(h.updates.length, 1, "nothing to write: no second update");
});

test("conflict: ja's title edited in Studio (neither the upload's nor the package's) -- the whole call refused for the Producer and the owner", async () => {
  for (const actor of [PRODUCER, OWNER]) {
    const video = baseVideo();
    video.localizations.ja = { title: "ジャズ Studio", description: "説明 A" };
    const h = harness({ video });
    const preview = await h.service.preview(CH, { video: "V25" }, actor);
    const ja = preview.languages.find((l) => l.language === "ja")!;
    assert.equal(ja.status, "conflict");
    assert.deepEqual(ja.fields.map((f) => f.status), ["conflict", "write"]);
    await assert.rejects(
      h.service.apply(CH, { video: "V25", expectedEtag: preview.etag ?? "", expectedManifestSha256: M }, actor),
      (error: unknown) => refusedWith("package_localizations_conflict")(error) && JSON.stringify(((error as DomainError).details as Record<string, unknown>).conflicts) === JSON.stringify([{ language: "ja", fields: ["title"] }])
    );
    assert.ok(!h.calls.includes("backup") && !h.calls.includes("videos.update"));
  }
});

test("unknown upload baseline (the translations step did not read back verified): every difference is a conflict, an equal language stays same", async () => {
  for (const step of ["mismatch", "failed"]) {
    const h = harness({ rows: [doneRow({ ja: UPLOADED_JA, de: UPLOADED_DE }, step)] });
    const preview = await h.service.preview(CH, { video: "V25" }, PRODUCER);
    assert.equal(preview.baseline, "unknown");
    assert.deepEqual(statusOf(preview), { ja: "conflict", de: "same" });
    await assert.rejects(h.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("package_localizations_conflict"));
    assert.equal(h.updates.length, 0);
  }
  // No finished upload row here at all (uploaded from the other computer): unknown too.
  const other = harness({ rows: [] });
  assert.equal((await other.service.preview(CH, { video: "V25" }, PRODUCER)).baseline, "unknown");
});

test("a language YouTube lacks: added when the upload sent none of it; a conflict when the upload sent it and it is gone now", async () => {
  const video = baseVideo();
  delete video.localizations.ja;
  // The upload's package had no translations (step none): absent = absent, so ja is written.
  const added = harness({ video: structuredClone(video), rows: [doneRow(null, "none")] });
  const p1 = await added.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.equal(p1.languages.find((l) => l.language === "ja")!.status, "write");
  // de: YouTube has the upload-time text, but the upload (none) never sent it -- someone else added it -- and it equals the package: same.
  assert.equal(p1.languages.find((l) => l.language === "de")!.status, "same");
  const r1 = await added.service.apply(CH, { video: "V25" }, PRODUCER);
  assert.deepEqual(r1.written, ["ja"]);
  assert.deepEqual(added.updates[0].localizations.ja, PACKAGE_JA);
  // The upload sent ja and YouTube no longer has it (removed in Studio): conflict, never re-added silently.
  const removed = harness({ video: structuredClone(video) });
  const p2 = await removed.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.equal(p2.languages.find((l) => l.language === "ja")!.status, "conflict");
  await assert.rejects(removed.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("package_localizations_conflict"));
});

test("a language the video has and the package lacks is kept exactly through the write and the read-back", async () => {
  const h = harness();
  await h.service.apply(CH, { video: "V25" }, PRODUCER);
  assert.deepEqual(h.video.localizations.fr, { title: "Jazz FR", description: "Desc FR" });
  assert.deepEqual(h.video.localizations.de, UPLOADED_DE);
});

test("the video's own default language is never written: a package language equal to YouTube's default is skipped and listed", async () => {
  const video = baseVideo();
  // The owner switched the video's default language to de in Studio; the package (default en) still has a de translation.
  video.snippet.defaultLanguage = "de";
  delete video.localizations.de;
  const h = harness({ video, pkg: manifest({ ja: PACKAGE_JA, de: { title: "Jazz NEU", description: "Beschreibung NEU" } }) });
  const preview = await h.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.deepEqual(preview.ownLanguageSkipped, ["de"]);
  assert.deepEqual(statusOf(preview), { ja: "write" });
  await h.service.apply(CH, { video: "V25" }, PRODUCER);
  assert.ok(!("de" in h.updates[0].localizations));
  assert.equal(h.updates[0].snippet.title, "Jazz A (en)", "the snippet text is not replaced by the de translation");
});

test("a video with no default language on YouTube is refused before any write", async () => {
  const video = baseVideo();
  video.snippet.defaultLanguage = null;
  const h = harness({ video });
  await assert.rejects(h.service.preview(CH, { video: "V25" }, PRODUCER), refusedWith("validation_failed"));
  assert.equal(h.updates.length, 0);
});

test("Live writes off: refused at the gateway check, nothing sent, no applied audit", async () => {
  const h = harness({ liveWrites: false });
  await assert.rejects(h.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("live_writes_disabled"));
  assert.equal(h.updates.length, 0);
  assert.ok(!h.audits.some((a) => a.detail.event === "package_localizations.applied"));
});

test("wrong channel fails closed: a video of another channel before any write; the write identity check too", async () => {
  const video = baseVideo();
  video.channelId = "UC_other";
  const foreign = harness({ video });
  await assert.rejects(foreign.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("video_not_in_channel"));
  assert.ok(!foreign.calls.includes("identity") && foreign.updates.length === 0);
  const mismatch = harness({ wrongWriteChannel: true });
  await assert.rejects(mismatch.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("WRITE_CHANNEL_MISMATCH"));
  assert.ok(!mismatch.calls.includes("backup") && mismatch.updates.length === 0);
});

test("a Studio edit of a language being written between the check and the write: video_details_conflict, nothing sent", async () => {
  const h = harness({ changeBeforeWriterRead: { read: 1, change: (video) => (video.localizations.ja = { title: "ジャズ Studio", description: "説明 A" }) } });
  await assert.rejects(h.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("video_details_conflict"));
  assert.equal(h.updates.length, 0);
  // The same edit landing on the writer's recheck read (after the backup): still refused, nothing sent.
  const late = harness({ changeBeforeWriterRead: { read: 2, change: (video) => (video.localizations.ja = { title: "ジャズ Studio", description: "説明 A" }) } });
  await assert.rejects(late.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("video_details_conflict"));
  assert.ok(late.calls.includes("backup"), "the late edit lands after the backup");
  assert.equal(late.updates.length, 0);
});

test("read-back mismatch is reported: update_failed with the problem, audit verified false, no baseline left", async () => {
  const h = harness({ storeInstead: (payload, video) => (video.localizations = { ...structuredClone(payload.localizations), ja: { title: "ジャズ ?", description: "説明 B" } }) });
  await assert.rejects(h.service.apply(CH, { video: "V25" }, PRODUCER), (error: unknown) => refusedWith("update_failed")(error) && /text differs: ja/.test(String(((error as DomainError).details as Record<string, unknown>).problem)));
  const applied = h.audits.find((a) => a.detail.event === "package_localizations.applied")!;
  assert.equal(applied.detail.verified, false);
  assert.equal((await h.service.preview(CH, { video: "V25" }, PRODUCER)).baseline, "upload_row", "an unverified fix is never a baseline");
});

test("privacy or publishAt changed after the write: reported (update_failed, changedUntouched)", async () => {
  const h = harness({ afterUpdate: (video) => (video.publishAt = null) });
  await assert.rejects(h.service.apply(CH, { video: "V25" }, PRODUCER), (error: unknown) => refusedWith("update_failed")(error) && JSON.stringify(((error as DomainError).details as Record<string, unknown>).changedUntouched) === JSON.stringify(["publishAt"]));
});

test("this computer's upload of the video has not finished its read-back: refused before any YouTube read", async () => {
  for (const status of ["queued", "uploading", "processing", "finishing", "paused"]) {
    const h = harness({ rows: [{ status, videoId: VIDEO_ID, packageJson: "{}", finishedAt: null }] });
    await assert.rejects(h.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("upload_steps_pending"));
    await assert.rejects(h.service.preview(CH, { video: "V25" }, PRODUCER), refusedWith("upload_steps_pending"));
    assert.ok(!h.calls.includes("snapshot") && h.updates.length === 0);
  }
});

test("the owner applies only what his preview showed: etag and manifest required, a changed video or package refused", async () => {
  const h = harness();
  await assert.rejects(h.service.apply(CH, { video: "V25", expectedManifestSha256: M }, OWNER), refusedWith("validation_failed"));
  await assert.rejects(h.service.apply(CH, { video: "V25", expectedEtag: "etag-1" }, OWNER), refusedWith("validation_failed"));
  await assert.rejects(h.service.apply(CH, { video: "V25", expectedEtag: "etag-0", expectedManifestSha256: M }, OWNER), refusedWith("video_details_conflict"));
  await assert.rejects(h.service.apply(CH, { video: "V25", expectedEtag: "etag-1", expectedManifestSha256: "f".repeat(64) }, OWNER), refusedWith("package_metadata_manifest_changed"));
  assert.equal(h.updates.length, 0);
  const result = await h.service.apply(CH, { video: "V25", expectedEtag: "etag-1", expectedManifestSha256: M }, OWNER);
  assert.deepEqual(result.written, ["ja"]);
});

test("a package without translations writes nothing; an invalid set is refused; a video not uploaded yet is refused", async () => {
  const none = harness({ pkg: manifest(null) });
  const preview = await none.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.deepEqual(preview.languages, []);
  assert.equal(preview.changed, false);
  assert.deepEqual(preview.kept, ["de", "fr", "ja"]);
  assert.equal((await none.service.apply(CH, { video: "V25" }, PRODUCER)).changed, false);
  assert.equal(none.updates.length, 0);
  const invalid = harness({ pkg: manifest({ ja: { title: "", description: "x" } }) });
  await assert.rejects(invalid.service.preview(CH, { video: "V25" }, PRODUCER), refusedWith("package_metadata_invalid"));
  await assert.rejects(harness().service.preview(CH, { video: "V99" }, PRODUCER), refusedWith("upload_package_not_ready"));
});

// Review of 1c515813, should-fix 1: the writer sends the snippet back from its own read, so a lagging replica's older title would be
// echoed over a texts fix just written (and its read-back, against the same read, would say verified). The call names the texts the
// snippet must show; the writer waits for them and refuses when they never come.
const metadataFix = (title: string, minutesAgo: number): AuditEventLike => ({
  channelId: CH,
  eventType: "VERIFICATION",
  detail: { source: "package_metadata", event: "package_metadata.applied", sent: { title }, verified: true },
  occurredAt: new Date(Date.now() - minutesAgo * 60_000),
});

test("stale echo: a texts fix just wrote T2, the writer's first read lags (T1) -- it waits, then sends T2 back, never T1", async () => {
  const video = baseVideo();
  video.snippet.title = "T2";
  const h = harness({ video, events: [metadataFix("T2", 1)], lagging: { reads: 1, title: "T1" } });
  const result = await h.service.apply(CH, { video: "V25" }, PRODUCER);
  assert.deepEqual(result.written, ["ja"]);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].snippet.title, "T2");
});

test("stale echo: the check's own snapshot lags too (T1) -- the recent fix's T2 is still what the snippet must show", async () => {
  const video = baseVideo();
  video.snippet.title = "T2";
  const h = harness({ video, events: [metadataFix("T2", 1)], lagging: { reads: 1, title: "T1", snapshotLags: true } });
  await h.service.apply(CH, { video: "V25" }, PRODUCER);
  assert.equal(h.updates[0].snippet.title, "T2");
});

test("stale echo: the lag outlasts the writer's reads -- refused, nothing sent (the old title is never written back)", async () => {
  const video = baseVideo();
  video.snippet.title = "T2";
  const h = harness({ video, events: [metadataFix("T2", 1)], lagging: { reads: 10, title: "T1" } });
  await assert.rejects(h.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("update_failed"));
  assert.equal(h.updates.length, 0);
  assert.equal(h.video.snippet.title, "T2");
});

test("expectedSnippetOf: the checked texts; a texts fix within 15 minutes overrides them; an older one or another channel's does not", () => {
  const now = { title: "T1", description: "D1", tags: ["a"] };
  const at = Date.now();
  assert.deepEqual(expectedSnippetOf([], CH, now, at), { title: "T1", description: "D1", tags: ["a"] });
  assert.deepEqual(expectedSnippetOf([metadataFix("T2", 5)], CH, now, at), { title: "T2", description: "D1", tags: ["a"] });
  assert.deepEqual(expectedSnippetOf([metadataFix("T2", 20)], CH, now, at), { title: "T1", description: "D1", tags: ["a"] });
  assert.deepEqual(expectedSnippetOf([{ ...metadataFix("T2", 1), channelId: "UC_other" }], CH, now, at), { title: "T1", description: "D1", tags: ["a"] });
});

test("the texts fix and the translations fix of one video run one at a time on this computer", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = withPackageVideoLock(CH, "V25", async () => {
    order.push("texts start");
    await gate;
    order.push("texts end");
  });
  const second = withPackageVideoLock(CH, "V25", async () => void order.push("translations"));
  const other = withPackageVideoLock(CH, "V26", async () => void order.push("other video"));
  await other;
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["texts start", "other video", "texts end", "translations"]);
  // A failure in one does not block the next.
  await assert.rejects(withPackageVideoLock(CH, "V25", async () => Promise.reject(new Error("boom"))));
  assert.equal(await withPackageVideoLock(CH, "V25", async () => "next"), "next");
});

// Review minor 2: the REAL parsing of this computer's audit (no copy in the harness).
const fromRow: LocalizationBaseline = { entries: { ja: UPLOADED_JA, de: UPLOADED_DE }, complete: true };
const applied = (detail: Record<string, unknown>, channelId = CH): AuditEventLike => ({ channelId, eventType: "VERIFICATION", detail: { source: "package_localizations", event: "package_localizations.applied", ...detail } });
const writerResult = (languages: string[]): AuditEventLike => ({ channelId: CH, eventType: "RESULT", detail: { source: "package_localizations", languages } });
const goodAfter = { entries: { ja: PACKAGE_JA, de: UPLOADED_DE }, complete: true };

test("baseline parsing: a verified fix's afterLocalizations; nothing here -> the upload row; nothing at all -> unknown", () => {
  assert.deepEqual(localizationBaselineOf([writerResult(["ja"]), applied({ verified: true, languages: ["ja"], afterLocalizations: goodAfter })], CH, fromRow), { baseline: goodAfter, kind: "localizations_apply" });
  assert.deepEqual(localizationBaselineOf([], CH, fromRow), { baseline: fromRow, kind: "upload_row" });
  assert.deepEqual(localizationBaselineOf([], CH, null), { baseline: { entries: {}, complete: false }, kind: "unknown" });
});

test("baseline parsing: a malformed latest fix is unknown -- never the older upload row", () => {
  for (const detail of [{ verified: true, afterLocalizations: { entries: { ja: { title: 5 } }, complete: true } }, { verified: true, afterLocalizations: null }, { verified: "yes", afterLocalizations: goodAfter }]) {
    assert.deepEqual(localizationBaselineOf([applied(detail)], CH, fromRow), { baseline: { entries: {}, complete: false }, kind: "unknown" }, JSON.stringify(detail));
  }
});

test("baseline parsing: a newer attempt that did not read back verified makes the languages it tried unknown", () => {
  // An applied row with the writer unverified, newer than a verified fix.
  const r1 = localizationBaselineOf(
    [writerResult(["ja"]), applied({ verified: true, languages: ["ja"], afterLocalizations: goodAfter }), writerResult(["de"]), applied({ verified: false, writerVerified: false, languages: ["de"], afterLocalizations: goodAfter })],
    CH,
    fromRow
  );
  assert.equal(r1.kind, "localizations_apply");
  assert.deepEqual(r1.baseline, { entries: { ja: PACKAGE_JA }, complete: true, unknown: ["de"] });
  // The writer's RESULT with no applied row after it (the call died after the update): over the upload row.
  const r2 = localizationBaselineOf([writerResult(["ja"])], CH, fromRow);
  assert.equal(r2.kind, "upload_row");
  assert.deepEqual(r2.baseline, { entries: { de: UPLOADED_DE }, complete: true, unknown: ["ja"] });
  // Status changed after a writer-verified write (review minor 3): the baseline holds.
  const r3 = localizationBaselineOf([writerResult(["ja"]), applied({ verified: false, writerVerified: true, languages: ["ja"], afterLocalizations: goodAfter })], CH, fromRow);
  assert.deepEqual(r3, { baseline: goodAfter, kind: "localizations_apply" });
});

test("baseline parsing: only this channel's rows count", () => {
  const foreign = [writerResult(["ja"]), applied({ verified: true, languages: ["ja"], afterLocalizations: goodAfter }, "UC_other")].map((e) => ({ ...e, channelId: "UC_other" }));
  assert.deepEqual(localizationBaselineOf(foreign, CH, fromRow), { baseline: fromRow, kind: "upload_row" });
});

test("an explicitly unknown language is a conflict even over a complete baseline", async () => {
  const h = harness({ events: [writerResult(["ja"])] });
  const preview = await h.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.deepEqual(statusOf(preview), { ja: "conflict", de: "same" });
});

test("a scheduled video publishing during the call is not a failure; a status change after a verified write still leaves the baseline", async () => {
  const video = baseVideo();
  video.publishAt = new Date(Date.now() - 1000).toISOString();
  const published = harness({ video, afterUpdate: (v) => ((v.privacyStatus = "public"), (v.publishAt = null)) });
  assert.equal((await published.service.apply(CH, { video: "V25" }, PRODUCER)).verified, true);
  const moved = harness({ afterUpdate: (v) => (v.publishAt = "2026-11-26T13:00:00Z") });
  await assert.rejects(moved.service.apply(CH, { video: "V25" }, PRODUCER), refusedWith("update_failed"));
  const again = await moved.service.preview(CH, { video: "V25" }, PRODUCER);
  assert.equal(again.baseline, "localizations_apply");
  assert.deepEqual(statusOf(again), { ja: "same", de: "same" });
});
