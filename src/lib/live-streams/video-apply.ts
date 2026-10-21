import { createHash } from "node:crypto";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import type { LiveVideoSettings } from "./fields";
import type { LiveLocalizationSet, StoredLocalizations } from "./localizations";

// ---------------------------------------------------------------------------
// BL-186 stage 3 (docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md §2.2, §5 stage 3; spike C §4.2): the broadcast's video-level
// settings -- the video's fields (one `videos.update` through video-details), the thumbnail (`thumbnails.set`) and the
// playlists (`playlistItems.insert` through playlist-management) -- applied to the broadcast's video after Start, or again on
// the owner's «Применить снова». A failed step never ends the broadcast; each step is an event, and so is the summary.
// ---------------------------------------------------------------------------

/**
 * The video-level writers, plugged in by the app layer (AGENTS.md §M: live-streams imports no other feature module). Absent,
 * Start works exactly as before and the settings are reported as not applied.
 */
export type VideoFieldsPort = {
  /** video-details' apply: identity check, backup, the write, the read-back; throws when it fails or does not read back. */
  apply(args: { credentialRef: unknown; channelId: string; videoId: string; patch: Record<string, unknown> }): Promise<{ verified: boolean }>;
  /** playlist-management's add: the playlist must belong to the channel; one video. */
  addToPlaylist(args: { credentialRef: unknown; channelId: string; playlistId: string; videoId: string }): Promise<{ added: boolean; reason?: string }>;
};

/**
 * BL-207 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 3, ADR 0045): the translations writer, plugged in by the app layer like the fields
 * (`live-localizations`). It checks the identity, reads the video fresh, keeps every other language, backs up, checks Live writes
 * right before its one `videos.update` and reads back. `expected`: the fields step's snippet values, which the fresh read must
 * already show (the snippet part is sent whole). Absent, a stored set is reported as not applied.
 */
export type LocalizationsPort = {
  apply(args: { credentialRef: unknown; channelId: string; videoId: string; localizations: LiveLocalizationSet; expected: Record<string, unknown> }): Promise<{ verified: true } | { verified: false; detail: string }>;
};

export type VideoApplyDependencies = {
  videoFields?: VideoFieldsPort;
  localizations?: LocalizationsPort;
  youtube: {
    setThumbnail(credentials: ResolvedCredentials, videoId: string, image: { mimeType: "image/jpeg" | "image/png"; bytes: Buffer }): Promise<void>;
    playlistHasVideo(credentials: ResolvedCredentials, playlistId: string, videoId: string): Promise<boolean>;
  };
  thumbnails: { read(channelId: string): Promise<{ kind: "jpeg" | "png"; bytes: Uint8Array } | null> };
  event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Whether the broadcast is still the stream's running one: once the owner stopped it, or a segment switch replaced it (BL-205),
   * the remaining steps are not sent. */
  isCurrent(channelId: string, broadcastId: string): Promise<"current" | "stopped" | "replaced">;
  /** Fresh credentials (Live writes, identity) for the steps after the fields: the run can outlast the access token it started with
   * (Tropico, 2026-10-20: the thumbnail was refused as unauthenticated 2 minutes after a segment switch). */
  credentials?(): Promise<ResolvedCredentials>;
};

export type VideoApplyStep = { step: string; ok: boolean; skipped?: "already_in_playlist" | "stream_stopped" | "broadcast_replaced" | "fields_failed"; error?: string };
export type VideoApplyResult = { broadcastId: string; ok: boolean; steps: VideoApplyStep[]; notApplied?: "module_unavailable" };

/** A playlist add YouTube refused once is tried once more after this pause (spike C: a 409 right after the playlist changed). */
export const PLAYLIST_RETRY_DELAY_MS = 2_000;

/**
 * The `videos.update` patch for the saved settings: what is set is sent, an empty text or list is not (never "empty means delete",
 * AGENTS.md §F). The booleans and the licence always have a value. Title, description and privacy are the broadcast's own and are
 * kept by video-details' merge onto a fresh read.
 */
