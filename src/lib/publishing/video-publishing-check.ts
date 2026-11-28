import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { ScannedPackage } from "./package-scan";
import type { PublishingSettings } from "./settings";
import type { PublishingSettingsView } from "./settings-service";

// BL-279 (owner TG 4964: «сделай инструменты для продюсера чтобы он мог читать и проверять эти поля»): the publishing fields of a
// channel's videos as YouTube has them NOW, compared with what the channel's saved publishing settings (and, for the languages, the
// synthetic-media mark and the captions, the video's release package) say they should be. Read-only: the reads go through the read
// gateway (ADR 0007), `videos.list` 50 ids per call (1 unit); caption tracks only on request (`captions.list`, 50 units a video).

/** A video a release package of the channel put on YouTube (its upload record names the id), with what its package states. */
export type UploadedPackageVideo = {
  video: string;
  videoId: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  /** The package's own synthetic-media mark (absent/null: the channel's setting applies, as at upload). */
  containsSyntheticMedia: boolean | null;
  /** The package names an English captions file (BL-269). */
  hasCaptions: boolean;
};

/**
 * The channel's videos a release package put on YouTube: the scanned packages whose upload record names a video id (either computer's
 * upload), one per video id. The owner's link of a video uploaded outside the app (BL-221, `youtube.linked`) is not one (owner TG 4963:
 * «только у роликов, загруженных через YTM», review finding 1).
 */
export function uploadedPackageVideos(packages: readonly ScannedPackage[]): UploadedPackageVideo[] {
  const seen = new Set<string>();
  const out: UploadedPackageVideo[] = [];
  for (const p of packages) {
    const videoId = p.youtube?.videoId;
    if (!p.pkg || !p.video || !videoId || p.youtube?.linked || seen.has(videoId)) continue;
    seen.add(videoId);
    out.push({
      video: p.video,
      videoId,
      defaultLanguage: p.pkg.defaultLanguage ?? null,
      defaultAudioLanguage: p.pkg.defaultAudioLanguage ?? null,
      containsSyntheticMedia: p.pkg.containsSyntheticMedia ?? null,
      hasCaptions: (p.pkg.captions?.length ?? 0) > 0,
    });
  }
  return out;
}

/** One video as `videos.list` returned it (`youtube-read-gateway` `VideoPublishingFields`). */
export type ReadVideoFields = {
  channelId: string | null;
  title: string | null;
  categoryId: string | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  privacyStatus: string | null;
  license: string | null;
  selfDeclaredMadeForKids: boolean | null;
  madeForKids: boolean | null;
  embeddable: boolean | null;
  containsSyntheticMedia: boolean | null;
  hasPaidProductPlacement: boolean | null;
};

export type ReadCaptionTrack = { language: string | null; trackKind: string | null; status: string | null; isDraft: boolean | null };

export type PublishingCheckActor = { kind: "owner"; userId: string } | { kind: "producer" };

export type VideoPublishingCheckDeps = {
  settings(channelId: string): Promise<PublishingSettingsView>;
  /** The channel's videos that a release package put on YouTube (this computer's package scan), or why there are none. */
  uploadedVideos(channelId: string): Promise<UploadedPackageVideo[] | "no_workspace" | "workspace_unavailable">;
  credentialRef(channelId: string, actor: PublishingCheckActor): Promise<{ userId: string }>;
  /** `getVideosPublishingFields`: at most 50 ids, one call. */
  readVideos(args: { credentialRef: { userId: string }; channelId: string; videoIds: string[] }): Promise<Map<string, ReadVideoFields>>;
  /** `listVideoCaptions` of one video (50 units). */
  captions(args: { credentialRef: { userId: string }; channelId: string; videoId: string }): Promise<ReadCaptionTrack[]>;
};

export const PUBLISHING_CHECK_MAX_VIDEOS = 200;
export const PUBLISHING_CHECK_MAX_CAPTION_VIDEOS = 50;
const VIDEOS_PER_CALL = 50;
const CAPTIONS_UNITS = 50;
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export type CheckedField =
  | "categoryId"
  | "license"
  | "madeForKids"
  | "embeddable"
  | "containsSyntheticMedia"
  | "paidProductPlacement"
  | "defaultLanguage"
  | "defaultAudioLanguage"
  | "englishCaptions";

/**
 * Where the expected value comes from: the channel's saved setting, the built-in default (the setting was never saved), the video's
 * release package, or nothing to compare with (`unknown`: e.g. a video no package of this computer names).
 */
export type ExpectedSource = "saved" | "default" | "package" | "unknown";

export type FieldCheck = {
  field: CheckedField;
  youtube: string | boolean | null;
  expected: string | boolean | null;
  source: ExpectedSource;
  /** `unreadable`: YouTube did not return the field (or captions were not read); `unchecked`: nothing to compare with. */
  status: "match" | "mismatch" | "unreadable" | "unchecked";
};

