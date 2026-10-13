// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 items 5–7; FO-REQ-0023 §4 B5–B7; ADR 0037). The upload queue of this computer,
// advanced by a background tick: one byte stream at a time, and the steps after it (processing, the deferred publish time, the
// thumbnail, the playlist, the read-back, the upload record, a sync) for the uploads already sent. Every step's outcome is stored
// before the next one starts, so a restart continues at its step. Never twice (ADR 0037 §4): an upload whose answer was lost asks
// its session where it stands, and an expired session starts again only when the channel's recent uploads show no video with
// the package's title. Live writes off pauses a job (never fails it); quota and the channel's upload cap pause it until they reset.

import type { StoredPublishingUpload } from "@/lib/db";
import { PUBLISH_AT_AT_INSERT_MIN_MS } from "./publish-dates";
import type { PublishingSettings } from "./settings";

/** The package as the owner approved it (frozen in `package_json`). Paths are relative to the channel workspace. */
export type ApprovedPackage = {
  video: string;
  title: string;
  description: string;
  tags: string[];
  defaultLanguage: string;
  defaultAudioLanguage: string;
  manifestPath: string;
  videoFile: string;
  thumbnailFile: string;
  sizeBytes: number;
};

export type UploadSteps = {
  /** When the last chunk was first sent: from then on the video may exist even if no answer said so (never restarted blindly). */
  finalChunkSentAt?: string;
  publishAt?: "at_insert" | "set" | "skipped_too_soon" | "failed";
  thumbnail?: "set" | "failed";
  playlist?: "added" | "already_there" | "none" | "failed";
  verify?: { result: "verified" | "mismatch"; mismatches: string[] };
  record?: "written" | "failed";
  sync?: "synced" | "failed";
  /** The reason a step failed (shown with the job; the video exists either way). */
  notes?: string[];
};

export type UploadHttpProgress = { done: true; videoId: string } | { done: false; storedBytes: number } | { expired: true };

export type UploadCredentials = { credentialRef: { userId: string }; credentials: unknown };