export function buildVideoPatch(settings: LiveVideoSettings, channelLanguage: string | null): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    license: settings.license,
    publicStatsViewable: settings.publicStatsViewable,
    // video-details refuses a status write without it: YouTube never returns it, so leaving it out would reset it.
    containsSyntheticMedia: settings.containsSyntheticMedia,
    paidProductPlacement: settings.paidProductPlacement,
    // Spike C: the video's `embeddable` and the broadcast's `enableEmbed` are one flag. The status part is sent whole, so the
    // owner's choice is sent explicitly -- a read made seconds after the insert may still show the old value (review).
    embeddable: settings.broadcast.enableEmbed,
  };
  if (settings.tags.length > 0) patch.tags = settings.tags;
  if (settings.categoryId) patch.categoryId = settings.categoryId;
  // Owner, Telegram msg 3153 (option а): the title/description language is always the channel's baseline (Batches align every
  // video to it, PROJECT_SPEC §14 / FO-REQ-0022) -- never the stream's own field, so the two writers cannot undo each other.
  if (channelLanguage) patch.defaultLanguage = channelLanguage;
  if (settings.defaultAudioLanguage) patch.defaultAudioLanguage = settings.defaultAudioLanguage;
  if (settings.recordingDate) patch.recordingDate = settings.recordingDate;
  return patch;
}

/** BL-207: the translations step's units when a set is stored -- 1 fresh read + 50 for the update + 1 read-back (more only while
 * YouTube still reads back something else). */
export const LOCALIZATIONS_STEP_UNITS = 1 + 50 + 1;

/** What applying would send, and its quota units: 1 read + 50 for the update (+ up to 3 read-back reads), 50 for the thumbnail,
 * and per playlist 1 read for its owner, 1 for its items and 50 for the insert; + 1 identity read for the fresh credentials the
 * thumbnail and playlist steps use (2026-10-20). BL-207: with stored translations, their languages and step units. */
export function describeVideoApply(
  settings: LiveVideoSettings,
  channelLanguage: string | null,
  localizationLanguages: readonly string[] = []
): { patch: Record<string, unknown>; thumbnail: boolean; playlists: Array<{ id: string; title: string }>; units: number; localizations?: string[] } {
  const thumbnail = settings.thumbnail !== null;
  const translated = localizationLanguages.length > 0;
  return {
    patch: buildVideoPatch(settings, channelLanguage),
    thumbnail,
    playlists: settings.playlists,
    units: 1 + 50 + 1 + (thumbnail ? 50 : 0) + settings.playlists.length * 52 + (thumbnail || settings.playlists.length > 0 ? 1 : 0) + (translated ? LOCALIZATIONS_STEP_UNITS : 0),
    ...(translated ? { localizations: [...localizationLanguages] } : {}),
  };
}

