// BL-239 (docs/roadmap/plans/UPLOAD_QUEUE_CONTROL_PLAN.md; ADR 0059; owner msgs 3928/3930): control of this computer's upload
// queue -- one queue for every channel. The Producer lists it, moves a queued row to another place, cancels a queued row and adds a
// ready release package under the owner's automatic-upload switch; the owner moves a queued row one place up or down. BL-244
// (ADR 0064): the cancel also stops a row being sent before its last chunk, for the Producer and the owner alike. A move only
// changes which queued row starts next: a row being sent or finished is never interrupted (the runner's `sending ??` rule). An add
// passes the automatic upload's own per-package check and the approval's own queue: private, a date only from an approved plan slot.
// Every move, add and cancel is audited with who did it.

import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError, type DomainErrorCode } from "@/lib/shared-domain";
import { checkPackageForQueue, type SlotDecision } from "./auto-upload";
import type { PackageScanResult } from "./package-scan";
import { compareQueueOrder, isCancellable, isPublishAtSet, isSending, type ApprovedPackage } from "./upload-runner";

/** Who acts on the queue: the owner in the Web UI (his Google user), or the Producer (its token). */
export type QueueActor = { kind: "owner"; userId: string } | { kind: "producer"; tokenId: string };

/** A Producer's cancel: the row's error code, so a later add of the same manifest version by the Producer is allowed. */
export const CANCELLED_BY_PRODUCER = "cancelled_by_producer";

export type UploadQueueControlDeps = {
  /** This computer's rows in an active status (queued, uploading, processing, finishing, paused), every channel. */
  listActive(): Promise<StoredPublishingUpload[]>;
  get(uploadId: string): Promise<StoredPublishingUpload | null>;
  /** Gives the queued rows the places 1..N in this order, all or none; false when one of them is no longer queued. */
  reorder(orderedIds: string[]): Promise<boolean>;
  /**
   * BL-244 (ADR 0064): the store's one conditional update (`stopPublishingUploadBeforeYoutube`) -- from `fromStatus`, no video id,
   * the last chunk never marked, bytes still to send once sending; the bytes stored at the stop, or null when nothing was written.
   */
  stop(uploadId: string, fromStatus: StoredPublishingUpload["status"], set: Partial<StoredPublishingUpload>): Promise<{ storedBytes: number; totalBytes: number } | null>;
  /** Refuses while the app is paused for a device handoff or recovery (the device mutation gate). */
  assertMutationAllowed(): Promise<void>;
  /** The automatic-upload switch of THIS computer (ADR 0046): the Producer adds only where it is on. */
  autoSwitchOn(): Promise<boolean>;
  channelTitles(): Promise<Map<string, string>>;
  /** The channel's connected Google user on this computer (the account the runner uploads with), or null. */
  channelUser(channelId: string): Promise<string | null>;
  scan(channelId: string): Promise<PackageScanResult>;
  liveVideos(channelId: string): Promise<Set<string>>;
  peerUploads(channelId: string): Promise<Map<string, { host: string | null; uploaded: boolean }>>;
  /** Manifest hashes of the channel with a row here that is not a Producer cancel: the Producer does not queue them again. */
  blockedHashes(channelId: string): Promise<Set<string>>;
  /** The weekly plan's decisions (the composition layer); absent: the plan module is off. */
  slotDecisions?(channelId: string): Promise<Map<string, SlotDecision>>;
  videoFile(channelId: string, relativePath: string): Promise<{ path: string; bytes: number; mtimeMs: number } | null>;
  hashFile(absolutePath: string): Promise<string>;
  /** The approval's `queueByProducer`. */
  queue(input: {
    channelId: string;
    userId: string;
    manifestPath: string;
    manifestSha256: string;
    scanned: Extract<PackageScanResult, { status: "ok" }>;
    switchOn: boolean;
    tokenId: string;
    slotPublishAt: string | null;
  }): Promise<{ id: string; video: string; publishAt: string | null }>;
  logMismatch(args: { channelId: string; video: string; manifestSha256: string; expected: string; actual: string }): Promise<void>;
  audit(args: { channelId: string; uploadId: string; detail: Record<string, unknown> }): Promise<void>;
  clock: { now(): Date };
};

const refuse = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });

function packageOf(row: StoredPublishingUpload): Partial<ApprovedPackage> {
  try {
    return JSON.parse(row.packageJson) as Partial<ApprovedPackage>;
  } catch {
    return {};
  }
}

/** Who queued a row; an older row (before schema v117) by its `automatic` flag. */
export const queuedByOf = (row: Pick<StoredPublishingUpload, "queuedBy" | "automatic">): "owner" | "automatic" | "producer" =>
  row.queuedBy === "producer" || row.queuedBy === "automatic" || row.queuedBy === "owner" ? row.queuedBy : row.automatic ? "automatic" : "owner";