/** What the runner needs; each write below checks Live writes right before its gateway call (the adapters, ADR 0005). */
export type UploadRunnerDeps = {
  store: {
    listActive(): Promise<StoredPublishingUpload[]>;
    update(id: string, from: StoredPublishingUpload["status"], set: Partial<StoredPublishingUpload>): Promise<boolean>;
  };
  /** The approver's Google user for the channel, with the upload scope; and the identity check (write-context). */
  credentials(job: StoredPublishingUpload): Promise<UploadCredentials>;
  assertWriteChannel(args: { channelId: string } & UploadCredentials): Promise<void>;
  accessToken(credentials: unknown): Promise<string>;
  liveWritesEnabled(): Promise<boolean>;
  gateway: {
    begin(args: { accessToken: string; resource: InsertResource; contentLength: number; contentType: string; notifySubscribers: boolean }): Promise<{ sessionUri: string }>;
    putChunk(args: { accessToken: string; sessionUri: string; chunk: Buffer; start: number; total: number; contentType: string }): Promise<UploadHttpProgress>;
    queryOffset(args: { accessToken: string; sessionUri: string; total: number }): Promise<UploadHttpProgress>;
    setThumbnail(credentials: unknown, videoId: string, image: { mimeType: string; bytes: Buffer }): Promise<void>;
    addToPlaylist(credentials: unknown, videoId: string, playlistId: string): Promise<void>;
  };
  reads: {
    /** `videos.list` status and processing of one video; null when YouTube does not return it. */
    uploadState(credentials: unknown, videoId: string): Promise<{ uploadStatus: string | null; rejectionReason: string | null; failureReason: string | null } | null>;
    /** The channel's newest uploads (first page of its uploads playlist, private ones included for its own user). */
    recentUploads(credentials: unknown, channelId: string): Promise<Array<{ videoId: string; title: string }>>;
    playlistHasVideo(credentials: unknown, playlistId: string, videoId: string): Promise<boolean>;
    /** The video as YouTube has it now (video-details' snapshot), for the read-back. */
    snapshot(args: { channelId: string; videoId: string } & UploadCredentials): Promise<VideoReadBack>;
  };
  /** The deferred publish time, through video-details' own write path (backup, read-modify-write, read-back, audit). */
  setPublishAt(args: { channelId: string; videoId: string; publishAt: string; containsSyntheticMedia: boolean } & UploadCredentials): Promise<void>;
  files: {
    /** A file of the channel's workspace by the workspace rule; null when it is not there (or not inside). */
    resolve(channelId: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
    readChunk(path: string, start: number, length: number): Promise<Buffer>;
    sha256(path: string): Promise<string>;
    /** Writes `Vn_youtube.json` next to the package (atomically). */
    writeRecord(channelId: string, relativePath: string, record: unknown): Promise<void>;
  };
  audit(args: { channelId: string; videoId: string | null; detail: Record<string, unknown> }): Promise<void>;
  syncChannel(args: { channelId: string } & UploadCredentials): Promise<void>;
  device(): Promise<{ deviceId: string | null; hostname: string | null }>;
  clock: { now(): Date };
  /** The next YouTube quota day (midnight Pacific). */
  nextQuotaReset(now: Date): Date;
  /** Bytes per request (a multiple of 256 KB) and how long one tick keeps sending. */
  chunkBytes: number;
  sliceMs: number;
};

export type InsertResource = {
  snippet: { title: string; description: string; tags?: string[]; categoryId?: string; defaultLanguage?: string; defaultAudioLanguage?: string };
  status: { privacyStatus: "private"; publishAt?: string; selfDeclaredMadeForKids: boolean; containsSyntheticMedia?: boolean; license?: "youtube" | "creativeCommon"; embeddable?: boolean };
};

export type VideoReadBack = {
  title: string | null;
  description: string | null;
  tags: string[] | null;
  categoryId: string | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
  selfDeclaredMadeForKids: boolean | null;
  license: string | null;
  embeddable: boolean | null;
};

/** video-details' own rule: a publish time 15 minutes ahead or less is not written (the video could publish before the write). */
const PUBLISH_AT_MARGIN_MS = 15 * 60_000;
const PROCESSING_POLL_MS = 30_000;
const UPLOAD_LIMIT_PAUSE_MS = 24 * 3_600_000;
const AUTH_RETRY_MS = 15 * 60_000;
const ACTIVE: ReadonlyArray<StoredPublishingUpload["status"]> = ["queued", "uploading", "processing", "finishing", "paused"];

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The parts of an error that decide what happens next: a domain error's code and details, or a Google API error's status and reason. */
function errorInfo(error: unknown): { code: string | null; reason: string | null; status: number | null; message: string } {
  const e = error as {
    code?: unknown;
    status?: unknown;
    details?: { reason?: unknown; status?: unknown };
    errors?: Array<{ reason?: unknown }>;
    response?: { status?: unknown };
  } | null;
  const status = [e?.details?.status, e?.status, e?.response?.status, e?.code].find((value): value is number => typeof value === "number") ?? null;
  const reason = [e?.details?.reason, e?.errors?.[0]?.reason].find((value): value is string => typeof value === "string") ?? null;
  return { code: typeof e?.code === "string" ? e.code : null, reason, status, message: error instanceof Error ? error.message : String(error) };
}

/** A network failure, a timeout or a 5xx: nothing says the request was refused, so it is asked again. */
function isTransient(info: ReturnType<typeof errorInfo>): boolean {
  if (info.status !== null) return info.status >= 500;
  if (info.code !== null && /^E[A-Z]+$/.test(info.code)) return true; // ECONNRESET, ETIMEDOUT, ...
  return info.code === null;
}

type Outcome =
  | { kind: "pause"; reason: "live_writes_off" | "quota_exceeded" | "upload_limit" | "auth"; until: Date | null }
  | { kind: "retry"; message: string }
  | { kind: "fail"; code: string; message: string };

/** What an error means for a job: Live writes and quota pause it, an unknown answer is retried, a refusal fails it. */
export function classifyUploadError(error: unknown, now: Date, nextQuotaReset: (now: Date) => Date): Outcome {
  const info = errorInfo(error);
  if (info.code === "live_writes_disabled") return { kind: "pause", reason: "live_writes_off", until: null };
  if (info.reason === "quotaExceeded") return { kind: "pause", reason: "quota_exceeded", until: nextQuotaReset(now) };
  if (info.reason === "uploadLimitExceeded") return { kind: "pause", reason: "upload_limit", until: new Date(now.getTime() + UPLOAD_LIMIT_PAUSE_MS) };
  if (info.code === "unauthorized" || info.code === "AUTH_SCOPE_INSUFFICIENT" || /invalid_grant/i.test(info.message)) {
    return { kind: "pause", reason: "auth", until: new Date(now.getTime() + AUTH_RETRY_MS) };
  }
  // A 5xx, a network failure or a timeout: the outcome is unknown, so the next attempt asks the session where it stands.
  if (isTransient(info)) return { kind: "retry", message: info.message };
  return { kind: "fail", code: info.reason ?? info.code ?? "upload_refused", message: info.message };
}

/** The UTC instant two read-backs both mean (`...:00Z` and `...:00.000Z` are the same time). */
const sameInstant = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));

