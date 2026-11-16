import { DomainError, type DomainErrorCode } from "@/lib/shared-domain";
import type { CaptionActor, CaptionWriteInput, CaptionWriteResult } from "@/lib/video-captions";
import { CAPTIONS_MAX_BYTES, checkCaptionFile } from "@/lib/video-captions/caption-file";
import { sha256Hex } from "@/lib/video-captions/hash";
import { captionsProblems, type CaptionFacts, type ReleasePackage } from "./packages";

// BL-269 (VIDEO_CAPTIONS_PLAN.md §3.5, §3.7; ADR 0074 §8, §10; AGENTS.md §F captions writer): English captions onto a video a
// release package already put on YouTube -- the owner (Web UI) and the Producer (its own endpoint). Input is a package (channel +
// video code) whose upload record names the video; the captions come only from that package's CURRENT manifest (never a free path),
// the mp4 may be gone. `overwrite` (owner msg 4660) replaces the video's one English standard track. The write itself is the
// captions writer's (`src/lib/video-captions/`); this service adds what is package-driven: the package, the app's own tracks (the
// record and this computer's upload rows), the refusals, and afterwards the record and the upload rows.

const ACTIVE_UPLOAD = new Set(["queued", "uploading", "processing", "finishing", "paused"]);
const OWN_STEP_OUTCOMES = new Set(["verified", "already_present", "mismatch"]);

export type PackageCaptionsActor = { kind: "owner"; userId: string } | { kind: "producer" };

export type PackageCaptionsFound = { pkg: ReleasePackage; manifestSha256: string; manifestPath: string; folder: string; videoId: string | null };

export type PackageCaptionsDeps = {
  findPackage(channelId: string, video: string): Promise<PackageCaptionsFound | "not_found" | "no_workspace" | "workspace_unavailable" | "ambiguous">;
  /** This computer's upload rows of the channel's `video`. */
  uploadRows(channelId: string, video: string): Promise<Array<{ status: string; videoId: string | null; stepsJson: string }>>;
  /** A workspace file's bytes (the workspace rule), or null when it is not there; at most `maxBytes` read. */
  readFile(channelId: string, relativePath: string, maxBytes: number): Promise<Uint8Array | "too_large" | null>;
  /** The `captions` entries of the release's `Vn_youtube.json` (unreadable: none). */
  recordCaptions(channelId: string, recordPath: string): Promise<Array<{ trackId: string; sha256: string }>>;
  /** Read-modify-write of `Vn_youtube.json`: only `captions` changes (an entry of the same track id is replaced), atomically. */
  writeRecordCaptions(channelId: string, recordPath: string, entry: { trackId: string; language: string; name: string; sha256: string; at: string; by: "owner" | "producer" }): Promise<void>;
  /** The frame this computer last read for the video code (the scan's memo), or null. */
  frameMemo(channelId: string, video: string): Promise<"vertical" | "horizontal" | null>;
  /** The captions writer. */
  write(input: CaptionWriteInput, actor: CaptionActor): Promise<CaptionWriteResult>;
  /** After a verified write: upload rows of that video here whose captions step did not pass record it as done; returns how many. */
  markUploadCaptionsLater(channelId: string, videoId: string, track: { trackId: string; language: string; name: string; sha256: string }): Promise<number>;
  clock: { now(): Date };
};

export type PackageCaptionsResult = CaptionWriteResult & {
  video: string;
  manifestSha256: string;
  /** The record lists the track as the app's own now (after a write or an already-present track). */
  recorded: boolean;
  uploadStepsMarked: number;
};

const refuse = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });

