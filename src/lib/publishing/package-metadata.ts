import { DomainError, isDomainError, type DomainErrorCode } from "@/lib/shared-domain";
import { DESCRIPTION_MAX_BYTES, hasAngleBrackets, TAGS_MAX_CHARACTERS, tagsLength, TITLE_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
import type { ApplyFieldsUpdateResult, VerifyUnchangedField, VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import { approvedPackageOf } from "./approved-package";
import { PACKAGING_FIELDS, samePackagingValue, youtubeDescriptionOf, type PackagingField } from "./package-text";
import type { ReleasePackage } from "./packages";

// BL-265 (ADR 0072 §5, MEDIA_GATE_PLAN.md §3.4; AGENTS.md §F «Package metadata after upload»): the owner (Web UI) and the Producer
// fix an UPLOADED video's default-language title, description and tags from its release package's CURRENT manifest. No new writer and
// no new gateway function: the write is `video-details.applyFieldsUpdate` (identity check, backup, etag guard, full snippet
// read-merge-write, Live writes right before `videos.update`, read-back, audit). This service adds what is package-driven: the patch
// from the manifest only (never free text), the three-way conflict check (YouTube now / what the upload sent / the manifest), the
// refusals (device gate, an unfinished upload here, a missing or foreign video), the untouched-field and localization read-back, and
// its own audit (`source: package_metadata`). Never automatic: a new manifest is applied only on a person's click or the Producer's call.

/** One `videos.list` (1) + `videos.update` (50) + its read-back (1) + the localization set before and after (2). */
export const PACKAGE_METADATA_QUOTA_UNITS = 54;
const ACTIVE_UPLOAD = new Set(["queued", "uploading", "processing", "finishing", "paused"]);
/** Snippet and status fields the write never touches; the read-back confirms them unchanged (ADR 0072 §5). */
const UNTOUCHED: VerifyUnchangedField[] = ["categoryId", "defaultLanguage", "defaultAudioLanguage", "privacyStatus", "publishAt"];

export type PackageMetadataActor = { kind: "owner"; userId: string } | { kind: "producer" };

export type PackageMetadataFound = {
  pkg: ReleasePackage;
  manifestSha256: string;
  manifestPath: string;
  folder: string;
  /** The video id the package's upload record names, or null (not uploaded). */
  videoId: string | null;
  /** The package's default thumbnail relative to the workspace when the file exists, else null. */
  thumbnailPath: string | null;
};

/** `stepsJson`: the row's steps (the translations step's outcome tells what the upload sent; absent: unknown). */
export type PackageMetadataUploadRow = { status: string; videoId: string | null; packageJson: string; finishedAt: Date | null; stepsJson?: string };

export type PackageMetadataDeps = {
  /** The channel's package of `video` on this computer (the publishing scan), or why there is none. */
  findPackage(channelId: string, video: string): Promise<PackageMetadataFound | "not_found" | "no_workspace" | "workspace_unavailable" | "ambiguous">;
  /** The channel's common tags (a package without tags of its own sends them, owner msg 2817). */
  channelTags(channelId: string): Promise<string[]>;
  /** This computer's upload rows of the channel's `video`. */
  uploadRows(channelId: string, video: string): Promise<PackageMetadataUploadRow[]>;
  /** The texts YouTube had right after the latest `package_metadata` apply on this computer to this video (its audit), or null. */
  lastApplied(channelId: string, videoId: string): Promise<Baseline | null>;
  /** The SHA-256 of the thumbnail last set on the video by the thumbnail writer here (its audit), or null when unknown. */
  lastThumbnailSha256(channelId: string, videoId: string): Promise<string | null>;
  /** A workspace file's SHA-256, or null when it is not there. */
  fileSha256(channelId: string, relativePath: string): Promise<string | null>;
  /** The device mutation gate (operation lock, recovery mode): throws when this computer may not write now. */
  assertDeviceAvailable(): Promise<void>;
  /** The Google user to act as: the owner's session user, or for the Producer the channel's connected user. */
  credentialRef(channelId: string, actor: PackageMetadataActor): Promise<{ userId: string }>;
  /** `video-details.getSnapshot` (read scope); "not_found" when YouTube returns no such video. */
  snapshot(args: { credentialRef: { userId: string }; channelId: string; videoId: string }): Promise<VideoDetailsSnapshot | "not_found">;
  /** The video's localization languages (publishing's own read; video-details never reads locales); null when unreadable. */
  localizationLanguages(args: { credentialRef: { userId: string }; channelId: string; videoId: string }): Promise<string[] | null>;
  /** `video-details.applyFieldsUpdate`. */
  applyFields(args: {
    credentialRef: { userId: string };
    expectedChannelId: string;
    videoId: string;
    /** BL-279 (ADR 0072 amendment 2): `categoryId` only from `package-category.ts`, only the channel's saved setting. */
    patch: { title?: string; description?: string; tags?: string[]; categoryId?: string };
    expectedEtag?: string;
    verifyUnchanged: VerifyUnchangedField[];
    auditContext: Record<string, string | number | boolean | null | string[]>;
  }): Promise<ApplyFieldsUpdateResult>;
  audit(event: { channelId: string; videoId: string; eventType: "DRY_RUN" | "RESULT" | "VERIFICATION"; detail: Record<string, unknown> }): Promise<void>;
};

export type PackageMetadataFieldStatus = "same" | "write" | "conflict";

export type PackageMetadataPreview = {
  dryRun: true;
  channelId: string;
  video: string;
  videoId: string;
  manifestSha256: string;
  /** YouTube's etag as read now: the owner's apply passes it back (a change in between fails closed, `video_details_conflict`). */
  etag: string | null;
  /** What the upload sent is known (`upload_row` / `metadata_apply`), or not (the upload ran on the other computer): `unknown`. */
  baseline: "upload_row" | "metadata_apply" | "unknown";
  fields: Array<{ field: PackagingField; youtube: string | string[]; uploaded: string | string[] | null; manifest: string | string[]; status: PackageMetadataFieldStatus }>;
  /** Some field would be written or is in conflict. */
  changed: boolean;
  /** YouTube's audio language is `zxx` ("Not applicable"): it is left out of the write (RISK-102) and not compared afterwards. */
  audioLanguageLeftOut: boolean;
  quotaUnits: number;
  /** The package's default thumbnail and whether it differs from the one last set (null: unknown) -- replaced by the thumbnail writer. */
  thumbnail: { path: string; differs: boolean | null } | null;
};

export type PackageMetadataApplyResult = {
  dryRun: false;
  channelId: string;
  video: string;
  videoId: string;
  manifestSha256: string;
  changed: boolean;
  written: PackagingField[];
  skippedConflicts: PackagingField[];
  verified: boolean;
  backupPath: string | null;
  audioLanguageLeftOut: boolean;
};

export const refuse = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });

