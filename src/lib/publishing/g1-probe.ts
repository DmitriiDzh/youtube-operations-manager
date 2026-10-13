import { DomainError } from "@/lib/shared-domain";
import type {
  CredentialRef,
  G1DeleteReport,
  G1ProbeRecord,
  G1UploadInput,
  G1UploadReport,
  ResolvedCredentials,
  UploadProgress,
  VideoInsertResource,
  VideoUploadStateView,
} from "./contracts";

// ---------------------------------------------------------------------------
// BL-182 stage 0, the G1 probe (ADR 0037 §7; PUBLISHING_PLAN.md §2 stage 0). One private test upload to find out whether YouTube
// locks uploads from our Cloud project to private, then its deletion. The owner approved exactly this (Telegram msg 2702). Write
// safety (AGENTS.md §G): the device must not be in recovery mode; the identity check (`assertWriteChannel`) runs before any byte is
// sent; Live writes are re-checked before every gateway call (in the adapter); the result is audited; the read-back is reported. Only the video this
// probe uploaded can be deleted, and only once.
// ---------------------------------------------------------------------------

/** 8 MB: a multiple of 256 KB, small enough to re-send after a dropped connection. */
export const G1_CHUNK_BYTES = 32 * 256 * 1024;
const POLL_EVERY_MS = 10_000;
const POLL_FOR_MS = 5 * 60_000;
const TERMINAL_UPLOAD_STATUSES = new Set(["processed", "failed", "rejected", "deleted"]);
const TERMINAL_PROCESSING_STATUSES = new Set(["succeeded", "failed", "terminated"]);

export type G1ProbeDependencies = {
  assertDeviceAvailable(): Promise<void>;
  resolveWriteCredentials(credentialRef: CredentialRef): Promise<ResolvedCredentials>;
  assertWriteChannel(args: { credentialRef: CredentialRef; credentials: ResolvedCredentials; expectedChannelId: string }): Promise<void>;
  resolveFile(channelId: string, relativePath: string): Promise<{ path: string; bytes: number }>;
  readChunk(path: string, start: number, length: number): Promise<Buffer>;
  accessTokenOf(credentials: ResolvedCredentials): Promise<string>;
  /** Each write checks Live writes right before it (adapters/youtube-writes.ts). */
  gateway: {
    begin(args: { accessToken: string; resource: VideoInsertResource; contentLength: number; contentType: string; notifySubscribers: boolean }): Promise<{ sessionUri: string }>;
    putChunk(args: { accessToken: string; sessionUri: string; chunk: Buffer; start: number; total: number; contentType: string }): Promise<UploadProgress>;
    /** Where the session stands (a status query): after a lost answer, it tells whether YouTube has the whole video. */
    queryOffset(args: { accessToken: string; sessionUri: string; total: number }): Promise<UploadProgress>;
    deleteVideo(credentials: ResolvedCredentials, videoId: string): Promise<void>;
  };
  readState(credentials: ResolvedCredentials, videoId: string): Promise<VideoUploadStateView | null>;
  record: { get(): Promise<G1ProbeRecord | null>; save(record: G1ProbeRecord): Promise<void>; clear(): Promise<void> };
  /** Shown as soon as YouTube returns the id, before anything else can fail (review S3). */
  announce(videoId: string): void;
  audit(event: { channelId: string; videoId: string; detail: unknown }): Promise<void>;
  removeLocalVideoRow(channelId: string, videoId: string): Promise<boolean>;
  clock: { now(): Date };
  sleep(ms: number): Promise<void>;
};

function validateResource(resource: VideoInsertResource): void {
  const { title, description } = resource.snippet;
  if (!title || title.length > 100 || /[<>]/.test(title)) throw new DomainError({ code: "validation_failed", message: "The title must be 1-100 characters, without < or >." });
  if (Buffer.byteLength(description, "utf8") > 5000) throw new DomainError({ code: "validation_failed", message: "The description must be at most 5000 bytes." });
  if (resource.status.privacyStatus !== "private" || resource.status.publishAt !== undefined) {
    throw new DomainError({ code: "validation_failed", message: "The G1 probe uploads private, without a publish date." });
  }
}