export function createPackageCaptions(deps: PackageCaptionsDeps) {
  async function run(
    channelId: string,
    input: { video: string; overwrite?: boolean; dryRun?: boolean; expectedManifestSha256?: string; expectedTrackId?: string | null },
    actor: PackageCaptionsActor
  ): Promise<PackageCaptionsResult> {
    const video = input?.video;
    if (typeof video !== "string" || video.trim() === "") throw refuse("validation_failed", "video is required (e.g. V27)");
    const found = await deps.findPackage(channelId, video);
    if (found === "no_workspace") throw refuse("package_no_workspace", "This channel has no workspace folder on this computer.", { channelId });
    if (found === "workspace_unavailable") throw refuse("package_workspace_unavailable", "The channel's workspace cannot be used now.", { channelId });
    if (found === "ambiguous") throw refuse("validation_failed", `${video}: more than one package names this video.`, { channelId, video });
    if (found === "not_found") throw refuse("upload_package_not_ready", `${video}: no release package of this channel has this video number on this computer.`, { channelId, video });
    if (!found.videoId) throw refuse("package_metadata_not_uploaded", `${video} is not on YouTube yet (no upload record): its captions go up with the upload.`, { channelId, video });
    if (input.expectedManifestSha256 !== undefined && input.expectedManifestSha256 !== found.manifestSha256) {
      throw refuse("package_metadata_manifest_changed", `${video}'s package was re-packaged since the preview: preview it again.`, { expected: input.expectedManifestSha256, actual: found.manifestSha256 });
    }
    const captions = found.pkg.captions ?? [];
    if (captions.length === 0) throw refuse("captions_not_in_package", `${video}'s package states no captions.`, { channelId, video });
    // Refused while this computer's upload of the video still runs its steps (its record step would rewrite the record).
    const rows = await deps.uploadRows(channelId, video);
    if (rows.some((row) => ACTIVE_UPLOAD.has(row.status))) {
      throw refuse("captions_step_pending", `${video}'s upload on this computer has not finished its steps yet: add the captions after it is done.`, { channelId, video });
    }
    // The package's own captions checks on the files as they are now (the switch, the frame and the video are the writer's, read now).
    const caption = captions[0];
    const relative = `${found.folder}/${caption.file}`;
    const bytes = await deps.readFile(channelId, relative, CAPTIONS_MAX_BYTES);
    const facts: CaptionFacts[] = [
      bytes instanceof Uint8Array
        ? { file: caption.file, exists: true, sizeBytes: bytes.length, sha256: sha256Hex(bytes), check: checkCaptionFile(bytes, caption.file, found.pkg.durationSeconds) }
        : { file: caption.file, exists: bytes === "too_large", sizeBytes: bytes === "too_large" ? CAPTIONS_MAX_BYTES + 1 : null, sha256: null, check: null },
    ];
    const structural = captionsProblems(captions, facts, { captionsEnabled: true, video: found.pkg.video, orientation: "horizontal", durationSeconds: found.pkg.durationSeconds });
    if (structural.length > 0) {
      const first = structural[0];
      throw refuse(first.code as DomainErrorCode, `${video}'s captions cannot be written (${first.code}${first.params?.reason ? `: ${first.params.reason}` : ""}).`, { channelId, video, problems: structural, ...(first.params ?? {}) });
    }
    const recordPath = `${found.folder}/${found.pkg.video}_youtube.json`;
    const fromRecord = await deps.recordCaptions(channelId, recordPath).catch(() => []);
    const fromRows = rows
      .filter((row) => row.videoId === found.videoId)
      .map((row) => {
        try {
          const steps = JSON.parse(row.stepsJson) as { captions?: string; captionsTrack?: { trackId?: unknown; sha256?: unknown } };
          const track = steps.captionsTrack;
          return steps.captions && OWN_STEP_OUTCOMES.has(steps.captions) && typeof track?.trackId === "string" && typeof track.sha256 === "string" ? { trackId: track.trackId, sha256: track.sha256 } : null;
        } catch {
          return null;
        }
      })
      .filter((t): t is { trackId: string; sha256: string } => t !== null);
    // One entry per track id; the record (shared by both computers) is the later word over an older row.
    const own = new Map<string, string>();
    for (const t of [...fromRows, ...fromRecord]) own.set(t.trackId, t.sha256);
    const result = await deps.write(
      {
        channelId,
        videoId: found.videoId,
        video: found.pkg.video,
        file: { name: caption.file.slice(caption.file.lastIndexOf("/") + 1), bytes: bytes as Uint8Array },
        language: caption.language,
        name: caption.name,
        sha256: caption.sha256,
        // The mp4 may be gone (BL-238): the manifest's duration.
        durationSeconds: found.pkg.durationSeconds,
        ownTracks: [...own.entries()].map(([trackId, sha256]) => ({ trackId, sha256 })),
        frameFallback: await deps.frameMemo(channelId, found.pkg.video).catch(() => null),
        dryRun: input.dryRun === true,
        overwrite: input.overwrite === true,
        ...(input.expectedTrackId !== undefined ? { expectedTrackId: input.expectedTrackId } : {}),
      },
      actor
    );
    const out: PackageCaptionsResult = { ...result, video: found.pkg.video, manifestSha256: found.manifestSha256, recorded: false, uploadStepsMarked: 0 };
    if (result.dryRun || !result.trackId) return out;
    // The track is the app's own from now on (AC-CAP-37, AC-CAP-47): its id with the SHA-256 sent (an already-present one: as it was).
    const entry = { trackId: result.trackId, language: caption.language, name: result.trackName ?? caption.name, sha256: caption.sha256, at: deps.clock.now().toISOString(), by: actor.kind };
    if (result.written || own.get(result.trackId) !== caption.sha256) {
      try {
        await deps.writeRecordCaptions(channelId, recordPath, entry);
        out.recorded = true;
      } catch {
        out.recorded = false; // written on YouTube either way; the result says the record was not updated
      }
    } else out.recorded = true;
    if (result.verified) {
      out.uploadStepsMarked = await deps.markUploadCaptionsLater(channelId, found.videoId, entry).catch(() => 0);
    }
    return out;
  }

  return {
    /** The dry run: every read and check, the track an overwrite would replace, the units -- no download, backup or write. */
    preview(channelId: string, input: { video: string; overwrite?: boolean }, actor: PackageCaptionsActor) {
      return run(channelId, { video: input?.video, overwrite: input?.overwrite === true, dryRun: true }, actor);
    },
    /**
     * The write. The owner names what his preview showed (`expectedManifestSha256`, `expectedTrackId`: required); the Producer may pin
     * them too. `overwrite` replaces the one English standard track (owner msg 4660).
     */
    apply(channelId: string, input: { video: string; overwrite?: boolean; expectedManifestSha256?: string; expectedTrackId?: string | null }, actor: PackageCaptionsActor) {
      if (actor.kind === "owner") {
        if (typeof input?.expectedManifestSha256 !== "string" || input.expectedManifestSha256 === "") throw refuse("validation_failed", "expectedManifestSha256 is required: apply the package the preview showed");
        if (!("expectedTrackId" in (input ?? {})) || (input.expectedTrackId !== null && typeof input.expectedTrackId !== "string")) {
          throw refuse("validation_failed", "expectedTrackId is required (null when the preview showed no track to replace)");
        }
      }
      return run(channelId, { ...input, dryRun: false }, actor);
    },
  };
}

export type PackageCaptions = ReturnType<typeof createPackageCaptions>;