/** YouTube's own limits on the default-language texts (the same codes as the package scan's blocking problems). */
export function packageTextProblems(texts: { title: string; description: string; tags: readonly string[] }): string[] {
  const problems: string[] = [];
  if (texts.title.trim() === "") problems.push("title_empty");
  if ([...texts.title].length > TITLE_MAX_CHARACTERS) problems.push("title_too_long");
  if (hasAngleBrackets(texts.title)) problems.push("title_angle_brackets");
  if (new TextEncoder().encode(texts.description).length > DESCRIPTION_MAX_BYTES) problems.push("description_too_long");
  if (hasAngleBrackets(texts.description)) problems.push("description_angle_brackets");
  if (tagsLength(texts.tags) > TAGS_MAX_CHARACTERS) problems.push("tags_too_long");
  if (texts.tags.some((tag) => hasAngleBrackets(tag))) problems.push("tags_angle_brackets");
  return problems;
}

/**
 * The gates every package-driven fix of an uploaded video passes first (title/description/tags here, the translations in
 * `package-localizations.ts`): the channel's one package of `video` on this computer, and the video its upload record names.
 */
export async function findUploadedPackage(
  deps: Pick<PackageMetadataDeps, "findPackage">,
  channelId: string,
  video: string
): Promise<PackageMetadataFound & { videoId: string }> {
  if (typeof video !== "string" || video.trim() === "") throw refuse("validation_failed", "video is required (e.g. V61 or S14)");
  const found = await deps.findPackage(channelId, video);
  if (found === "no_workspace") throw refuse("package_no_workspace", "This channel has no workspace folder on this computer.", { channelId });
  if (found === "workspace_unavailable") throw refuse("package_workspace_unavailable", "The channel's workspace cannot be used now.", { channelId });
  if (found === "ambiguous") throw refuse("validation_failed", `${video}: more than one package names this video.`, { channelId, video });
  if (found === "not_found") throw refuse("upload_package_not_ready", `${video}: no release package of this channel has this video number on this computer.`, { channelId, video });
  if (!found.videoId) throw refuse("package_metadata_not_uploaded", `${video} is not on YouTube yet (no upload record): its packaging goes up with the upload.`, { channelId, video });
  return { ...found, videoId: found.videoId };
}

/**
 * The next gates: no upload of `video` still running here (it has not finished its read-back), the device gate, the Google user to act
 * as, and YouTube's current snapshot of the video, which must exist and be the channel's.
 */