const actorDetail = (actor: QueueActor) => (actor.kind === "owner" ? { by: "owner", userId: actor.userId } : { by: "producer", tokenId: actor.tokenId });

/** The queued rows in the order they start (every channel). */
export function queuedInOrder(rows: StoredPublishingUpload[]): StoredPublishingUpload[] {
  return rows.filter((row) => row.status === "queued").sort(compareQueueOrder);
}

/** Each queued row's place (1-based) and the queue's length -- for the owner's list. */
export function queuePositions(rows: StoredPublishingUpload[]): { positions: Map<string, number>; length: number } {
  const queued = queuedInOrder(rows);
  return { positions: new Map(queued.map((row, index) => [row.id, index + 1])), length: queued.length };
}

/** Why a row cannot be cancelled: it may be on YouTube already (its last chunk went, or a video exists) or it is not active. */
function notCancellable(input: { channelId: string; uploadId: string }, row: StoredPublishingUpload) {
  const details = { channelId: input.channelId, uploadId: input.uploadId, status: row.status };
  if (row.videoId !== null) {
    return refuse("upload_not_cancellable", "This upload already made its video on YouTube; it is finished, not stopped. Delete the video in YouTube Studio if it is not wanted.", { ...details, reason: "video_exists" });
  }
  if (row.status === "uploading" || row.status === "paused") {
    return refuse("upload_not_cancellable", "The last chunk of this upload was already sent, so the video may exist on YouTube; it is finished, not stopped. Delete the video in YouTube Studio if it is not wanted.", { ...details, reason: "final_chunk_sent" });
  }
  return refuse("upload_not_cancellable", `Only an upload that has not reached YouTube can be cancelled or stopped; this one is ${row.status}.`, { ...details, reason: "status" });
}