/** Every field the read-back shows differently from what was approved; AI use is not readable (G1) and is not compared. */
export function readBackMismatches(after: VideoReadBack, pkg: ApprovedPackage, settings: PublishingSettings, publishAt: string | null, nowMs: number): string[] {
  const mismatches: string[] = [];
  if (after.title !== pkg.title) mismatches.push("title");
  if (after.description !== pkg.description) mismatches.push("description");
  if (JSON.stringify(after.tags ?? []) !== JSON.stringify(pkg.tags)) mismatches.push("tags");
  if (after.categoryId !== settings.categoryId) mismatches.push("categoryId");
  if (after.defaultLanguage !== pkg.defaultLanguage) mismatches.push("defaultLanguage");
  if (after.defaultAudioLanguage !== pkg.defaultAudioLanguage) mismatches.push("defaultAudioLanguage");
  const published = publishAt !== null && Date.parse(publishAt) <= nowMs;
  if (after.privacyStatus !== "private" && !(published && after.privacyStatus === "public")) mismatches.push("privacyStatus");
  if (publishAt !== null && !published && !sameInstant(after.publishAt, publishAt)) mismatches.push("publishAt");
  if (after.selfDeclaredMadeForKids !== settings.madeForKids) mismatches.push("madeForKids");
  if (after.license !== settings.license) mismatches.push("license");
  if (after.embeddable !== settings.embeddable) mismatches.push("embeddable");
  return mismatches;
}