export async function readUploadedVideo(
  deps: Pick<PackageMetadataDeps, "uploadRows" | "assertDeviceAvailable" | "credentialRef" | "snapshot">,
  channelId: string,
  video: string,
  videoId: string,
  actor: PackageMetadataActor
): Promise<{ rows: PackageMetadataUploadRow[]; credentialRef: { userId: string }; now: VideoDetailsSnapshot }> {
  const rows = await deps.uploadRows(channelId, video);
  if (rows.some((row) => ACTIVE_UPLOAD.has(row.status))) {
    throw refuse("upload_steps_pending", `${video}'s upload on this computer has not finished its read-back yet: fix the packaging after it is done.`, { channelId, video });
  }
  await deps.assertDeviceAvailable();
  const credentialRef = await deps.credentialRef(channelId, actor);
  const now = await deps.snapshot({ credentialRef, channelId, videoId });
  if (now === "not_found") throw refuse("video_missing", `${video}'s video ${videoId} is not on YouTube (deleted, or not visible to this account).`, { channelId, video, videoId });
  if (now.channelId !== channelId) throw refuse("video_not_in_channel", `${videoId} is not a video of this channel.`, { channelId, video, videoId, videoChannelId: now.channelId ?? null });
  return { rows, credentialRef, now };
}

/** The fixes of a video in progress on this computer, by channel and video code: each waits for the one before it. */
const videoLocks = new Map<string, Promise<unknown>>();

/**
 * Runs one package-driven fix of a video (texts or translations) after any other one of the same video on this computer has ended
 * (review of 1c515813: the translations write echoes the snippet it read, so a texts fix landing in between could be reverted).
 */
export async function withPackageVideoLock<T>(channelId: string, video: string, run: () => Promise<T>): Promise<T> {
  const key = `${channelId}\u0000${String(video ?? "")}`;
  const before = videoLocks.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(run);
  const tail = mine.catch(() => undefined);
  videoLocks.set(key, tail);
  try {
    return await mine;
  } finally {
    if (videoLocks.get(key) === tail) videoLocks.delete(key);
  }
}

type Texts = { title: string; description: string; tags: string[] };
/**
 * What this computer knows the video got from the package side, per field (the next fix's baseline b): null where it is not known --
 * then any difference on that field is a conflict. Never YouTube's current value of a field that was not written (review fix 1).
 */
export type Baseline = { title: string | null; description: string | null; tags: string[] | null };

/** The baseline the next fix compares with after this write (review fix 1). */
export function afterTextsOf(
  patch: { title?: string; description?: string; tags?: string[] },
  fields: ReadonlyArray<{ field: PackagingField; manifest: string | string[]; status: PackageMetadataFieldStatus }>,
  before: Baseline | null
): Baseline {
  const pick = (field: PackagingField): string | string[] | null => {
    if (patch[field] !== undefined) return patch[field]!;
    const f = fields.find((x) => x.field === field);
    if (f?.status === "same") return f.manifest;
    return before ? before[field] : null;
  };
  return { title: pick("title") as string | null, description: pick("description") as string | null, tags: pick("tags") as string[] | null };
}