export function createUploadQueueControl(deps: UploadQueueControlDeps) {
  /** The row of `channelId` with that id, or `upload_not_found` (another channel's row is not found either: §6.6). */
  async function ownRow(channelId: string, uploadId: string): Promise<StoredPublishingUpload> {
    const row = await deps.get(uploadId);
    if (!row || row.channelId !== channelId) throw refuse("upload_not_found", "No upload with this id for this channel on this computer.", { channelId, uploadId });
    return row;
  }

  async function move(input: { channelId: string; uploadId: string; position: number }, actor: QueueActor) {
    await deps.assertMutationAllowed();
    const row = await ownRow(input.channelId, input.uploadId);
    if (row.status !== "queued") throw refuse("upload_not_movable", "Only a queued upload can be moved; this one is not waiting any more.", { channelId: input.channelId, uploadId: input.uploadId, status: row.status });
    const queued = queuedInOrder(await deps.listActive());
    const from = queued.findIndex((r) => r.id === row.id);
    if (from < 0) throw refuse("upload_queue_changed", "The queue changed meanwhile; nothing was moved.", { channelId: input.channelId, uploadId: input.uploadId });
    const to = Math.min(Math.max(Math.trunc(input.position), 1), queued.length) - 1;
    const result = { uploadId: row.id, channelId: row.channelId, video: row.video, from: from + 1, position: to + 1, queueLength: queued.length };
    if (from === to) return { ...result, moved: false };
    const order = queued.map((r) => r.id);
    order.splice(from, 1);
    order.splice(to, 0, row.id);
    if (!(await deps.reorder(order))) throw refuse("upload_queue_changed", "The queue changed meanwhile (an upload started or was cancelled); nothing was moved.", { channelId: input.channelId, uploadId: input.uploadId });
    await deps.audit({
      channelId: row.channelId,
      uploadId: row.id,
      detail: { event: "publishing.upload_queue_moved", ...actorDetail(actor), at: deps.clock.now().toISOString(), uploadId: row.id, video: row.video, from: from + 1, to: to + 1, queueLength: queued.length },
    });
    return { ...result, moved: true };
  }

  return {
    /** This computer's queue: the rows in progress, then the queued ones in the order they start, with the bytes ahead of each. */
    async list() {
      const rows = await deps.listActive();
      const titles = await deps.channelTitles();
      const base = (row: StoredPublishingUpload) => {
        const pkg = packageOf(row);
        return {
          uploadId: row.id,
          channelId: row.channelId,
          channelTitle: titles.get(row.channelId) ?? null,
          video: row.video,
          title: typeof pkg.title === "string" ? pkg.title : null,
          sizeBytes: row.totalBytes,
          status: row.status,
          queuedBy: queuedByOf(row),
          slotId: row.slotId,
          publishAt: row.publishAt,
          publishAtSet: isPublishAtSet(row),
          createdAt: row.createdAt.toISOString(),
        };
      };
      const inProgress = rows
        .filter((row) => row.status !== "queued")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => ({
          ...base(row),
          resumeStatus: row.resumeStatus,
          pausedReason: row.pausedReason,
          pausedUntil: row.pausedUntil?.toISOString() ?? null,
          progressPercent: row.totalBytes > 0 ? Math.floor((row.storedBytes / row.totalBytes) * 100) : null,
        }));
      // What must still go before a queued row can start: the rest of the file being sent (or paused while sending), then the
      // queued rows ahead of it. No ETA: no upload speed is stored.
      let ahead = rows
        .filter((row) => row.status === "uploading" || (row.status === "paused" && row.resumeStatus === "uploading"))
        .reduce((sum, row) => sum + Math.max(0, row.totalBytes - row.storedBytes), 0);
      const queue = queuedInOrder(rows).map((row, index) => {
        const entry = { position: index + 1, ...base(row), bytesAhead: ahead };
        ahead += row.totalBytes;
        return entry;
      });
      return {
        autoUploadSwitchOn: await deps.autoSwitchOn(),
        inProgress,
        queue,
        queuedCount: queue.length,
        queuedBytes: queue.reduce((sum, row) => sum + row.sizeBytes, 0),
      };
    },

    /** Moves a queued row to `position` (1-based; past the end is the end) in the shared queue. */
    move,

    /** The owner's ↑ / ↓: one place in the shared queue (every channel). */
    async moveStep(input: { channelId: string; uploadId: string; direction: "up" | "down" }, actor: QueueActor) {
      const rows = await deps.listActive();
      const { positions } = queuePositions(rows);
      const current = positions.get(input.uploadId);
      if (current === undefined) {
        const row = await ownRow(input.channelId, input.uploadId);
        throw refuse("upload_not_movable", "Only a queued upload can be moved; this one is not waiting any more.", { channelId: input.channelId, uploadId: input.uploadId, status: row.status });
      }
      return move({ channelId: input.channelId, uploadId: input.uploadId, position: Math.max(1, current + (input.direction === "up" ? -1 : 1)) }, actor);
    },

    /**
     * Cancels a row that has not reached YouTube, or stops one being sent (BL-244, ADR 0064; owner msgs 4046/4050) -- the one function
     * behind the Producer's `producer_upload_queue_cancel` and the owner's cancel / «Остановить загрузку». Allowed while nothing of
     * it can be on YouTube (`isCancellable`: queued, uploading or paused, no video, the last chunk never marked, bytes left); the
     * store's one conditional statement decides against the runner. The abandoned resumable session needs no call: it expires,
     * and no video exists before the last chunk. A Producer's cancel marks the row `cancelled_by_producer`.
     */
    async cancel(input: { channelId: string; uploadId: string }, actor: QueueActor) {
      await deps.assertMutationAllowed();
      // Two tries: a queued row the runner started between the read and the write is read again and stopped as `uploading`.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const row = await ownRow(input.channelId, input.uploadId);
        if (!isCancellable(row)) throw notCancellable(input, row);
        const now = deps.clock.now();
        const stopped = await deps.stop(row.id, row.status, { status: "cancelled", ...(actor.kind === "producer" ? { errorCode: CANCELLED_BY_PRODUCER } : {}), finishedAt: now, updatedAt: now });
        if (!stopped) continue;
        const sending = isSending(row);
        await deps.audit({
          channelId: row.channelId,
          uploadId: row.id,
          detail: { event: sending ? "publishing.upload_stopped" : "publishing.upload_cancelled", ...actorDetail(actor), at: now.toISOString(), uploadId: row.id, video: row.video, status: row.status, storedBytes: stopped.storedBytes, totalBytes: stopped.totalBytes },
        });
        return { uploadId: row.id, channelId: row.channelId, video: row.video, status: "cancelled" as const, previousStatus: row.status, storedBytes: stopped.storedBytes, totalBytes: stopped.totalBytes };
      }
      const row = await ownRow(input.channelId, input.uploadId);
      if (!isCancellable(row)) throw notCancellable(input, row);
      throw refuse("upload_not_cancellable", "The upload changed meanwhile; it was not cancelled. Look at the queue and try again.", { channelId: input.channelId, uploadId: input.uploadId, status: row.status, reason: "changed" });
    },

    /**
     * The Producer queues one release package of a channel on this computer (UPLOAD_QUEUE_CONTROL_PLAN.md §4): only where the
     * owner's automatic-upload switch is on; the automatic upload's per-package check (ready, `sha256`, not held, not tried, size
     * then SHA-256, a vetoed slot refused); then the approval's queue (private; a date only from an approved slot).
     */
    async add(input: { channelId: string; video: string; manifestSha256?: string }, actor: Extract<QueueActor, { kind: "producer" }>) {
      await deps.assertMutationAllowed();
      const { channelId } = input;
      if (!(await deps.autoSwitchOn())) throw refuse("upload_auto_switch_off", "The automatic upload is switched off on this computer: uploads are added only on the computer where the owner turned it on.", { channelId });
      const userId = await deps.channelUser(channelId);
      if (!userId) throw refuse("CHANNEL_NOT_ACTIVE", "This channel is not connected on this computer -- producer_list_channels lists the channels you can use.", { channelId });
      const scanned = await deps.scan(channelId);
      if (scanned.status === "no_workspace") throw refuse("package_no_workspace", "This channel has no workspace folder on this computer.", { channelId });
      if (scanned.status !== "ok") throw refuse("package_workspace_unavailable", `The channel's workspace cannot be used: ${scanned.reason}`, { channelId });
      const named = scanned.packages.filter((p) => p.video === input.video && (input.manifestSha256 === undefined || p.manifestSha256 === input.manifestSha256));
      if (named.length === 0) {
        if (input.manifestSha256 !== undefined && scanned.packages.some((p) => p.video === input.video)) {
          throw refuse("upload_package_changed", `${input.video}: the package changed (its manifest hash is not the one named).`, { channelId, video: input.video });
        }
        throw refuse("upload_package_not_ready", `${input.video}: no release package of this channel has this video number.`, { channelId, video: input.video });
      }
      if (named.length > 1) throw refuse("validation_failed", `${input.video}: more than one package names this video; name the one meant with manifestSha256.`, { channelId, video: input.video });
      const p = named[0];
      const check = await checkPackageForQueue(p, {
        live: await deps.liveVideos(channelId),
        peers: await deps.peerUploads(channelId),
        tried: await deps.blockedHashes(channelId),
        slots: deps.slotDecisions ? await deps.slotDecisions(channelId) : null,
        videoFile: (relativePath) => deps.videoFile(channelId, relativePath),
        videoHash: async (_manifestSha256, file) => (await deps.hashFile(file.path)).toLowerCase(),
        now: () => deps.clock.now(),
      });
      if (!check.ok) {
        const video = input.video;
        switch (check.reason) {
          case "not_ready":
            throw refuse("upload_package_not_ready", `${video} is not ready to upload.`, { channelId, video, state: p.state, problems: p.problems.map((problem) => problem.code) });
          case "slot_vetoed":
            throw refuse("upload_slot_vetoed", `${video}: its weekly-plan slot is vetoed, so it is not uploaded.`, { channelId, video, slotId: p.pkg?.slotId ?? null });
          case "no_sha256":
            throw refuse("upload_package_no_sha256", `${video}: the manifest has no sha256 of the video; only the owner can approve this upload.`, { channelId, video });
          case "held":
            throw refuse("upload_already_queued", `${video} is already queued or uploaded (here or on another computer).`, { channelId, video });
          case "tried":
            throw refuse("upload_already_tried", `${video}: this manifest version already had an upload on this computer; it stays the owner's to queue again.`, { channelId, video });
          case "size_mismatch":
            throw refuse("upload_video_mismatch", `${video}: the video file is missing or its size is not the manifest's sizeBytes.`, { channelId, video, reason: "size" });
          case "hash_failed":
            throw refuse("upload_video_mismatch", `${video}: the video file could not be read to check its SHA-256.`, { channelId, video, reason: "unreadable" });
          case "hash_mismatch":
            await deps.logMismatch({ channelId, video, manifestSha256: p.manifestSha256 ?? "", expected: check.expected, actual: check.actual }).catch(() => undefined);
            throw refuse("upload_video_mismatch", `${video}: the video file's SHA-256 is not the manifest's.`, { channelId, video, reason: "sha256" });
        }
      }
      // Hashing a large file takes a while: the owner may have switched it off meanwhile.
      const switchOn = await deps.autoSwitchOn();
      if (!switchOn) throw refuse("upload_auto_switch_off", "The automatic upload was switched off on this computer meanwhile.", { channelId });
      const queued = await deps.queue({ channelId, userId, manifestPath: p.manifestPath, manifestSha256: check.manifestSha256, scanned, switchOn, tokenId: actor.tokenId, slotPublishAt: check.slotPublishAt });
      const { positions, length } = queuePositions(await deps.listActive());
      return {
        upload: {
          uploadId: queued.id,
          channelId,
          video: queued.video,
          status: "queued" as const,
          queuedBy: "producer" as const,
          slotId: p.pkg?.slotId ?? null,
          publishAt: queued.publishAt,
          position: positions.get(queued.id) ?? null,
          queueLength: length,
        },
      };
    },
  };
}

export type UploadQueueControl = ReturnType<typeof createUploadQueueControl>;
