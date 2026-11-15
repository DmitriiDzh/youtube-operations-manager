import { createHash } from "node:crypto";
import {
  DomainError,
  THUMBNAIL_REPLACE_MAX_BYTES,
  THUMBNAIL_REPLACE_UNITS,
  type ThumbnailActor,
  type ThumbnailReplaceInput,
  type ThumbnailReplaceResult,
  type VideoThumbnailState,
  type VideoThumbnailsDeps,
} from "./contracts";

const VIDEOS_FOLDER = "04 Videos";

/** ADR 0069 §2: a path relative to the workspace, under `04 Videos/`, naming a .jpg/.jpeg/.png, with no empty, "." or ".." part. */
export function isThumbnailCandidatePath(value: string): boolean {
  if (!value.startsWith(`${VIDEOS_FOLDER}/`) || value.includes("\\") || !/\.(jpe?g|png)$/i.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The largest size YouTube lists (maxres > standard > high > medium > default), for the backup image and the summaries. */
export function largestThumbnail(thumbnails: VideoThumbnailState["thumbnails"]): { size: string; url: string } | null {
  for (const size of ["maxres", "standard", "high", "medium", "default"]) {
    const entry = thumbnails[size];
    if (entry?.url) return { size, url: entry.url };
  }
  const first = Object.entries(thumbnails).find(([, entry]) => entry?.url);
  return first ? { size: first[0], url: first[1].url } : null;
}

function invalidFile(path: string, reason: string): DomainError {
  return new DomainError({ code: "thumbnail_file_invalid", message: `The thumbnail file cannot be used (${reason}).`, details: { path, reason } });
}

function actorDetail(actor: ThumbnailActor): Record<string, unknown> {
  return actor.kind === "owner" ? { actor: "owner", userId: actor.userId } : { actor: "producer", tokenId: actor.tokenId };
}

export function createVideoThumbnailsServices(deps: VideoThumbnailsDeps) {
  /**
   * ADR 0069 §3/§4: validation → video read and ownership → pending upload step → (dry run stops here) → backup → identity →
   * the one write (Live writes inside the adapter, immediately before the gateway) → read-back → audit → stored copy.
   */
  async function replace(input: ThumbnailReplaceInput, actor: ThumbnailActor): Promise<ThumbnailReplaceResult> {
    const { channelId, videoId, path } = input;
    const dryRun = input.dryRun === true;
    if (!isThumbnailCandidatePath(path)) throw invalidFile(path, "not a .jpg/.png under 04 Videos/");
    const file = await deps.readFile(channelId, path);
    if (!file) throw invalidFile(path, "not found, or not a JPEG/PNG image");
    if (file.contentType !== "image/jpeg" && file.contentType !== "image/png") throw invalidFile(path, "not a JPEG/PNG image");
    if (file.bytes.length > THUMBNAIL_REPLACE_MAX_BYTES) throw invalidFile(path, `larger than ${THUMBNAIL_REPLACE_MAX_BYTES} bytes`);
    const contentType = file.contentType;
    const bytes = Buffer.from(file.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const creds = await deps.credentials(channelId, actor);
    const before = await deps.readVideo(creds.credentials, videoId);
    if (!before || before.channelId !== channelId) {
      throw new DomainError({ code: "video_not_in_channel", message: `YouTube does not return video ${videoId} for channel ${channelId}.`, details: { videoId, channelId } });
    }
    if (await deps.uploadThumbnailStepPending(channelId, videoId)) {
      throw new DomainError({
        code: "thumbnail_step_pending",
        message: "This computer's upload of the video has not set its own thumbnail yet; it would replace the new one. Try again once it has.",
        details: { videoId },
      });
    }
    const largest = largestThumbnail(before.thumbnails);
    const summary = (state: VideoThumbnailState) => ({
      hasCustomThumbnail: state.hasCustomThumbnail,
      privacyStatus: state.privacyStatus,
      publishAt: state.publishAt,
      url: largestThumbnail(state.thumbnails)?.url ?? null,
    });
    const result: ThumbnailReplaceResult = {
      channelId,
      videoId,
      path,
      dryRun,
      file: { bytes: bytes.length, contentType, sha256 },
      before: summary(before),
      units: THUMBNAIL_REPLACE_UNITS,
      written: false,
      backupPath: null,
      verified: null,
      verificationDetail: null,
      after: null,
    };
    if (dryRun) return result;

    // Backup first: a backup that cannot be taken stops the write (AGENTS.md §G).
    const health = await deps.backup.checkInfrastructureHealth();
    if (!health.healthy) throw new DomainError({ code: "backup_item_failed", message: `Backup storage is unavailable: ${health.error}`, details: { videoId } });
    const image = largest ? await deps.downloadImage(largest.url) : null;
    const operationId = deps.newOperationId();
    const record = await deps.backup.captureBackup({
      channelId,
      operationId,
      videoId,
      snapshot: {
        kind: "video_thumbnail",
        thumbnails: before.thumbnails,
        hasCustomThumbnail: before.hasCustomThumbnail,
        image: largest && image ? { size: largest.size, url: largest.url, contentType: image.contentType, base64: image.bytes.toString("base64") } : null,
      },
    });
    result.backupPath = record.path;
    const base = { source: "video_thumbnails", operationId, path, sha256, ...actorDetail(actor) };
    await deps.audit({ channelId, videoId, eventType: "BACKUP", detail: { event: "video_thumbnails.backup", ...base, backupPath: record.path, imageSaved: image !== null } });

    await deps.assertWriteChannel({ channelId, ...creds });
    try {
      await deps.setThumbnail(creds.credentials, videoId, { mimeType: contentType, bytes });
    } catch (error) {
      await deps.audit({ channelId, videoId, eventType: "RESULT", detail: { event: "video_thumbnails.replace_failed", ...base, error: error instanceof Error ? error.message.slice(0, 500) : String(error) } });
      throw error;
    }
    result.written = true;
    await deps.audit({ channelId, videoId, eventType: "RESULT", detail: { event: "video_thumbnails.replaced", ...base, bytes: bytes.length, contentType } });

    // Read-back: a custom thumbnail, and privacy / publishAt as before (thumbnails.set changes nothing else).
    const after = await deps.readVideo(creds.credentials, videoId).catch(() => null);
    const problems: string[] = [];
    if (!after) problems.push("video not returned on read-back");
    else {
      if (after.hasCustomThumbnail !== true) problems.push(`hasCustomThumbnail is ${String(after.hasCustomThumbnail)}`);
      if (after.privacyStatus !== before.privacyStatus) problems.push(`privacy ${String(before.privacyStatus)} → ${String(after.privacyStatus)}`);
      if (after.publishAt !== before.publishAt) problems.push(`publishAt ${String(before.publishAt)} → ${String(after.publishAt)}`);
    }
    result.after = after ? summary(after) : null;
    result.verified = problems.length === 0;
    result.verificationDetail = problems.length === 0 ? null : problems.join("; ");
    await deps.audit({ channelId, videoId, eventType: "VERIFICATION", detail: { event: "video_thumbnails.verification", ...base, verified: result.verified, detail: result.verificationDetail } });
    if (after) await deps.storeThumbnails(channelId, videoId, after.thumbnails).catch(() => undefined);
    return result;
  }

  return { replace };
}

export type VideoThumbnailsServices = ReturnType<typeof createVideoThumbnailsServices>;
