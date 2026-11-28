import { isDomainError } from "@/lib/shared-domain";
import type { ApplyFieldsUpdateResult, VerifyUnchangedField, VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import { refuse, withPackageVideoLock, type PackageMetadataActor, type PackageMetadataDeps } from "./package-metadata";
import type { PublishingSettingsView } from "./settings-service";
import type { ReadVideoFields, UploadedPackageVideo } from "./video-publishing-check";

// BL-279 (owner TG 4963/4964, ADR 0072 amendment 2; docs/WRITE_AUTHORIZATIONS.md «Package metadata after upload»): the category of a
// video a release package of the channel already put on YouTube, set to the channel's SAVED publishing setting `categoryId` -- never a
// free value. Every WWE upload went out as Music because its settings were never saved (the default "10"). No new writer and no new
// gateway function: the write is `video-details.applyFieldsUpdate` (identity check, backup of the full snippet and status, etag guard,
// full snippet read-merge-write -- title, description, tags and both languages sent back as read -- Live writes right before
// `videos.update`, read-back, audit). This service decides which videos, refuses what the authority does not cover, checks the untouched
// fields and the translation languages afterwards and audits with `source: package_category`. Never automatic.

/**
 * Per written video, at least (second review, finding 2): this service's fresh read (`videos.list`, 1) + the translation languages
 * before and after (2) + video-details' identity check (`channels.list mine`, 1) and its own read before the backup (1) + the adapter's
 * fresh read right before the write (1) + `videos.update` (50) + one read-back (1; a lagging read-back re-reads, each 1 more) = 57.
 */
export const PACKAGE_CATEGORY_QUOTA_UNITS_PER_VIDEO = 57;
const ACTIVE_UPLOAD = new Set(["queued", "uploading", "processing", "finishing", "paused"]);

export type PackageCategoryDeps = Pick<PackageMetadataDeps, "assertDeviceAvailable" | "credentialRef" | "snapshot" | "localizationLanguages" | "applyFields" | "audit"> & {
  settings(channelId: string): Promise<PublishingSettingsView>;
  uploadedVideos(channelId: string): Promise<UploadedPackageVideo[] | "no_workspace" | "workspace_unavailable">;
  /** This computer's upload rows of the channel (any video). */
  uploadRows(channelId: string): Promise<Array<{ status: string; video: string; videoId: string | null }>>;
  /** `getVideosPublishingFields`: at most 50 ids, one call (the preview's batch read). */
  readVideos(args: { credentialRef: { userId: string }; channelId: string; videoIds: string[] }): Promise<Map<string, ReadVideoFields>>;
};

/** `audio_language_zxx`: YouTube's audio language is `zxx`, which a snippet write cannot send back (RISK-102) -- skipped, never written. */
export type PackageCategoryStatus = "write" | "same" | "upload_pending" | "not_on_youtube" | "not_in_channel" | "audio_language_zxx";

export type PackageCategoryPreview = {
  dryRun: true;
  channelId: string;
  /** The channel's saved `categoryId`: the only value this fix writes. */
  targetCategoryId: string;
  videos: Array<{ video: string; videoId: string; title: string | null; current: string | null; status: PackageCategoryStatus }>;
  toWrite: number;
  quotaUnits: number;
};

export type PackageCategoryVideoResult = {
  video: string;
  videoId: string;
  before: string | null;
  status: "written" | "same" | "upload_pending" | "not_on_youtube" | "not_in_channel" | "audio_language_zxx" | "failed";
  backupPath?: string | null;
  /**
   * Second review, finding 1: on a failure, the write may have landed -- the `videos.update` call was made (video-details'
   * `writeSent`), or it returned and a later check failed. Such a failure is that video's result, never a refusal of the run.
   */
  maybeWritten?: true;
  error?: { code: string; message: string };
};

export type PackageCategoryApplyResult = {
  dryRun: false;
  channelId: string;
  targetCategoryId: string;
  videos: PackageCategoryVideoResult[];
  written: string[];
  /** Every written video read back with the new category and its other fields and translation languages unchanged. */
  verified: boolean;
  /** The first failure stops the run (fail closed); the videos after it are not tried. */
  stoppedAt: string | null;
};

/** The fields the category write must leave as they were (the read just before the write against the read after it). */
const UNTOUCHED_FIELDS: VerifyUnchangedField[] = ["title", "description", "tags", "defaultLanguage", "defaultAudioLanguage", "privacyStatus", "publishAt"];
const isZxx = (language: string | null | undefined) => (language ?? "").toLowerCase() === "zxx";

export function createPackageCategory(deps: PackageCategoryDeps) {
  /** The channel's saved category, or the refusal: never saved (the built-in default is never pushed to YouTube), or in conflict. */
  async function targetCategory(channelId: string): Promise<string> {
    const view = await deps.settings(channelId);
    if (!view.saved.includes("categoryId")) {
      throw refuse("publishing_settings_not_saved", "The channel's category was never saved in its publishing settings: save it on Home first -- the fix writes only a saved value.", { channelId, field: "categoryId", saved: view.saved });
    }
    if (view.conflictedFields.includes("categoryId")) {
      throw refuse("publishing_settings_changed", "The channel's category differs between the computers: choose it in Merge first.", { channelId, conflictedFields: view.conflictedFields });
    }
    return view.settings.categoryId;
  }

  async function uploaded(channelId: string): Promise<UploadedPackageVideo[]> {
    const listed = await deps.uploadedVideos(channelId);
    if (listed === "no_workspace") throw refuse("package_no_workspace", "This channel has no workspace folder on this computer.", { channelId });
    if (listed === "workspace_unavailable") throw refuse("package_workspace_unavailable", "The channel's workspace cannot be used now.", { channelId });
    return listed;
  }

  const activeVideos = async (channelId: string) => new Set((await deps.uploadRows(channelId)).filter((r) => ACTIVE_UPLOAD.has(r.status)).map((r) => r.video));

  return {
    /** The dry run: every package-uploaded video of the channel, its category now and whether it would be written. No backup, no write. */
    async preview(channelId: string, actor: PackageMetadataActor): Promise<PackageCategoryPreview> {
      const target = await targetCategory(channelId);
      const videos = await uploaded(channelId);
      await deps.assertDeviceAvailable();
      const active = await activeVideos(channelId);
      const credentialRef = await deps.credentialRef(channelId, actor);
      const read = new Map<string, ReadVideoFields>();
      let calls = 0;
      for (let i = 0; i < videos.length; i += 50) {
        const got = await deps.readVideos({ credentialRef, channelId, videoIds: videos.slice(i, i + 50).map((v) => v.videoId) });
        calls += 1;
        for (const [id, fields] of got) read.set(id, fields);
      }
      const rows = videos.map((v) => {
        const fields = read.get(v.videoId);
        let status: PackageCategoryStatus;
        if (!fields) status = "not_on_youtube";
        else if (fields.channelId !== channelId) status = "not_in_channel";
        else if (active.has(v.video)) status = "upload_pending";
        else if (fields.categoryId === target) status = "same";
        // Review finding 2: a `zxx` audio language would be dropped from the snippet and could be reset by the write -- skipped.
        else if (isZxx(fields.defaultAudioLanguage)) status = "audio_language_zxx";
        else status = "write";
        const visible = fields && fields.channelId === channelId;
        return { video: v.video, videoId: v.videoId, title: visible ? fields.title : null, current: visible ? fields.categoryId : null, status };
      });
      const toWrite = rows.filter((r) => r.status === "write").length;
      await deps
        .audit({ channelId, videoId: `package-category:${channelId}`, eventType: "DRY_RUN", detail: { source: "package_category", actor: actor.kind, targetCategoryId: target, toWrite: rows.filter((r) => r.status === "write").map((r) => r.videoId) } })
        .catch(() => undefined);
      return { dryRun: true, channelId, targetCategoryId: target, videos: rows, toWrite, quotaUnits: calls + toWrite * PACKAGE_CATEGORY_QUOTA_UNITS_PER_VIDEO };
    },

    /**
     * The write, one video at a time. `expectedCategoryId` is the target the preview showed (required for the owner): a category saved
     * differently since refuses the whole call. `videoIds` (optional) narrows it to some of the channel's package-uploaded videos; a
     * video no package of the channel uploaded is refused before anything is read.
     */
    async apply(channelId: string, input: { expectedCategoryId?: string; videoIds?: string[] }, actor: PackageMetadataActor): Promise<PackageCategoryApplyResult> {
      // Review finding 9: the owner and the Producer alike apply the category their dry run showed.
      if (typeof input?.expectedCategoryId !== "string" || input.expectedCategoryId === "") {
        throw refuse("validation_failed", "expectedCategoryId is required: apply what the preview showed");
      }
      if (input?.videoIds !== undefined && (!Array.isArray(input.videoIds) || input.videoIds.length === 0 || input.videoIds.some((id) => typeof id !== "string" || id === ""))) {
        throw refuse("validation_failed", "videoIds, when given, lists 1 or more video ids");
      }
      const target = await targetCategory(channelId);
      if (input.expectedCategoryId !== undefined && input.expectedCategoryId !== target) {
        throw refuse("publishing_settings_changed", "The channel's saved category changed since the preview: preview it again.", { channelId, expected: input.expectedCategoryId, actual: target });
      }
      const all = await uploaded(channelId);
      let chosen = all;
      if (input.videoIds) {
        const byId = new Map(all.map((v) => [v.videoId, v]));
        const foreign = input.videoIds.filter((id) => !byId.has(id));
        if (foreign.length > 0) {
          throw refuse("package_metadata_not_uploaded", "Only a video a release package of this channel put on YouTube (its upload record names it) can get the category fix.", { channelId, videoIds: foreign });
        }
        chosen = [...new Set(input.videoIds)].map((id) => byId.get(id)!);
      }
      await deps.assertDeviceAvailable();
      const credentialRef = await deps.credentialRef(channelId, actor);
      const results: PackageCategoryVideoResult[] = [];
      let stoppedAt: string | null = null;
      for (const v of chosen) {
        const outcome = await withPackageVideoLock(channelId, v.video, async (): Promise<PackageCategoryVideoResult> => {
          if ((await activeVideos(channelId)).has(v.video)) return { video: v.video, videoId: v.videoId, before: null, status: "upload_pending" };
          let now: VideoDetailsSnapshot | "not_found";
          try {
            now = await deps.snapshot({ credentialRef, channelId, videoId: v.videoId });
          } catch (error) {
            return failed(v, null, error);
          }
          if (now === "not_found") return { video: v.video, videoId: v.videoId, before: null, status: "not_on_youtube" };
          if (now.channelId !== channelId) return { video: v.video, videoId: v.videoId, before: null, status: "not_in_channel" };
          if (now.categoryId === target) return { video: v.video, videoId: v.videoId, before: now.categoryId, status: "same" };
          if (isZxx(now.defaultAudioLanguage)) return { video: v.video, videoId: v.videoId, before: now.categoryId, status: "audio_language_zxx" };
          const context = { source: "package_category", actor: actor.kind, video: v.video, categoryBefore: now.categoryId, categoryAfter: target };
          /** The write call was handed to video-details / it returned (the write landed). */
          let sent = false;
          let applied = false;
          try {
            const languagesBefore = await deps.localizationLanguages({ credentialRef, channelId, videoId: v.videoId });
            // Review finding 3: without the languages before, the check after the write could not pass -- refuse before writing.
            if (languagesBefore === null) {
              return { video: v.video, videoId: v.videoId, before: now.categoryId, status: "failed", error: { code: "update_failed", message: "The video's translation languages could not be read before the write: nothing was written. Try again." } };
            }
            sent = true;
            const result: ApplyFieldsUpdateResult = await deps.applyFields({
              credentialRef,
              expectedChannelId: channelId,
              videoId: v.videoId,
              patch: { categoryId: target },
              ...(now.etag ? { expectedEtag: now.etag } : {}),
              verifyUnchanged: UNTOUCHED_FIELDS,
              auditContext: context,
            });
            applied = true;
            const languagesAfter = await deps.localizationLanguages({ credentialRef, channelId, videoId: v.videoId });
            const sameLanguages = languagesBefore !== null && languagesAfter !== null && JSON.stringify([...languagesBefore].sort()) === JSON.stringify([...languagesAfter].sort());
            await deps
              .audit({ channelId, videoId: v.videoId, eventType: "VERIFICATION", detail: { ...context, event: "package_category.applied", localizationLanguages: { before: languagesBefore, after: languagesAfter, same: sameLanguages }, verified: sameLanguages, backupPath: result.backupPath } })
              .catch(() => undefined);
            if (!sameLanguages) {
              return { video: v.video, videoId: v.videoId, before: now.categoryId, status: "failed", backupPath: result.backupPath, maybeWritten: true, error: { code: "update_failed", message: "The category was written, but the video's translation languages could not be confirmed unchanged afterwards: check them in Studio." } };
            }
            return { video: v.video, videoId: v.videoId, before: now.categoryId, status: "written", backupPath: result.backupPath };
          } catch (error) {
            const outcome = failed(v, now.categoryId, error);
            // video-details marks every error from its update call on (`writeSent`); its own post-write `update_failed` (a read-back
            // mismatch, or an unexpected error it maps) is one too. A refusal before the call (wrong channel, Live writes off, an etag
            // conflict) is none of these and keeps refusing the run.
            const writeSent = isDomainError(error) && (error.details as { writeSent?: unknown } | undefined)?.writeSent === true;
            return applied || writeSent || (sent && outcome.error?.code === "update_failed") ? { ...outcome, maybeWritten: true } : outcome;
          }
        });
        results.push(outcome);
        if (outcome.status === "failed") {
          stoppedAt = v.videoId;
          break;
        }
      }
      const written = results.filter((r) => r.status === "written").map((r) => r.videoId);
      const failure = results.find((r) => r.status === "failed");
      // Nothing written and the first video was refused before its write (Live writes off, a wrong channel): the refusal itself, so a
      // caller sees its code. A failure after the write call was made (`maybeWritten`: any code -- a read-back that differs, or a quota
      // or reads-disabled error on the read-back) is returned as that video's result with its backup path, never hidden behind an error.
      if (failure && written.length === 0 && failure.error && !failure.maybeWritten) {
        throw refuse(failure.error.code as never, failure.error.message, { channelId, videoId: failure.videoId, video: failure.video });
      }
      return { dryRun: false, channelId, targetCategoryId: target, videos: results, written, verified: !failure, stoppedAt };
    },
  };
}

function failed(v: UploadedPackageVideo, before: string | null, error: unknown): PackageCategoryVideoResult {
  const code = isDomainError(error) ? error.code : "update_failed";
  const message = error instanceof Error ? error.message : String(error);
  // Review finding 4: video-details names the backup it took before a write whose read-back then failed.
  const backupPath = isDomainError(error) ? (error.details as { backupPath?: unknown } | undefined)?.backupPath : undefined;
  return { video: v.video, videoId: v.videoId, before, status: "failed", ...(typeof backupPath === "string" ? { backupPath } : {}), error: { code, message } };
}

export type PackageCategory = ReturnType<typeof createPackageCategory>;
