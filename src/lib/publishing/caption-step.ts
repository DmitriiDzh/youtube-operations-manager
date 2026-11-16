import { isDomainError } from "@/lib/shared-domain";
import type { CaptionActor, CaptionWriteInput, CaptionWriteResult } from "@/lib/video-captions";
import type { UploadRunnerDeps } from "./upload-runner";

// BL-269 (VIDEO_CAPTIONS_PLAN.md §3.3, ADR 0074 §7): the upload runner's `writeCaptions` -- the package's caption file read once from
// the workspace, handed to the captions writer (never an overwrite), and the writer's result mapped to the step's outcome. Kept free
// of the database so the real mapping is tested with the real writer (independent review #1); `index.ts` only injects the deps.

/** The captions writer's refusals that end the upload's captions step as `refused` (never retried by themselves). */
export const CAPTION_STEP_REFUSALS = new Set<string>([
  "captions_invalid",
  "captions_missing",
  "captions_foreign_track",
  "captions_own_track_differs",
  "captions_track_ambiguous",
  "captions_track_forced",
  "captions_track_draft",
  "captions_scope_missing",
  "video_not_in_channel",
  "validation_failed",
]);

export type CaptionStepOutcome = "verified" | "already_present" | "pending" | "mismatch";

/**
 * The step's outcome from the writer's result. Only a track YouTube serves passes (`verified` after a write or adoption,
 * `already_present` when the app's own track from this file was already there); a track still `syncing` is `pending` (read again
 * later); anything else -- `failed`, another status, a changed track -- is `mismatch`, and the date is withheld (R3).
 */
export function captionStepOutcome(result: Pick<CaptionWriteResult, "alreadyPresent" | "verified" | "pending">): CaptionStepOutcome {
  if (result.verified === true) return result.alreadyPresent ? "already_present" : "verified";
  return result.pending ? "pending" : "mismatch";
}

export type CaptionStepDeps = {
  files: {
    resolve(channelId: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
    readChunk(path: string, start: number, length: number): Promise<Buffer>;
  };
  /** The captions writer, with the runner's attempt mark (persisted before the insert). */
  write(input: CaptionWriteInput, actor: CaptionActor, attempt: { mark(trackIdsBefore: string[]): Promise<void> }): Promise<CaptionWriteResult>;
};

export const CAPTIONS_FILE_MAX_BYTES = 10 * 1024 * 1024;

export function createCaptionStepWriter(deps: CaptionStepDeps): NonNullable<UploadRunnerDeps["writeCaptions"]> {
  return async ({ channelId, videoId, video, uploadId, captions, frameFallback, ownTracks, adoptAfterAttempt, onAttempt, credentialRef }) => {
    const file = await deps.files.resolve(channelId, captions.file);
    if (!file) return { outcome: "refused", code: "captions_missing", detail: `${captions.file} is not in the channel's workspace.` };
    if (file.bytes === 0 || file.bytes > CAPTIONS_FILE_MAX_BYTES) return { outcome: "refused", code: "captions_invalid", detail: `size ${file.bytes} bytes` };
    const bytes = await deps.files.readChunk(file.path, 0, file.bytes);
    try {
      const result = await deps.write(
        {
          channelId,
          videoId,
          video,
          file: { name: captions.file.slice(captions.file.lastIndexOf("/") + 1), bytes },
          language: captions.language,
          name: captions.name,
          sha256: captions.sha256,
          // The cues were checked against the video's duration when the package was queued (the scan); not again here.
          durationSeconds: null,
          ownTracks,
          frameFallback,
          adoptAfterAttempt,
        },
        { kind: "upload", uploadId, userId: credentialRef.userId },
        { mark: (trackIdsBefore) => onAttempt(trackIdsBefore) }
      );
      return { outcome: captionStepOutcome(result), trackId: result.trackId as string, trackName: result.trackName, detail: result.verificationDetail };
    } catch (error) {
      // A refusal is the step's outcome (shown with the job, the date withheld); a pause or an unknown answer goes to the runner.
      if (isDomainError(error) && CAPTION_STEP_REFUSALS.has(error.code)) {
        const reason = (error.details as { reason?: unknown } | undefined)?.reason;
        return { outcome: "refused", code: typeof reason === "string" ? `${error.code}:${reason}` : error.code, detail: error.message };
      }
      throw error;
    }
  };
}