/** The snippet values the fields step sends, which the translations step's fresh read must show before it sends the snippet back. */
function expectedSnippet(patch: Record<string, unknown>): Record<string, unknown> {
  const expected: Record<string, unknown> = {};
  for (const field of ["tags", "categoryId", "defaultLanguage", "defaultAudioLanguage"]) if (field in patch) expected[field] = patch[field];
  return expected;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function applyVideoSettings(
  deps: VideoApplyDependencies,
  args: {
    channelId: string;
    broadcastId: string;
    credentialRef: unknown;
    credentials: ResolvedCredentials;
    settings: LiveVideoSettings;
    channelLanguage: string | null;
    trigger: "start" | "again" | "segment";
    /** BL-207: the stream's stored translations (one set for every broadcast and segment); absent or none = no step. */
    localizations?: StoredLocalizations;
  }
): Promise<VideoApplyResult> {
  const { channelId, broadcastId, settings } = args;
  const steps: VideoApplyStep[] = [];
  const record = async (step: VideoApplyStep) => {
    steps.push(step);
    await deps.event(channelId, "video_settings_step", { broadcastId, ...step });
  };

  if (!deps.videoFields) {
    const result: VideoApplyResult = { broadcastId, ok: false, steps, notApplied: "module_unavailable" };
    await deps.event(channelId, "video_settings_applied", { ...result, trigger: args.trigger });
    return result;
  }

  // 1. The video's fields: one videos.update through video-details (identity, backup, merge onto a fresh read, read-back).
  const patch = buildVideoPatch(settings, args.channelLanguage);
  let fieldsOk = false;
  try {
    const { verified } = await deps.videoFields.apply({ credentialRef: args.credentialRef, channelId, videoId: broadcastId, patch });
    fieldsOk = verified;
    await record(verified ? { step: "fields", ok: true } : { step: "fields", ok: false, error: "YouTube reads back something else" });
  } catch (error) {
    await record({ step: "fields", ok: false, error: message(error) });
  }

  // Stopped meanwhile (the owner's Stop ended the broadcast): the rest is not sent.
  const stillCurrent = async (step: string) => {
    const state = await deps.isCurrent(channelId, broadcastId);
    if (state === "current") return true;
    await record({ step, ok: true, skipped: state === "replaced" ? "broadcast_replaced" : "stream_stopped" });
    return false;
  };

  // Resolved once, right before the first step that needs it (one identity read per run, as the preview counts).
  let freshCredentials: Promise<ResolvedCredentials> | null = null;
  const fresh = () => (freshCredentials ??= deps.credentials ? deps.credentials() : Promise.resolve(args.credentials));

  // 1b. BL-207: the stream's translations, only after the fields were written and read back (its snippet is sent whole, from a
  // fresh read that must show them). No stored set: no step and no call (like a thumbnail never chosen).
  const stored = args.localizations;
  if (stored && !stored.ok) {
    await record({ step: "localizations", ok: false, error: `${stored.problem}. Save the stream's translations again.` });
  } else if (stored?.set) {
    const set = stored.set;
    if (!fieldsOk) {
      await record({ step: "localizations", ok: true, skipped: "fields_failed" });
    } else if (await stillCurrent("localizations")) {
      if (!deps.localizations) {
        await record({ step: "localizations", ok: false, error: "The translations cannot be written here (the live translations module is not available)" });
      } else {
        try {
          const result = await deps.localizations.apply({ credentialRef: args.credentialRef, channelId, videoId: broadcastId, localizations: set, expected: expectedSnippet(patch) });
          // Whether a live broadcast's video reads its localizations back is unverified (plan §3): the detail says what differs.
          await record(result.verified ? { step: "localizations", ok: true } : { step: "localizations", ok: false, error: `YouTube reads back something else: ${result.detail}` });
        } catch (error) {
          await record({ step: "localizations", ok: false, error: message(error) });
        }
      }
    }
  }

  // 2. The thumbnail, only the file the settings name (its SHA-256 must still match: a changed file is not sent unseen).
  if (settings.thumbnail && (await stillCurrent("thumbnail"))) {
    try {
      const file = await deps.thumbnails.read(channelId);
      if (!file) throw new Error("The thumbnail file is missing on this computer: choose it again in the settings");
      const sha256 = createHash("sha256").update(file.bytes).digest("hex");
      if (sha256 !== settings.thumbnail.sha256) throw new Error("The thumbnail file changed since it was chosen: choose it again in the settings");
      await deps.youtube.setThumbnail(await fresh(), broadcastId, { mimeType: file.kind === "png" ? "image/png" : "image/jpeg", bytes: Buffer.from(file.bytes) });
      await record({ step: "thumbnail", ok: true });
    } catch (error) {
      await record({ step: "thumbnail", ok: false, error: message(error) });
    }
  }

  // 3. The playlists: skipped when the video is already there (Apply again must not add it twice); one retry on a refusal.
  for (const playlist of settings.playlists) {
    const step = `playlist:${playlist.id}`;
    if (!(await stillCurrent(step))) continue;
    try {
      const credentials = await fresh();
      if (await deps.youtube.playlistHasVideo(credentials, playlist.id, broadcastId)) {
        await record({ step, ok: true, skipped: "already_in_playlist" });
        continue;
      }
      let outcome = await deps.videoFields.addToPlaylist({ credentialRef: args.credentialRef, channelId, playlistId: playlist.id, videoId: broadcastId });
      if (!outcome.added) {
        await deps.sleep(PLAYLIST_RETRY_DELAY_MS);
        // A refused call may still have landed (a timeout): look again before retrying, so the video is never added twice.
        if (await deps.youtube.playlistHasVideo(credentials, playlist.id, broadcastId)) {
          outcome = { added: true };
        } else {
          outcome = await deps.videoFields.addToPlaylist({ credentialRef: args.credentialRef, channelId, playlistId: playlist.id, videoId: broadcastId });
        }
      }
      await record(outcome.added ? { step, ok: true } : { step, ok: false, error: outcome.reason ?? "YouTube refused the playlist item" });
    } catch (error) {
      await record({ step, ok: false, error: message(error) });
    }
  }

  const result: VideoApplyResult = { broadcastId, ok: steps.every((s) => s.ok), steps };
  await deps.event(channelId, "video_settings_applied", { ...result, trigger: args.trigger });
  return result;
}