export function createPackageMetadata(deps: PackageMetadataDeps) {
  /** Every read and check both the preview and the apply make, in the plan's order; nothing is written. */
  async function inspect(channelId: string, video: string, actor: PackageMetadataActor) {
    const found = await findUploadedPackage(deps, channelId, video);
    const settingsTags = await deps.channelTags(channelId);
    const frozen = approvedPackageOf(found.pkg, { manifestPath: found.manifestPath, folder: found.folder }, { channelTags: settingsTags });
    // The patch sends what YouTube keeps: the description with LF and no trailing line breaks, so its echo is the text sent.
    const manifest: Texts = { title: frozen.title, description: youtubeDescriptionOf(frozen.description), tags: frozen.tags };
    const problems = packageTextProblems(manifest);
    if (problems.length > 0) throw refuse("package_metadata_invalid", `${video}'s package texts break YouTube's limits: ${problems.join(", ")}.`, { channelId, video, problems });
    const { rows, credentialRef, now } = await readUploadedVideo(deps, channelId, video, found.videoId, actor);
    // (b) what this video's upload sent: the latest packaging fix here, else the finished upload row of this video here.
    const applied = await deps.lastApplied(channelId, found.videoId);
    const doneRow = rows
      .filter((row) => row.status === "done" && row.videoId === found.videoId)
      .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))[0];
    let baseline: PackageMetadataPreview["baseline"] = "unknown";
    let uploaded: Baseline | null = null;
    let rowTexts: Baseline | null = null;
    if (doneRow) {
      try {
        const sent = JSON.parse(doneRow.packageJson) as Partial<Texts>;
        if (typeof sent.title === "string" && typeof sent.description === "string" && Array.isArray(sent.tags)) rowTexts = { title: sent.title, description: sent.description, tags: sent.tags };
      } catch {
        // unreadable: unknown, every difference is a conflict (the safe default)
      }
    }
    if (applied) {
      baseline = "metadata_apply";
      uploaded = applied;
    } else if (rowTexts) {
      baseline = "upload_row";
      uploaded = rowTexts;
    }
    const youtube: Texts = { title: now.title, description: now.description, tags: now.tags };
    const fields = PACKAGING_FIELDS.map((field) => {
      let status: PackageMetadataFieldStatus;
      if (samePackagingValue(field, youtube[field], manifest[field])) status = "same";
      else if (uploaded !== null && uploaded[field] !== null && samePackagingValue(field, youtube[field], uploaded[field])) status = "write";
      else status = "conflict";
      return { field, youtube: youtube[field], uploaded: uploaded ? uploaded[field] : null, manifest: manifest[field], status };
    });
    let thumbnail: PackageMetadataPreview["thumbnail"] = null;
    if (found.thumbnailPath) {
      const [current, last] = await Promise.all([deps.fileSha256(channelId, found.thumbnailPath), deps.lastThumbnailSha256(channelId, found.videoId)]);
      let sentPath: string | null = null;
      try {
        sentPath = doneRow ? ((JSON.parse(doneRow.packageJson) as { thumbnailFile?: string }).thumbnailFile ?? null) : null;
      } catch {
        // a damaged row: unknown
      }
      const differs = current !== null && last !== null ? current !== last : sentPath !== null ? sentPath !== found.thumbnailPath : null;
      thumbnail = { path: found.thumbnailPath, differs };
    }
    return { found, videoId: found.videoId, credentialRef, now, manifest, fields, baseline, uploaded, thumbnail, audioLanguageLeftOut: (now.defaultAudioLanguage ?? "").toLowerCase() === "zxx" };
  }

  const actorLabel = (actor: PackageMetadataActor) => actor.kind;

  return {
    /** The dry run: every read and check, the three-way diff and the quota -- no backup, no write; a local DRY_RUN audit row only. */
    async preview(channelId: string, input: { video: string }, actor: PackageMetadataActor): Promise<PackageMetadataPreview> {
      const seen = await inspect(channelId, input?.video, actor);
      const preview: PackageMetadataPreview = {
        dryRun: true,
        channelId,
        video: seen.found.pkg.video,
        videoId: seen.videoId,
        manifestSha256: seen.found.manifestSha256,
        etag: seen.now.etag,
        baseline: seen.baseline,
        fields: seen.fields,
        changed: seen.fields.some((f) => f.status !== "same"),
        audioLanguageLeftOut: seen.audioLanguageLeftOut,
        quotaUnits: PACKAGE_METADATA_QUOTA_UNITS,
        thumbnail: seen.thumbnail,
      };
      await deps
        .audit({ channelId, videoId: seen.videoId, eventType: "DRY_RUN", detail: { source: "package_metadata", actor: actorLabel(actor), video: preview.video, manifestSha256: preview.manifestSha256, fields: seen.fields.map((f) => ({ field: f.field, status: f.status })) } })
        .catch(() => undefined);
      return preview;
    },

    /**
     * The write. The owner names the etag his preview showed (required) and may tick conflicting fields to overwrite; the Producer is
     * refused on any conflict and never overrides one. Only the manifest's values of the fields that differ are sent.
     */
    async apply(
      channelId: string,
      input: { video: string; expectedEtag?: string; expectedManifestSha256?: string; overwrite?: string[] },
      actor: PackageMetadataActor
    ): Promise<PackageMetadataApplyResult> {
      if (actor.kind === "owner" && (typeof input?.expectedEtag !== "string" || input.expectedEtag === "")) {
        throw refuse("validation_failed", "expectedEtag is required: apply what the preview showed");
      }
      // Review fix 2: the owner applies the manifest his preview showed (required); the Producer may pin one too.
      if (actor.kind === "owner" && (typeof input?.expectedManifestSha256 !== "string" || input.expectedManifestSha256 === "")) {
        throw refuse("validation_failed", "expectedManifestSha256 is required: apply the package the preview showed");
      }
      const overwrite = actor.kind === "owner" ? (input.overwrite ?? []).filter((f): f is PackagingField => (PACKAGING_FIELDS as readonly string[]).includes(f)) : [];
      // One package fix of a video at a time on this computer (the translations fix takes the same lock, review of 1c515813).
      return withPackageVideoLock(channelId, input?.video, async () => {
      const seen = await inspect(channelId, input?.video, actor);
      if (input.expectedManifestSha256 !== undefined && input.expectedManifestSha256 !== seen.found.manifestSha256) {
        throw refuse("package_metadata_manifest_changed", `${seen.found.pkg.video}'s package was re-packaged since the preview: preview it again.`, {
          channelId,
          video: seen.found.pkg.video,
          expected: input.expectedManifestSha256,
          actual: seen.found.manifestSha256,
        });
      }
      const conflicts = seen.fields.filter((f) => f.status === "conflict").map((f) => f.field);
      if (actor.kind === "producer" && conflicts.length > 0) {
        throw refuse("package_metadata_conflict", `${seen.found.pkg.video}: ${conflicts.join(", ")} on YouTube differ from both what the upload sent and the package (changed in Studio, or uploaded from the other computer): only the owner may overwrite them.`, {
          channelId,
          video: seen.found.pkg.video,
          conflicts,
          baseline: seen.baseline,
        });
      }
      const written = seen.fields.filter((f) => f.status === "write" || (f.status === "conflict" && overwrite.includes(f.field))).map((f) => f.field);
      const skippedConflicts = conflicts.filter((f) => !overwrite.includes(f));
      const base = { dryRun: false as const, channelId, video: seen.found.pkg.video, videoId: seen.videoId, manifestSha256: seen.found.manifestSha256, audioLanguageLeftOut: seen.audioLanguageLeftOut };
      if (written.length === 0) return { ...base, changed: false, written: [], skippedConflicts, verified: true, backupPath: null };
      const patch: { title?: string; description?: string; tags?: string[] } = {};
      for (const field of written) {
        if (field === "tags") patch.tags = seen.manifest.tags;
        else patch[field] = seen.manifest[field];
      }
      const languagesBefore = await deps.localizationLanguages({ credentialRef: seen.credentialRef, channelId, videoId: seen.videoId });
      const context = { source: "package_metadata", actor: actorLabel(actor), video: base.video, manifestSha256: base.manifestSha256, fields: written };
      let result: ApplyFieldsUpdateResult;
      try {
        result = await deps.applyFields({
          credentialRef: seen.credentialRef,
          expectedChannelId: channelId,
          videoId: seen.videoId,
          patch,
          // The owner's preview etag; the Producer's own fresh read (a change between that read and the write still fails closed).
          ...(actor.kind === "owner" ? { expectedEtag: input.expectedEtag } : seen.now.etag ? { expectedEtag: seen.now.etag } : {}),
          // `zxx` is left out of the write (RISK-102), so YouTube may reset it: it is not compared then (stated in the result).
          verifyUnchanged: UNTOUCHED.filter((field) => !(field === "defaultAudioLanguage" && seen.audioLanguageLeftOut)),
          auditContext: context,
        });
      } catch (error) {
        if (isDomainError(error)) throw error;
        throw refuse("update_failed", error instanceof Error ? error.message : String(error));
      }
      const languagesAfter = await deps.localizationLanguages({ credentialRef: seen.credentialRef, channelId, videoId: seen.videoId });
      const sameLanguages = languagesBefore !== null && languagesAfter !== null && JSON.stringify([...languagesBefore].sort()) === JSON.stringify([...languagesAfter].sort());
      await deps
        .audit({
          channelId,
          videoId: seen.videoId,
          eventType: "VERIFICATION",
          detail: {
            ...context,
            event: "package_metadata.applied",
            sent: patch,
            // The next fix's baseline (b): a written field as sent; a field that was already the package's ("same") as it is; any other
            // field keeps the baseline it had (null when unknown) -- never YouTube's current value of an unwritten field (review fix 1:
            // that would turn the owner's Studio edit into the baseline and let the next fix overwrite it without a conflict).
            afterTexts: afterTextsOf(patch, seen.fields, seen.uploaded),
            localizationLanguages: { before: languagesBefore, after: languagesAfter, same: sameLanguages }, verified: sameLanguages, backupPath: result.backupPath },
        })
        .catch(() => undefined);
      if (!sameLanguages) {
        throw refuse("update_failed", "The write went through, but the video's translation languages could not be confirmed unchanged afterwards: check them in Studio.", { channelId, video: base.video, before: languagesBefore, after: languagesAfter });
      }
      return { ...base, changed: true, written, skippedConflicts, verified: true, backupPath: result.backupPath };
      });
    },
  };
}

export type PackageMetadata = ReturnType<typeof createPackageMetadata>;