export type VideoCheck =
  | {
      videoId: string;
      video: string | null;
      found: true;
      title: string | null;
      privacyStatus: string | null;
      /** YouTube's own effective `status.madeForKids` (read-only; the setting compares `selfDeclaredMadeForKids`). */
      madeForKidsEffective: boolean | null;
      fields: FieldCheck[];
      mismatches: CheckedField[];
      captionTracks: ReadCaptionTrack[] | null;
      /** The caption tracks could not be read (the code); absent when read or not asked. */
      captionsError?: string;
    }
  | { videoId: string; video: string | null; found: false; reason: "not_on_youtube" | "not_in_channel" };

export type VideoPublishingCheckResult = {
  channelId: string;
  /** The channel's publishing settings were saved at least once (BL-279's upload guard); false: every expectation is a default. */
  settingsSaved: boolean;
  savedFields: string[];
  conflictedFields: string[];
  expected: Pick<PublishingSettings, "categoryId" | "license" | "madeForKids" | "embeddable" | "containsSyntheticMedia" | "paidProductPlacement" | "captionsEnabled">;
  videos: VideoCheck[];
  /** Videos with at least one mismatch. */
  mismatched: number;
  captionsChecked: boolean;
  quotaUnits: number;
};

const refuse = (code: ConstructorParameters<typeof DomainError>[0]["code"], message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });
const sameLanguage = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

function compare(field: CheckedField, youtube: string | boolean | null, expected: string | boolean | null, source: ExpectedSource): FieldCheck {
  if (source === "unknown") return { field, youtube, expected, source, status: "unchecked" };
  if (youtube === null) return { field, youtube, expected, source, status: "unreadable" };
  const equal = field === "defaultLanguage" || field === "defaultAudioLanguage" ? sameLanguage(youtube as string, expected as string | null) : youtube === expected;
  return { field, youtube, expected, source, status: equal ? "match" : "mismatch" };
}

/** A track counts as English captions when its language is `en`/`en-*`, it is not YouTube's automatic one, and not a draft. */
export function hasEnglishCaptions(tracks: readonly ReadCaptionTrack[]): boolean {
  return tracks.some((t) => /^en(-|$)/i.test(t.language ?? "") && (t.trackKind ?? "").toLowerCase() !== "asr" && t.isDraft !== true);
}

/** Pure: one video's checks against the settings view and its package (null: no package here names it). */
export function checkVideo(read: ReadVideoFields, view: PublishingSettingsView, pkg: UploadedPackageVideo | null, captionTracks: ReadCaptionTrack[] | null): FieldCheck[] {
  const s = view.settings;
  const from = (field: keyof PublishingSettings): ExpectedSource => (view.saved.includes(field as never) ? "saved" : "default");
  const checks: FieldCheck[] = [
    compare("categoryId", read.categoryId, s.categoryId, from("categoryId")),
    compare("license", read.license, s.license, from("license")),
    compare("madeForKids", read.selfDeclaredMadeForKids, s.madeForKids, from("madeForKids")),
    compare("embeddable", read.embeddable, s.embeddable, from("embeddable")),
    pkg && pkg.containsSyntheticMedia !== null
      ? compare("containsSyntheticMedia", read.containsSyntheticMedia, pkg.containsSyntheticMedia, "package")
      : compare("containsSyntheticMedia", read.containsSyntheticMedia, s.containsSyntheticMedia, from("containsSyntheticMedia")),
    compare("paidProductPlacement", read.hasPaidProductPlacement, s.paidProductPlacement, from("paidProductPlacement")),
    // The languages are the package's (the upload sends the package's, not a channel setting).
    compare("defaultLanguage", read.defaultLanguage, pkg ? pkg.defaultLanguage : null, pkg && pkg.defaultLanguage ? "package" : "unknown"),
    compare("defaultAudioLanguage", read.defaultAudioLanguage, pkg ? pkg.defaultAudioLanguage : null, pkg && pkg.defaultAudioLanguage ? "package" : "unknown"),
  ];
  // English captions are expected where the channel's switch is on AND the package names a captions file (what the upload sends).
  const expectEnglish = s.captionsEnabled === true && pkg?.hasCaptions === true;
  const englishSource: ExpectedSource = pkg ? (view.saved.includes("captionsEnabled") ? "saved" : "default") : "unknown";
  checks.push(compare("englishCaptions", captionTracks === null ? null : hasEnglishCaptions(captionTracks), pkg ? expectEnglish : null, englishSource));
  return checks;
}

