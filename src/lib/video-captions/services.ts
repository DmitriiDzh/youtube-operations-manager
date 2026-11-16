import { CAPTIONS_LANGUAGE, CAPTIONS_MAX_BYTES, CAPTIONS_MIME_TYPE, captionNameProblem, checkCaptionFile, isEnglishLanguage } from "./caption-file";
import {
  CAPTIONS_DRY_RUN_UNITS,
  CAPTIONS_INSERT_UNITS,
  CAPTIONS_OVERWRITE_UNITS,
  CAPTIONS_REREAD_DELAY_MS,
  DomainError,
  isDomainError,
  type CaptionActor,
  type CaptionTrackSummary,
  type CaptionWriteInput,
  type CaptionWriteResult,
  type VideoCaptionTrack,
  type VideoCaptionsDeps,
  wasCaptionWriteNotSent,
} from "./contracts";
import { sha256Hex } from "./hash";

// BL-269 (VIDEO_CAPTIONS_PLAN.md §3.2, §3.7; ADR 0074 §4, §6, §10): the one place a caption track is written. Order: validation (the
// very bytes re-hashed and re-parsed, the channel's switch read now) → device gate (owner / Producer) → credentials (force-ssl) →
// video read (exists, the channel's, horizontal) → track list and the decision by language → quota guard → (dry run stops here) →
// backup (an overwrite also downloads the track it replaces: no backup, no write) → identity check → attempt mark (runner) → the
// one write (Live writes inside the adapter) → read-back → audit. A failure after the write is reported as written, never as "not
// written".

const refuse = (code: string, message: string, details: Record<string, unknown> = {}) => new DomainError({ code: code as never, message, details });
const invalid = (reason: string, message: string, details: Record<string, unknown> = {}) => refuse("captions_invalid", message, { reason, ...details });

const kindOf = (track: VideoCaptionTrack) => (track.trackKind ?? "").toLowerCase();
/** ASR tracks are never touched and never block (ADR 0074 §4). */
const isAsr = (track: VideoCaptionTrack) => kindOf(track) === "asr";

function actorDetail(actor: CaptionActor): Record<string, unknown> {
  if (actor.kind === "upload") return { actor: "upload", uploadId: actor.uploadId };
  if (actor.kind === "owner") return { actor: "owner", userId: actor.userId };
  return { actor: "producer" };
}

const timeOf = (value: string | null) => (value ? Date.parse(value) : Number.NaN);

/**
 * The runner's lost-answer rule (§3.3, review #3): a `standard` English track with exactly the package's name that was not listed
 * before the attempt -- and, for a mark from an earlier run, last updated at or after that mark (an unknown time: not adopted).
 * A foreign track of the same name ("" is normal) added before the mark is never taken.
 */
function adoptable(track: VideoCaptionTrack, name: string, before: ReadonlySet<string>, sinceMs: number | null): boolean {
  if (!isEnglishLanguage(track.language) || kindOf(track) !== "standard" || track.name !== name || before.has(track.id)) return false;
  if (sinceMs === null) return true;
  const updated = timeOf(track.lastUpdated);
  return Number.isFinite(updated) && Number.isFinite(sinceMs) && updated >= sinceMs;
}