export function createUploadRunner(deps: UploadRunnerDeps) {
  const now = () => deps.clock.now();

  async function pause(job: StoredPublishingUpload, outcome: Extract<Outcome, { kind: "pause" }>): Promise<void> {
    await deps.store.update(job.id, job.status, {
      status: "paused",
      resumeStatus: job.status === "paused" ? job.resumeStatus : job.status,
      pausedReason: outcome.reason,
      pausedUntil: outcome.until,
      updatedAt: now(),
    });
  }

  async function fail(job: StoredPublishingUpload, code: string, message: string): Promise<void> {
    await deps.store.update(job.id, job.status, { status: "failed", errorCode: code, errorMessage: message.slice(0, 2000), finishedAt: now(), updatedAt: now() });
    await deps.audit({ channelId: job.channelId, videoId: job.videoId, detail: { event: "publishing.upload_failed", uploadId: job.id, video: job.video, code, message: message.slice(0, 500) } });
  }

  /** Applies what an error means; a retry is due again after a short wait that grows with the attempts. */
  async function onError(job: StoredPublishingUpload, error: unknown): Promise<void> {
    const outcome = classifyUploadError(error, now(), deps.nextQuotaReset);
    if (outcome.kind === "pause") return pause(job, outcome);
    if (outcome.kind === "fail") return fail(job, outcome.code, outcome.message);
    const waitMs = Math.min(10 * 60_000, 30_000 * Math.max(1, job.attempts));
    await deps.store.update(job.id, job.status, { errorMessage: outcome.message.slice(0, 2000), nextAttemptAt: new Date(now().getTime() + waitMs), attempts: job.attempts + 1, updatedAt: now() });
  }

  async function identity(job: StoredPublishingUpload): Promise<UploadCredentials> {
    const creds = await deps.credentials(job);
    await deps.assertWriteChannel({ channelId: job.channelId, ...creds });
    return creds;
  }

  /** The video exists: its id is stored before anything else happens to it. */
  async function adopt(job: StoredPublishingUpload, videoId: string, how: "uploaded" | "found"): Promise<void> {
    const ok = await deps.store.update(job.id, "uploading", { status: "processing", videoId, storedBytes: job.totalBytes, nextAttemptAt: now(), errorMessage: null, updatedAt: now() });
    if (ok) await deps.audit({ channelId: job.channelId, videoId, detail: { event: how === "uploaded" ? "publishing.uploaded" : "publishing.adopted_after_lost_answer", uploadId: job.id, video: job.video } });
  }

  /**
   * An expired session: a video with this title among the newest uploads is this upload (adopted). Otherwise a new session -- but
   * only when the last chunk was never sent. Once it was, YouTube may have made the video and the uploads list may not show it
   * yet, so the job stops as `unknown_outcome` for the owner to look in Studio (ADR 0037 §4: "adopts it, or asks the owner").
   */
  async function onExpired(job: StoredPublishingUpload, pkg: ApprovedPackage, creds: UploadCredentials): Promise<"adopted" | "restart" | "unknown"> {
    const found = (await deps.reads.recentUploads(creds.credentials, job.channelId)).find((video) => video.title === pkg.title);
    if (found) {
      await adopt(job, found.videoId, "found");
      return "adopted";
    }
    if (parseJson<UploadSteps>(job.stepsJson, {}).finalChunkSentAt) {
      await fail(job, "unknown_outcome", "Every byte was sent but the upload session expired before YouTube's answer was read, and no video with this title is among the channel's newest uploads yet. Look in Studio before approving this package again: a second upload could make a duplicate.");
      return "unknown";
    }
    await deps.store.update(job.id, "uploading", { sessionUri: null, storedBytes: 0, updatedAt: now() });
    return "restart";
  }

  async function upload(job: StoredPublishingUpload): Promise<void> {
    const pkg = parseJson<ApprovedPackage | null>(job.packageJson, null);
    const settings = parseJson<PublishingSettings | null>(job.settingsJson, null);
    if (!pkg || !settings) return fail(job, "job_damaged", "The approved package of this upload cannot be read.");
    let current = job;
    try {
      if (current.status === "queued") {
        // The files must still be what the owner approved: the same manifest, a video of the same size.
        const manifest = await deps.files.resolve(job.channelId, pkg.manifestPath);
        if (!manifest || (await deps.files.sha256(manifest.path)) !== job.manifestSha256) return fail(job, "package_changed", "The package changed on disk after it was approved.");
        const videoFile = await deps.files.resolve(job.channelId, pkg.videoFile);
        if (!videoFile || videoFile.bytes !== job.totalBytes) return fail(job, "package_changed", "The video file changed or is missing since it was approved.");
        await identity(job);
        if (!(await deps.store.update(job.id, "queued", { status: "uploading", attempts: job.attempts + 1, sessionUri: null, storedBytes: 0, updatedAt: now() }))) return;
        current = { ...job, status: "uploading", attempts: job.attempts + 1, sessionUri: null, storedBytes: 0 };
      }
      const creds = await identity(current);
      const videoFile = await deps.files.resolve(current.channelId, pkg.videoFile);
      if (!videoFile || videoFile.bytes !== current.totalBytes) return fail(current, "package_changed", "The video file changed or is missing during the upload.");
      const token = await deps.accessToken(creds.credentials);
      const contentType = "video/*";
      let stored = current.storedBytes;
      if (!current.sessionUri) {
        const publishAtAtInsert = current.publishAt !== null && Date.parse(current.publishAt) - now().getTime() >= PUBLISH_AT_AT_INSERT_MIN_MS;
        const resource: InsertResource = {
          snippet: { title: pkg.title, description: pkg.description, tags: pkg.tags, categoryId: settings.categoryId, defaultLanguage: pkg.defaultLanguage, defaultAudioLanguage: pkg.defaultAudioLanguage },
          status: {
            privacyStatus: "private",
            ...(publishAtAtInsert ? { publishAt: current.publishAt as string } : {}),
            selfDeclaredMadeForKids: settings.madeForKids,
            containsSyntheticMedia: settings.containsSyntheticMedia,
            license: settings.license,
            embeddable: settings.embeddable,
          },
        };
        const { sessionUri } = await deps.gateway.begin({ accessToken: token, resource, contentLength: current.totalBytes, contentType, notifySubscribers: settings.notifySubscribers });
        // The session is stored before the first byte: a restart resumes it rather than starting another.
        await deps.store.update(current.id, "uploading", { sessionUri, storedBytes: 0, publishAtAtInsert, updatedAt: now() });
        current = { ...current, sessionUri, storedBytes: 0, publishAtAtInsert };
        stored = 0;
      } else {
        // Resuming (a restart, a cut connection, a lost answer): the session says how much it holds.
        const progress = await deps.gateway.queryOffset({ accessToken: token, sessionUri: current.sessionUri, total: current.totalBytes });
        if ("expired" in progress) {
          await onExpired(current, pkg, creds);
          return;
        }
        if (progress.done) return adopt(current, progress.videoId, "uploaded");
        stored = progress.storedBytes;
      }
      const deadline = now().getTime() + deps.sliceMs;
      while (stored < current.totalBytes && now().getTime() < deadline) {
        const length = Math.min(deps.chunkBytes, current.totalBytes - stored);
        if (stored + length === current.totalBytes && !parseJson<UploadSteps>(current.stepsJson, {}).finalChunkSentAt) {
          // Stored before the last chunk goes: if its answer is lost and the session then expires, the job never restarts blindly.
          const stepsJson = JSON.stringify({ ...parseJson<UploadSteps>(current.stepsJson, {}), finalChunkSentAt: now().toISOString() });
          await deps.store.update(current.id, "uploading", { stepsJson, updatedAt: now() });
          current = { ...current, stepsJson };
        }
        const chunk = await deps.files.readChunk(videoFile.path, stored, length);
        const progress = await deps.gateway.putChunk({ accessToken: token, sessionUri: current.sessionUri as string, chunk, start: stored, total: current.totalBytes, contentType });
        if ("expired" in progress) {
          await onExpired(current, pkg, creds);
          return;
        }
        if (progress.done) return adopt(current, progress.videoId, "uploaded");
        stored = progress.storedBytes;
        await deps.store.update(current.id, "uploading", { storedBytes: stored, errorMessage: null, updatedAt: now() });
      }
    } catch (error) {
      await onError(current, error);
    }
  }

  async function processing(job: StoredPublishingUpload): Promise<void> {
    try {
      const creds = await deps.credentials(job);
      const state = await deps.reads.uploadState(creds.credentials, job.videoId as string);
      const status = state?.uploadStatus ?? null;
      if (status === "processed") {
        await deps.store.update(job.id, "processing", { status: "finishing", nextAttemptAt: now(), updatedAt: now() });
        return;
      }
      if (status === "rejected" || status === "failed" || status === "deleted") {
        return fail(job, `processing_${status}`, `YouTube ${status} the video: ${state?.rejectionReason ?? state?.failureReason ?? "no reason given"}`);
      }
      await deps.store.update(job.id, "processing", { nextAttemptAt: new Date(now().getTime() + PROCESSING_POLL_MS), updatedAt: now() });
    } catch (error) {
      await onError(job, error);
    }
  }

  async function saveSteps(job: StoredPublishingUpload, steps: UploadSteps): Promise<boolean> {
    return deps.store.update(job.id, "finishing", { stepsJson: JSON.stringify(steps), updatedAt: now() });
  }

  /** One step after the upload, in order; each outcome is stored before the next. A failed step is noted, the others still run. */
  async function finishing(job: StoredPublishingUpload): Promise<void> {
    const pkg = parseJson<ApprovedPackage | null>(job.packageJson, null);
    const settings = parseJson<PublishingSettings | null>(job.settingsJson, null);
    if (!pkg || !settings || !job.videoId) return fail(job, "job_damaged", "The approved package of this upload cannot be read.");
    const steps = parseJson<UploadSteps>(job.stepsJson, {});
    const note = (text: string) => (steps.notes = [...(steps.notes ?? []), text.slice(0, 300)]);
    const videoId = job.videoId;
    let step: "publishAt" | "thumbnail" | "playlist" | "verify" | "record" | "sync" = "publishAt";
    try {
      const creds = await deps.credentials(job);
      if (job.publishAt !== null && steps.publishAt === undefined) {
        if (job.publishAtAtInsert) steps.publishAt = "at_insert";
        else if (Date.parse(job.publishAt) - now().getTime() <= PUBLISH_AT_MARGIN_MS) steps.publishAt = "skipped_too_soon";
        else {
          await deps.setPublishAt({ channelId: job.channelId, videoId, publishAt: job.publishAt, containsSyntheticMedia: settings.containsSyntheticMedia, ...creds });
          steps.publishAt = "set";
        }
        return void (await saveSteps(job, steps));
      }
      step = "thumbnail";
      if (steps.thumbnail === undefined) {
        const file = await deps.files.resolve(job.channelId, pkg.thumbnailFile);
        if (!file) {
          steps.thumbnail = "failed";
          note("thumbnail file missing");
        } else {
          const bytes = await deps.files.readChunk(file.path, 0, file.bytes);
          const mimeType = bytes[0] === 0x89 ? "image/png" : "image/jpeg";
          await deps.gateway.setThumbnail(creds.credentials, videoId, { mimeType, bytes });
          steps.thumbnail = "set";
        }
        return void (await saveSteps(job, steps));
      }
      step = "playlist";
      if (steps.playlist === undefined) {
        if (!settings.playlistId) steps.playlist = "none";
        else if (await deps.reads.playlistHasVideo(creds.credentials, settings.playlistId, videoId)) steps.playlist = "already_there";
        else {
          await deps.gateway.addToPlaylist(creds.credentials, videoId, settings.playlistId);
          steps.playlist = "added";
        }
        return void (await saveSteps(job, steps));
      }
      step = "verify";
      if (steps.verify === undefined) {
        const after = await deps.reads.snapshot({ channelId: job.channelId, videoId, ...creds });
        const publishAt = steps.publishAt === "at_insert" || steps.publishAt === "set" ? job.publishAt : null;
        const mismatches = readBackMismatches(after, pkg, settings, publishAt, now().getTime());
        steps.verify = { result: mismatches.length === 0 ? "verified" : "mismatch", mismatches };
        return void (await saveSteps(job, steps));
      }
      step = "record";
      if (steps.record === undefined) {
        const device = await deps.device();
        const folder = pkg.manifestPath.slice(0, pkg.manifestPath.lastIndexOf("/"));
        try {
          await deps.files.writeRecord(job.channelId, `${folder}/${pkg.video}_youtube.json`, {
            schema: "yt-release-upload/1",
            channelId: job.channelId,
            video: pkg.video,
            videoId,
            publishAt: steps.publishAt === "at_insert" || steps.publishAt === "set" ? job.publishAt : null,
            uploadedAt: now().toISOString(),
            device,
            result: steps.verify.result,
            mismatches: steps.verify.mismatches,
          });
          steps.record = "written";
        } catch (error) {
          steps.record = "failed";
          note(`upload record not written: ${errorInfo(error).message}`);
        }
        return void (await saveSteps(job, steps));
      }
      step = "sync";
      if (steps.sync === undefined) {
        try {
          await deps.syncChannel({ channelId: job.channelId, ...creds });
          steps.sync = "synced";
        } catch (error) {
          steps.sync = "failed";
          note(`sync after the upload failed: ${errorInfo(error).message}`);
        }
      }
      const problem = steps.verify.result === "mismatch" ? "verify_mismatch" : [steps.publishAt, steps.thumbnail, steps.playlist, steps.record].includes("failed") ? "step_failed" : steps.publishAt === "skipped_too_soon" ? "publish_at_too_soon" : null;
      if (await deps.store.update(job.id, "finishing", { status: "done", stepsJson: JSON.stringify(steps), errorCode: problem, finishedAt: now(), updatedAt: now() })) {
        await deps.audit({ channelId: job.channelId, videoId, detail: { event: "publishing.upload_done", uploadId: job.id, video: job.video, steps } });
      }
    } catch (error) {
      const outcome = classifyUploadError(error, now(), deps.nextQuotaReset);
      if (outcome.kind === "fail" && (step === "publishAt" || step === "thumbnail" || step === "playlist")) {
        // A refused write does not undo the upload: it is noted and the next step runs.
        steps[step] = "failed";
        note(`${step}: ${outcome.message}`);
        await saveSteps(job, steps);
        return;
      }
      await onError(job, error);
    }
  }

  /** A paused job whose reason is gone goes back to the step it was paused at. */
  async function resumePaused(jobs: StoredPublishingUpload[]): Promise<void> {
    const at = now().getTime();
    let liveWrites: boolean | null = null;
    for (const job of jobs) {
      if (job.status !== "paused" || !job.resumeStatus) continue;
      const due = job.pausedReason === "live_writes_off" ? (liveWrites ??= await deps.liveWritesEnabled()) : job.pausedUntil !== null && job.pausedUntil.getTime() <= at;
      if (!due) continue;
      await deps.store.update(job.id, "paused", { status: job.resumeStatus as StoredPublishingUpload["status"], resumeStatus: null, pausedReason: null, pausedUntil: null, nextAttemptAt: now(), updatedAt: now() });
    }
  }

  return {
    /**
     * One pass: resume what can resume, advance one sent upload by one step, then keep one upload's bytes flowing for a slice.
     * A quota or upload-cap pause holds every queued upload of that channel back too, so they do not each hit it again.
     */
    async tick(): Promise<void> {
      await resumePaused(await deps.store.listActive());
      const jobs = (await deps.store.listActive()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const at = now().getTime();
      const due = (job: StoredPublishingUpload) => job.nextAttemptAt === null || job.nextAttemptAt.getTime() <= at;
      const afterUpload = jobs.find((job) => (job.status === "processing" || job.status === "finishing") && due(job));
      if (afterUpload) await (afterUpload.status === "processing" ? processing(afterUpload) : finishing(afterUpload));
      const held = new Set(jobs.filter((job) => job.status === "paused" && (job.pausedReason === "quota_exceeded" || job.pausedReason === "upload_limit")).map((job) => job.channelId));
      const liveWritesHeld = jobs.some((job) => job.status === "paused" && job.pausedReason === "live_writes_off" && job.resumeStatus === "uploading");
      const sending = jobs.find((job) => job.status === "uploading");
      const next = sending ?? (liveWritesHeld ? undefined : jobs.find((job) => job.status === "queued" && !held.has(job.channelId)));
      if (next && due(next)) await upload(next);
    },
    /** Whether an upload is being sent or finished now (the idle watcher keeps the session while it is). */
    async isBusy(): Promise<boolean> {
      return (await deps.store.listActive()).some((job) => job.status === "uploading" || job.status === "processing" || job.status === "finishing");
    },
  };
}

/**
 * Whether the owner may cancel an upload: only before it reached YouTube -- queued, or paused while sending with bytes still to
 * send. Once every byte is sent the video exists (or may), so it is finished instead; the owner deletes it in Studio if needed.
 */
export function isCancellable(row: Pick<StoredPublishingUpload, "status" | "resumeStatus" | "videoId" | "storedBytes" | "totalBytes">): boolean {
  if (row.status === "queued") return true;
  return row.status === "paused" && (row.resumeStatus === "queued" || row.resumeStatus === "uploading") && row.videoId === null && row.storedBytes < row.totalBytes;
}

export type UploadRunner = ReturnType<typeof createUploadRunner>;
export const ACTIVE_UPLOAD_STATUSES = ACTIVE;