export function createVideoPublishingCheck(deps: VideoPublishingCheckDeps) {
  return {
    async check(input: { channelId: string; videoIds?: string[]; captions?: boolean }, actor: PublishingCheckActor): Promise<VideoPublishingCheckResult> {
      const channelId = input?.channelId;
      if (typeof channelId !== "string" || channelId === "") throw refuse("validation_failed", "channelId is required");
      const asked = input.videoIds;
      if (asked !== undefined) {
        if (!Array.isArray(asked) || asked.length === 0) throw refuse("validation_failed", "videoIds, when given, lists 1 or more video ids");
        if (asked.length > PUBLISHING_CHECK_MAX_VIDEOS) throw refuse("validation_failed", `At most ${PUBLISHING_CHECK_MAX_VIDEOS} videos per call`);
        const bad = asked.find((id) => typeof id !== "string" || !VIDEO_ID.test(id));
        if (bad !== undefined) throw refuse("validation_failed", `Not a YouTube video id: ${String(bad)}`);
      }
      const view = await deps.settings(channelId);
      const listed = await deps.uploadedVideos(channelId);
      if (listed === "no_workspace") throw refuse("package_no_workspace", "This channel has no workspace folder on this computer.", { channelId });
      if (listed === "workspace_unavailable") throw refuse("package_workspace_unavailable", "The channel's workspace cannot be used now.", { channelId });
      const byId = new Map(listed.map((v) => [v.videoId, v]));
      const ids = asked ? [...new Set(asked)] : listed.map((v) => v.videoId);
      if (ids.length > PUBLISHING_CHECK_MAX_VIDEOS) throw refuse("validation_failed", `The channel has ${ids.length} uploaded package videos; name at most ${PUBLISHING_CHECK_MAX_VIDEOS} with videoIds.`);
      const withCaptions = input.captions === true;
      if (withCaptions && ids.length > PUBLISHING_CHECK_MAX_CAPTION_VIDEOS) {
        throw refuse("validation_failed", `Caption tracks cost 50 units a video: at most ${PUBLISHING_CHECK_MAX_CAPTION_VIDEOS} videos per call with captions: true (${ids.length} asked).`);
      }
      const credentialRef = await deps.credentialRef(channelId, actor);
      let quotaUnits = 0;
      const read = new Map<string, ReadVideoFields>();
      for (let i = 0; i < ids.length; i += VIDEOS_PER_CALL) {
        const part = ids.slice(i, i + VIDEOS_PER_CALL);
        const got = await deps.readVideos({ credentialRef, channelId, videoIds: part });
        quotaUnits += 1;
        for (const [id, fields] of got) read.set(id, fields);
      }
      const videos: VideoCheck[] = [];
      for (const videoId of ids) {
        const pkg = byId.get(videoId) ?? null;
        const fields = read.get(videoId);
        if (!fields) {
          videos.push({ videoId, video: pkg?.video ?? null, found: false, reason: "not_on_youtube" });
          continue;
        }
        // Never a value of another channel's video (it is read with this channel's account, but is not its video).
        if (fields.channelId !== channelId) {
          videos.push({ videoId, video: pkg?.video ?? null, found: false, reason: "not_in_channel" });
          continue;
        }
        let tracks: ReadCaptionTrack[] | null = null;
        let captionsError: string | undefined;
        if (withCaptions) {
          try {
            tracks = await deps.captions({ credentialRef, channelId, videoId });
            quotaUnits += CAPTIONS_UNITS;
          } catch (error) {
            // One video's tracks unreadable (e.g. the grant lacks youtube.force-ssl): its captions check is `unreadable`, the rest stands.
            captionsError = isDomainError(error) ? error.code : "captions_unreadable";
          }
        }
        const checks = checkVideo(fields, view, pkg, tracks);
        videos.push({
          videoId,
          video: pkg?.video ?? null,
          found: true,
          title: fields.title,
          privacyStatus: fields.privacyStatus,
          madeForKidsEffective: fields.madeForKids,
          fields: checks,
          mismatches: checks.filter((c) => c.status === "mismatch").map((c) => c.field),
          captionTracks: tracks,
          ...(captionsError ? { captionsError } : {}),
        });
      }
      const s = view.settings;
      return {
        channelId,
        settingsSaved: view.saved.length > 0,
        savedFields: [...view.saved],
        conflictedFields: [...view.conflictedFields],
        expected: { categoryId: s.categoryId, license: s.license, madeForKids: s.madeForKids, embeddable: s.embeddable, containsSyntheticMedia: s.containsSyntheticMedia, paidProductPlacement: s.paidProductPlacement, captionsEnabled: s.captionsEnabled },
        videos,
        mismatched: videos.filter((v) => v.found && v.mismatches.length > 0).length,
        captionsChecked: withCaptions,
        quotaUnits,
      };
    },
  };
}

export type VideoPublishingCheck = ReturnType<typeof createVideoPublishingCheck>;