export function createG1Probe(deps: G1ProbeDependencies) {
  return {
    async upload(input: G1UploadInput): Promise<G1UploadReport> {
      validateResource(input.resource);
      await deps.assertDeviceAvailable();
      const previous = await deps.record.get();
      if (previous?.status === "started") {
        throw new DomainError({
          code: "validation_failed",
          message: `An earlier G1 upload (started ${previous.startedAt}) has an unknown outcome. Look for the test video in Studio before anything else; no new upload starts.`,
        });
      }
      const retry = previous !== null && input.retryAfterDuplicate === true && previous.attempt === 1 && previous.rejectionReason === "duplicate" && previous.deletedAt !== null;
      if (previous && !retry) {
        throw new DomainError({
          code: "validation_failed",
          message: `The G1 probe already uploaded ${previous.videoId}${previous.deletedAt ? " (deleted)" : ""}; it runs once (one retry only after a duplicate rejection, once that video is deleted).`,
        });
      }

      const credentials = await deps.resolveWriteCredentials(input.credentialRef);
      await deps.assertWriteChannel({ credentialRef: input.credentialRef, credentials, expectedChannelId: input.channelId });
      const file = await deps.resolveFile(input.channelId, input.relativePath);
      const contentType = "video/mp4";

      const accessToken = await deps.accessTokenOf(credentials);
      const started: G1ProbeRecord = {
        channelId: input.channelId,
        status: "started",
        attempt: retry ? 2 : 1,
        startedAt: deps.clock.now().toISOString(),
        videoId: null,
        uploadedAt: null,
        deletedAt: null,
        rejectionReason: null,
      };
      // Saved before the first request: from here on a crash or a lost answer leaves "started", which blocks a second upload.
      await deps.record.save(started);
      let sessionUri: string;
      try {
        ({ sessionUri } = await deps.gateway.begin({ accessToken, resource: input.resource, contentLength: file.bytes, contentType, notifySubscribers: false }));
      } catch (error) {
        // A refused start sends no bytes and creates no video (Google's guide): the record goes back to what it was.
        if (error instanceof DomainError && typeof (error.details as { status?: unknown } | undefined)?.status === "number") {
          const status = (error.details as { status: number }).status;
          if (status >= 400 && status < 500) {
            if (previous) await deps.record.save(previous);
            else await deps.record.clear();
          }
        }
        throw error;
      }

      let start = 0;
      let videoId: string | null = null;
      while (videoId === null) {
        const chunk = await deps.readChunk(file.path, start, Math.min(G1_CHUNK_BYTES, file.bytes - start));
        let progress: UploadProgress;
        try {
          progress = await deps.gateway.putChunk({ accessToken, sessionUri, chunk, start, total: file.bytes, contentType });
        } catch (error) {
          // A lost answer or a 5xx: Google's guide says to ask where the session stands before anything else (review S1).
          progress = await deps.gateway.queryOffset({ accessToken, sessionUri, total: file.bytes }).catch(() => {
            throw new DomainError({
              code: "update_failed",
              message: `The upload's outcome is unknown after: ${error instanceof Error ? error.message : String(error)}. Look in Studio before anything else.`,
            });
          });
        }
        if ("expired" in progress) throw new DomainError({ code: "update_failed", message: "The upload session expired before the upload finished." });
        if (progress.done) videoId = progress.videoId;
        else if (progress.storedBytes <= start) throw new DomainError({ code: "update_failed", message: `The upload made no progress at byte ${start}.` });
        else if (progress.storedBytes >= file.bytes) {
          const status = await deps.gateway.queryOffset({ accessToken, sessionUri, total: file.bytes });
          if ("done" in status && status.done) videoId = status.videoId;
          else throw new DomainError({ code: "update_failed", message: "YouTube holds every byte but did not return the video. Look in Studio." });
        } else start = progress.storedBytes;
      }

      deps.announce(videoId);
      const uploadedAt = deps.clock.now().toISOString();
      const uploaded: G1ProbeRecord = { ...started, status: "uploaded", videoId, uploadedAt };
      await deps.record.save(uploaded);
      await deps.audit({ channelId: input.channelId, videoId, detail: { action: "g1_upload", attempt: started.attempt, bytes: file.bytes, resource: input.resource, uploadedAt } });

      const startedMs = deps.clock.now().getTime();
      let state: VideoUploadStateView | null = null;
      let readError: string | null = null;
      const read = async () => {
        try {
          state = await deps.readState(credentials, videoId as string);
          readError = null;
        } catch (error) {
          readError = error instanceof Error ? error.message : String(error);
        }
      };
      await read();
      const finished = () =>
        state !== null &&
        (TERMINAL_UPLOAD_STATUSES.has((state as VideoUploadStateView).uploadStatus ?? "") ||
          TERMINAL_PROCESSING_STATUSES.has((state as VideoUploadStateView).processingStatus ?? ""));
      while (!finished() && deps.clock.now().getTime() - startedMs < POLL_FOR_MS) {
        await deps.sleep(POLL_EVERY_MS);
        await read();
      }
      const finalState = state as VideoUploadStateView | null;
      const waitedSeconds = Math.round((deps.clock.now().getTime() - startedMs) / 1000);
      await deps.record.save({ ...uploaded, rejectionReason: finalState?.rejectionReason ?? null });
      await deps.audit({ channelId: input.channelId, videoId, detail: { action: "g1_read_back", state: finalState, waitedSeconds, readError } });
      return {
        videoId,
        bytes: file.bytes,
        state: finalState,
        waitedSeconds,
        readError,
        defaultAudioLanguage: { sent: input.resource.snippet.defaultAudioLanguage ?? null, readBack: finalState?.defaultAudioLanguage ?? null },
      };
    },

    /** Deletes the probe's own video -- refused for any other id, and a second time. */
    async remove(input: { credentialRef: CredentialRef; videoId: string }): Promise<G1DeleteReport> {
      await deps.assertDeviceAvailable();
      const record = await deps.record.get();
      if (!record || record.status !== "uploaded" || record.videoId !== input.videoId) {
        throw new DomainError({ code: "validation_failed", message: "Only the video the G1 probe uploaded can be deleted here." });
      }
      if (record.deletedAt) throw new DomainError({ code: "validation_failed", message: `The G1 video was already deleted at ${record.deletedAt}.` });

      const credentials = await deps.resolveWriteCredentials(input.credentialRef);
      await deps.assertWriteChannel({ credentialRef: input.credentialRef, credentials, expectedChannelId: record.channelId });
      const videoId = record.videoId as string;
      await deps.gateway.deleteVideo(credentials, videoId);

      const goneOnYouTube = (await deps.readState(credentials, videoId).catch(() => undefined)) === null;
      const deletedAt = deps.clock.now().toISOString();
      await deps.record.save({ ...record, deletedAt });
      await deps.audit({ channelId: record.channelId, videoId, detail: { action: "g1_delete", goneOnYouTube, deletedAt } });
      const localRowRemoved = await deps.removeLocalVideoRow(record.channelId, videoId);
      return { videoId, goneOnYouTube, localRowRemoved };
    },
  };
}

export type G1Probe = ReturnType<typeof createG1Probe>;