export function createVideoCaptionsServices(deps: VideoCaptionsDeps) {
  /** The status part of a read-back: serving is verified; syncing is pending; failed is not verified. */
  function statusProblem(track: VideoCaptionTrack): { problem: string | null; pending: boolean } {
    const status = (track.status ?? "").toLowerCase();
    if (status === "serving") return { problem: null, pending: false };
    if (status === "syncing") return { problem: "YouTube is still processing the track (syncing)", pending: true };
    if (status === "failed") return { problem: `YouTube failed to process the track${track.failureReason ? ` (${track.failureReason})` : ""}`, pending: false };
    return { problem: `track status ${track.status ?? "unknown"}`, pending: false };
  }

  async function write(input: CaptionWriteInput, actor: CaptionActor): Promise<CaptionWriteResult> {
    const { channelId, videoId } = input;
    const dryRun = input.dryRun === true;
    const overwrite = input.overwrite === true;
    if (overwrite && actor.kind === "upload") throw refuse("validation_failed", "The upload step never overwrites a caption track (owner msg 4660: only an explicit owner or Producer action does).");

    // 1. Validation of the very bytes that will be sent.
    const bytes = Buffer.from(input.file.bytes);
    if (bytes.length === 0 || bytes.length > CAPTIONS_MAX_BYTES) throw invalid("size", `The captions file must be 1 byte to ${CAPTIONS_MAX_BYTES} bytes.`, { bytes: bytes.length });
    const sha256 = sha256Hex(bytes);
    if (sha256 !== input.sha256.toLowerCase()) throw invalid("sha256", "The captions file does not match the SHA-256 its package states.", { expected: input.sha256, actual: sha256 });
    const check = checkCaptionFile(bytes, input.file.name, input.durationSeconds);
    if (!check.ok) throw invalid("format", `The captions file is not valid SubRip or WebVTT (${check.detail}).`, { detail: check.detail });
    if (input.language !== CAPTIONS_LANGUAGE) throw invalid("language", `Only English captions ("en") are written, not "${input.language}".`, { language: input.language });
    const nameProblem = captionNameProblem(input.name);
    if (nameProblem) throw invalid("name", `The caption track name is not allowed (${nameProblem}).`, { detail: nameProblem });
    if (input.video.startsWith("S")) throw invalid("not_horizontal", "Captions are only for horizontal long videos, never a Short.");
    if (!(await deps.captionsEnabled(channelId))) throw invalid("channel_disabled", "Captions are off for this channel (Content → publishing defaults).");

    // 2. Never during a device handoff or in recovery mode (the owner's and the Producer's paths; the runner has its own lease).
    if (!dryRun && actor.kind !== "upload") await deps.assertDeviceAvailable();

    let creds;
    try {
      creds = await deps.credentials(channelId, actor);
    } catch (error) {
      if (isDomainError(error) && error.code === "AUTH_SCOPE_INSUFFICIENT") {
        throw refuse("captions_scope_missing", "The channel's Google grant lacks youtube.force-ssl, which captions need: reconnect the channel (Settings → Channels).", { channelId });
      }
      throw error;
    }

    // 3. The video: the channel's own, horizontal (YouTube's stored frame; else what this computer last knew; neither: refused).
    const video = await deps.readVideo(creds.credentials, videoId);
    if (!video || video.channelId !== channelId) throw refuse("video_not_in_channel", `YouTube does not return video ${videoId} for channel ${channelId}.`, { videoId, channelId });
    const orientation = video.frame ? (video.frame.height > video.frame.width ? "vertical" : "horizontal") : (input.frameFallback ?? null);
    if (orientation === "vertical") throw invalid("not_horizontal", "Captions are only for horizontal long videos; this video is vertical.");
    if (orientation === null) throw invalid("orientation_unknown", "The video's frame is not known (YouTube gave none, and this computer never read it).");

    // 4. The tracks, decided by language (never by name).
    const tracks = await deps.listTracks(creds.credentials, videoId);
    const own = new Map(input.ownTracks.map((t) => [t.trackId, t.sha256.toLowerCase()]));
    const english = tracks.filter((t) => isEnglishLanguage(t.language) && !isAsr(t));
    const summary = (t: VideoCaptionTrack): CaptionTrackSummary => ({ trackId: t.id, language: t.language, name: t.name, trackKind: t.trackKind, lastUpdated: t.lastUpdated, ours: own.has(t.id) });
    const result: CaptionWriteResult = {
      channelId,
      videoId,
      dryRun,
      mode: "insert",
      units: dryRun ? CAPTIONS_DRY_RUN_UNITS : CAPTIONS_INSERT_UNITS,
      file: { bytes: bytes.length, sha256, format: check.format },
      target: null,
      englishTracks: english.map(summary),
      written: false,
      adopted: false,
      trackId: null,
      trackName: null,
      alreadyPresent: false,
      backupPath: null,
      verified: null,
      verificationDetail: null,
      pending: false,
      writeUnits: CAPTIONS_INSERT_UNITS,
    };
    const base = { source: "video_captions", channelId, videoId, video: input.video, sha256, fileName: input.file.name, overwrite, ...actorDetail(actor) };

    // The runner's lost-answer rule: a standard English track with the package's name that was not there before the earlier attempt.
    if (input.adoptAfterAttempt && !overwrite) {
      const before = new Set(input.adoptAfterAttempt.trackIdsBefore);
      const since = Date.parse(input.adoptAfterAttempt.at);
      const found = english.find((t) => adoptable(t, input.name, before, since));
      if (found) return finishAdopted(found, tracks, input, result, base, creds.credentials);
    }

    const same = english.find((t) => own.get(t.id) === sha256);
    let target: VideoCaptionTrack | null = null;
    if (!overwrite) {
      if (same) return alreadyPresent(same, result);
      if (english.length > 0) {
        if (english.some((t) => own.has(t.id))) {
          throw refuse("captions_own_track_differs", "The video already has the app's English caption track, made from another file; only an explicit overwrite replaces it.", { tracks: result.englishTracks });
        }
        throw refuse("captions_foreign_track", "The video already has an English caption track the app did not add; nothing was written (an explicit overwrite may replace it).", { tracks: result.englishTracks });
      }
    } else if (english.length > 1) {
      throw refuse("captions_track_ambiguous", "The video has more than one English caption track; the app does not know which one to replace.", { tracks: result.englishTracks });
    } else if (english.length === 1) {
      const only = english[0];
      if (own.get(only.id) === sha256) return alreadyPresent(only, result);
      if (kindOf(only) === "forced") throw refuse("captions_track_forced", "The video's only English track is a forced-captions track; it is not replaced.", { tracks: result.englishTracks });
      if (kindOf(only) !== "standard") throw refuse("captions_track_ambiguous", `The video's English track is of kind ${only.trackKind ?? "unknown"}; it is not replaced.`, { tracks: result.englishTracks });
      if (only.isDraft === true) throw refuse("captions_track_draft", "The video's English caption track is a draft; it is not replaced.", { tracks: result.englishTracks });
      target = only;
      result.mode = "update";
      result.target = summary(only);
      result.writeUnits = CAPTIONS_OVERWRITE_UNITS;
      if (!dryRun) result.units = CAPTIONS_OVERWRITE_UNITS;
    }
    // The owner's apply names what his preview showed: the track to be replaced (null: an insert). Anything else now refuses.
    if (input.expectedTrackId !== undefined && (target?.id ?? null) !== input.expectedTrackId) {
      throw refuse("captions_track_changed", "The video's caption tracks changed since the preview; preview again.", { expected: input.expectedTrackId, now: target?.id ?? null });
    }

    // 5. The quota guard (a short pool is a pause for the runner, a refusal here; unknown is not judged -- YouTube's own answer still is).
    if (!dryRun) {
      const verdict = await deps.checkUnits(result.writeUnits);
      if (verdict.decision === "insufficient") {
        throw refuse("youtube_quota_exceeded", `Not enough of today's YouTube quota is left for the captions (${result.writeUnits} units).`, { estimatedUnits: result.writeUnits, remainingUnits: verdict.remainingUnits ?? null, resetsAt: verdict.resetsAt ?? null });
      }
    }
    // 6. The dry run stops here: every read and check, no download, no backup, no write.
    if (dryRun) return result;

    // 7. Backup first: the track list and the bytes to send; an overwrite also the replaced track's current content.
    const health = await deps.backup.checkInfrastructureHealth();
    if (!health.healthy) throw refuse("backup_item_failed", `Backup storage is unavailable: ${health.error}`, { videoId });
    let replacedContent: Buffer | null = null;
    if (target) {
      try {
        replacedContent = await deps.downloadTrack(creds.credentials, target.id);
      } catch (error) {
        throw refuse("backup_item_failed", "The current caption track could not be downloaded for the backup; nothing was written.", {
          videoId,
          trackId: target.id,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
      if (replacedContent.length === 0) throw refuse("backup_item_failed", "The current caption track downloaded empty; nothing was written.", { videoId, trackId: target.id });
    }
    const operationId = deps.newOperationId();
    const record = await deps.backup.captureBackup({
      channelId,
      operationId,
      videoId,
      snapshot: {
        kind: "video_captions",
        mode: target ? "update" : "insert",
        tracks: tracks.map((t) => ({ id: t.id, language: t.language, name: t.name, trackKind: t.trackKind, isDraft: t.isDraft, status: t.status, lastUpdated: t.lastUpdated })),
        sending: { fileName: input.file.name, sha256, base64: bytes.toString("base64") },
        replaced: target && replacedContent ? { trackId: target.id, language: target.language, name: target.name, lastUpdated: target.lastUpdated, base64: replacedContent.toString("base64") } : null,
      },
    });
    result.backupPath = record.path;
    const audited = { ...base, operationId, mode: result.mode, ...(target ? { trackId: target.id, previousLastUpdated: target.lastUpdated } : {}) };
    await deps.audit({ channelId, videoId, eventType: "BACKUP", detail: { event: "video_captions.backup", ...audited, backupPath: record.path } });

    // 8. Identity, then (insert) the attempt mark, then the one write -- Live writes is checked inside, immediately before it.
    await deps.assertWriteChannel({ channelId, ...creds });
    const media = { mimeType: CAPTIONS_MIME_TYPE, bytes };
    let trackId: string;
    let marked = false;
    try {
      if (target) {
        await deps.update(creds.credentials, { trackId: target.id, media });
        trackId = target.id;
      } else {
        if (actor.kind === "upload") {
          await deps.markAttempt({ channelId, videoId, trackIdsBefore: tracks.map((t) => t.id) });
          marked = true;
        }
        trackId = (await deps.insert(creds.credentials, { videoId, language: CAPTIONS_LANGUAGE, name: input.name, media })).trackId;
      }
    } catch (error) {
      // Review #3: nothing was sent (the client or Live writes refused) -- the mark is taken back, so no later run adopts on it.
      if (marked && wasCaptionWriteNotSent(error)) await deps.clearAttempt({ channelId, videoId }).catch(() => undefined);
      // A 409 captionExists on the runner's insert (a lost answer): the track with this name is this upload's own -- adopted.
      if (!target && actor.kind === "upload" && isCaptionExists(error)) {
        const relisted = await deps.listTracks(creds.credentials, videoId);
        const before = new Set(tracks.map((t) => t.id));
        // This very call listed the tracks just before its insert: a track absent then is the lost answer's (no time rule needed).
        const found = relisted.find((t) => adoptable(t, input.name, before, null));
        if (found) return finishAdopted(found, relisted, input, result, base, creds.credentials);
      }
      await deps.audit({ channelId, videoId, eventType: "RESULT", detail: { event: "video_captions.write_failed", ...audited, error: error instanceof Error ? error.message.slice(0, 500) : String(error) } }).catch(() => undefined);
      throw error;
    }
    result.written = true;
    result.trackId = trackId;
    const quiet = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* the write happened: never reported as "not written" */
      }
    };
    await quiet(() => deps.audit({ channelId, videoId, eventType: "RESULT", detail: { event: target ? "video_captions.updated" : "video_captions.inserted", ...audited, trackId, bytes: bytes.length } }));

    // 9. Read-back.
    await readBack(result, { trackId, tracksBefore: tracks, target, expectedName: target ? target.name : input.name, expectedLanguage: target ? target.language : CAPTIONS_LANGUAGE }, creds.credentials);
    await quiet(() =>
      deps.audit({ channelId, videoId, eventType: "VERIFICATION", detail: { event: "video_captions.verification", ...audited, trackId, verified: result.verified, pending: result.pending, detail: result.verificationDetail } })
    );
    return result;
  }

  /** Already there (ours, same file): nothing is written; the track's own status is the verification. */
  function alreadyPresent(track: VideoCaptionTrack, result: CaptionWriteResult): CaptionWriteResult {
    const status = statusProblem(track);
    return { ...result, mode: "none", units: result.dryRun ? result.units : CAPTIONS_DRY_RUN_UNITS, alreadyPresent: true, trackId: track.id, trackName: track.name, verified: status.problem === null, verificationDetail: status.problem, pending: status.pending, writeUnits: 0 };
  }

  /** The lost-answer rule found this upload's own track: no write; read back like a fresh insert. */
  async function finishAdopted(
    track: VideoCaptionTrack,
    tracks: VideoCaptionTrack[],
    input: CaptionWriteInput,
    result: CaptionWriteResult,
    base: Record<string, unknown>,
    credentials: Parameters<VideoCaptionsDeps["listTracks"]>[0]
  ): Promise<CaptionWriteResult> {
    result.adopted = true;
    result.written = true;
    result.trackId = track.id;
    if (result.dryRun) return { ...result, verified: null };
    await readBack(result, { trackId: track.id, tracksBefore: tracks.filter((t) => t.id !== track.id), target: null, expectedName: input.name, expectedLanguage: CAPTIONS_LANGUAGE }, credentials);
    await deps
      .audit({ channelId: input.channelId, videoId: input.videoId, eventType: "VERIFICATION", detail: { event: "video_captions.adopted_after_lost_answer", ...base, trackId: track.id, verified: result.verified, pending: result.pending, detail: result.verificationDetail } })
      .catch(() => undefined);
    return result;
  }

  /**
   * The read-back (`captions.list`): the track is there, its language and name as expected (an overwrite keeps the old ones), standard,
   * not a draft, serving (`syncing`: one bounded re-read); an overwrite's `lastUpdated` advanced; every other track as before.
   */
  async function readBack(
    result: CaptionWriteResult,
    args: { trackId: string; tracksBefore: VideoCaptionTrack[]; target: VideoCaptionTrack | null; expectedName: string | null; expectedLanguage: string | null },
    credentials: Parameters<VideoCaptionsDeps["listTracks"]>[0]
  ): Promise<void> {
    const once = async () => {
      const after = await deps.listTracks(credentials, result.videoId).catch(() => null);
      const problems: string[] = [];
      let pending = false;
      if (!after) return { problems: ["the caption tracks could not be read back"], pending, name: null as string | null };
      const track = after.find((t) => t.id === args.trackId);
      if (!track) return { problems: [`track ${args.trackId} is not listed`], pending, name: null };
      if (track.language !== args.expectedLanguage) problems.push(`language ${String(track.language)} (expected ${String(args.expectedLanguage)})`);
      if ((track.name ?? "") !== (args.expectedName ?? "")) problems.push(`name "${String(track.name)}" (expected "${String(args.expectedName)}")`);
      if (kindOf(track) !== "standard") problems.push(`trackKind ${String(track.trackKind)}`);
      if (track.isDraft === true) problems.push("the track is a draft");
      if (args.target) {
        const before = timeOf(args.target.lastUpdated);
        const now = timeOf(track.lastUpdated);
        if (Number.isFinite(before) && !(Number.isFinite(now) && now > before)) problems.push("YouTube still shows the previous version (lastUpdated unchanged)");
      }
      const status = statusProblem(track);
      if (status.problem) problems.push(status.problem);
      for (const old of args.tracksBefore) {
        if (old.id === args.trackId) continue;
        const still = after.find((t) => t.id === old.id);
        if (!still) problems.push(`track ${old.id} (${String(old.language)}) disappeared`);
        else if (still.language !== old.language || still.name !== old.name || still.lastUpdated !== old.lastUpdated) problems.push(`track ${old.id} (${String(old.language)}) changed`);
      }
      // Pending only when YouTube still processing the track is the SOLE problem -- after every other track was checked (review #4).
      pending = status.pending && problems.length === 1;
      return { problems, pending, name: track.name };
    };
    let outcome = await once();
    if (outcome.pending) {
      await deps.sleep(CAPTIONS_REREAD_DELAY_MS);
      outcome = await once();
    }
    result.trackName = outcome.name ?? result.trackName;
    result.verified = outcome.problems.length === 0;
    result.pending = outcome.pending;
    result.verificationDetail = outcome.problems.length === 0 ? null : outcome.problems.join("; ");
  }

  return { write };
}

/** YouTube's 409 `captionExists` (a track with the same language and name), whatever the error's shape. */
function isCaptionExists(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown; data?: { error?: { errors?: Array<{ reason?: unknown }> } } }; errors?: Array<{ reason?: unknown }> } | null;
  const reasons = [...(e?.response?.data?.error?.errors ?? []), ...(Array.isArray(e?.errors) ? e.errors : [])].map((x) => x?.reason);
  return reasons.includes("captionExists");
}

export type VideoCaptionsServices = ReturnType<typeof createVideoCaptionsServices>;
