// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 items 5–7; FO-REQ-0023 §4 B5–B7; ADR 0037). The upload queue of this computer,
// advanced by a background tick: one byte stream at a time, and the steps after it (processing, the thumbnail, the playlist, the
// read-back, the publish time, the upload record, a sync) for the uploads already sent. The publish time comes last (owner msgs
// 3510/3511, FO-REQ-0040 item 4): a video is never scheduled before its thumbnail is set and the upload is verified. Every step's outcome is stored
// before the next one starts, so a restart continues at its step. Never twice (ADR 0037 §4): an upload whose answer was lost asks
// its session where it stands; an expired session starts again only while its last chunk was never sent and the channel's recent
// uploads show no video with the package's title; once a video exists its row keeps blocking the package, failed or not. Live
// writes off pauses a job (never fails it); quota and the channel's upload cap pause it until they reset.

import type { StoredPublishingUpload } from "@/lib/db";
import { READ_BACK_RETRIES, READ_BACK_RETRY_DELAY_MS } from "@/lib/video-details/read-back";
import type { PublishingSettings } from "./settings";
import type { SlotDecision } from "./auto-upload";

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
  /**
   * BL-209 review L5: the video's SHA-256 from the manifest, frozen on an AUTOMATIC row only. The runner checks the file against it
   * right before a new upload session starts (never on a resumed one); absent on an approval's row.
   */
  videoSha256?: string;
  /**
   * BL-225 stage 3 (ADR 0051 §8): a `yt-release-package/2`'s translations as checked when queued (absent: none). Written after the
   * insert by the shared video translations writer and read back before the date goes on.
   */
  localizations?: Record<string, { title: string; description: string }>;
  /** BL-225 stage 3: the package's own AI flag (absent: the channel's setting, frozen with the row). */
  containsSyntheticMedia?: boolean;
  /** BL-225: the weekly-plan slot the package names. */
  slotId?: string;
};

/** The AI flag an upload carries: the package's own, else the channel's setting (BL-225 stage 3). */
export const syntheticMediaOf = (pkg: Pick<ApprovedPackage, "containsSyntheticMedia">, settings: Pick<PublishingSettings, "containsSyntheticMedia">): boolean =>
  pkg.containsSyntheticMedia ?? settings.containsSyntheticMedia;

export type UploadSteps = {
  /** When the last chunk was first sent: from then on the video may exist even if no answer said so (never restarted blindly). */
  finalChunkSentAt?: string;
  /** When YouTube's answer gave the video id: the upload's own time (the record) and the start of the processing wait. */
  uploadedAt?: string;
  /** Unknown answers in a row at the current step (a 5xx, a timeout, a network failure); reset by progress. */
  retries?: number;
  /**
   * The publish time, written last. `withheld`: not written because the thumbnail, the playlist or the read-back failed -- the video
   * stays private without a date. `at_insert`: only a row whose session began before owner msgs 3510/3511 (`publishAtAtInsert`),
   * when the date still went in with the insert; never made for a new row.
   */
  publishAt?: "at_insert" | "set" | "skipped_too_soon" | "withheld" | "failed";
  /**
   * BL-225 stage 3: the package's translations, written first after processing by the shared writer (identity, backup, merge, Live
   * writes, read-back). `none`: the package has none. Anything but `verified` / `none` withholds the date.
   */
  localizations?: "verified" | "mismatch" | "failed" | "none";
  /**
   * BL-225 stage 3 (ADR 0051 §5, §10): the last change the plan made to the video's date after the upload -- a veto removed it, an
   * approval (or a re-approval with a new time) set it. Read back before it is stored.
   */
  planSync?: { at: string; action: "scheduled" | "unscheduled"; publishAt: string | null; result: "verified" | "mismatch" | "refused"; reason?: string };
  thumbnail?: "set" | "failed";
  playlist?: "added" | "already_there" | "none" | "failed";
  verify?: { result: "verified" | "mismatch"; mismatches: string[] };
  /**
   * Read-backs that differed and were read again later (independent review: YouTube can lag right after processing). The date
   * hangs on the read-back, so a difference is read again up to READ_BACK_RETRIES times, READ_BACK_RETRY_DELAY_MS apart (video-
   * details' own constants), before it counts as a mismatch.
   */
  verifyRereads?: number;
  record?: "written" | "failed";
  /** BL-194 stage 3 (ADR 0041): `Vn_cost.json` next to the package, written with the record (never a reason to fail the upload). */
  cost?: "written" | "failed";
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
    /** Takes the row for this runner until `until`; false while another runner's lease runs (review should-fix 6). */
    claim(id: string, owner: string, until: Date, now: Date): Promise<boolean>;
  };
  /** The approver's Google user for the channel, with the upload scope; and the identity check (write-context). */
  credentials(job: StoredPublishingUpload): Promise<UploadCredentials>;
  assertWriteChannel(args: { channelId: string } & UploadCredentials): Promise<void>;
  accessToken(credentials: unknown): Promise<string>;
  liveWritesEnabled(): Promise<boolean>;
  gateway: {
    begin(args: { accessToken: string; resource: InsertResource; contentLength: number; contentType: string; notifySubscribers: boolean }): Promise<{ sessionUri: string }>;
    /** `pace` (BL-233): waits before each slice of the body while the upload is limited; absent = sent at full speed. */
    putChunk(args: { accessToken: string; sessionUri: string; chunk: Buffer; start: number; total: number; contentType: string; pace?: (bytes: number) => Promise<void> }): Promise<UploadHttpProgress>;
    queryOffset(args: { accessToken: string; sessionUri: string; total: number }): Promise<UploadHttpProgress>;
    setThumbnail(credentials: unknown, videoId: string, image: { mimeType: string; bytes: Buffer }): Promise<void>;
    addToPlaylist(credentials: unknown, videoId: string, playlistId: string): Promise<void>;
  };
  reads: {
    /** `videos.list` status and processing of one video; null when YouTube does not return it. */
    uploadState(credentials: unknown, videoId: string): Promise<{ uploadStatus: string | null; rejectionReason: string | null; failureReason: string | null; hasPaidProductPlacement?: boolean | null; hasCustomThumbnail?: boolean | null } | null>;
    /** The channel's newest uploads (first page of its uploads playlist, private ones included for its own user). */
    recentUploads(credentials: unknown, channelId: string): Promise<Array<{ videoId: string; title: string }>>;
    playlistHasVideo(credentials: unknown, playlistId: string, videoId: string): Promise<boolean>;
    /** The video as YouTube has it now (video-details' snapshot), for the read-back. */
    snapshot(args: { channelId: string; videoId: string } & UploadCredentials): Promise<VideoReadBack>;
  };
  /** The publish time, written last, through video-details' own write path (backup, read-modify-write, read-back, audit). */
  setPublishAt(args: { channelId: string; videoId: string; publishAt: string; containsSyntheticMedia: boolean } & UploadCredentials): Promise<void>;
  /**
   * BL-225 stage 3 (AGENTS.md §F «Upload localizations»): the package's translations onto the video this upload made, by the shared
   * video translations writer -- identity, a fresh read, never the video's own language, backup, the safe merge, Live writes right
   * before its one `videos.update`, read-back, audit. Absent: a package with translations gets its date withheld.
   */
  /**
   * Review #1 (BL-225, ADR 0051 §7): the weekly plan's decision on the row's slot NOW (the composition layer reads the plan module),
   * asked before a queued row starts and right before the date step; absent (the plan module off): the row's own date stands.
   */
  slotDecision?(channelId: string, slotId: string): Promise<SlotDecision | null>;
  writeLocalizations?(args: {
    channelId: string;
    videoId: string;
    localizations: Record<string, { title: string; description: string }>;
    expected: { tags: string[]; categoryId: string; defaultLanguage: string; defaultAudioLanguage: string };
  } & UploadCredentials): Promise<{ verified: true } | { verified: false; detail: string }>;
  files: {
    /** A file of the channel's workspace by the workspace rule; null when it is not there (or not inside). */
    resolve(channelId: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
    readChunk(path: string, start: number, length: number): Promise<Buffer>;
    sha256(path: string): Promise<string>;
    /** Writes `Vn_youtube.json` next to the package (atomically). */
    writeRecord(channelId: string, relativePath: string, record: unknown): Promise<void>;
  };
  audit(args: { channelId: string; videoId: string | null; detail: Record<string, unknown> }): Promise<void>;
  /**
   * BL-194 stage 3 (VIDEO_COST_PLAN.md §2 stage 3, ADR 0041): writes `Vn_cost.json` -- the video's visual cost -- into the package's
   * folder (workspace-relative). Absent = not written. A failure is a note on the upload, never a failed step.
   */
  costFile?(args: { channelId: string; video: string; folder: string }): Promise<void>;
  syncChannel(args: { channelId: string } & UploadCredentials): Promise<void>;
  device(): Promise<{ deviceId: string | null; hostname: string | null }>;
  clock: { now(): Date };
  /** The next YouTube quota day (midnight Pacific). */
  nextQuotaReset(now: Date): Date;
  /**
   * BL-233 (FO-REQ-0047): the upload's share of this computer's uplink while live streams run here (the app layer plugs in the
   * live-streams reader; absent = never limited). `mayStart` is asked before an upload starts or resumes and before every chunk
   * -- false holds it with nothing sent or asked; `chunkBytes` sizes a limited chunk; `pace` paces each chunk's body.
   */
  bandwidth?: {
    mayStart(): Promise<boolean>;
    chunkBytes(defaultBytes: number): number;
    pace(bytes: number): Promise<void>;
  };
  /** Bytes per request (a multiple of 256 KB) and how long one tick keeps sending. */
  chunkBytes: number;
  sliceMs: number;
  /** This runner's name for its leases (one per process). */
  runnerId: string;
};

export type InsertResource = {
  snippet: { title: string; description: string; tags?: string[]; categoryId?: string; defaultLanguage?: string; defaultAudioLanguage?: string };
  /** Never a `publishAt` (owner msgs 3510/3511): the date is written last, after the read-back. */
  status: { privacyStatus: "private"; selfDeclaredMadeForKids: boolean; containsSyntheticMedia?: boolean; license?: "youtube" | "creativeCommon"; embeddable?: boolean };
  paidProductPlacementDetails?: { hasPaidProductPlacement: boolean };
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
  /** YouTube accepts it but does not return it (G1): null is unverifiable, never a mismatch; a value that differs is one. */
  containsSyntheticMedia?: boolean | null;
  license: string | null;
  embeddable: boolean | null;
};

/** video-details' own rule: a publish time 15 minutes ahead or less is not written (the video could publish before the write). */
const PUBLISH_AT_MARGIN_MS = 15 * 60_000;
const PROCESSING_POLL_MS = 30_000;
const PROCESSING_SLOW_POLL_MS = 5 * 60_000;
/** A video YouTube stops returning for this long after its upload was deleted (in Studio); processing longer than a day stops. */
const VIDEO_MISSING_AFTER_MS = 30 * 60_000;
const PROCESSING_GIVE_UP_MS = 24 * 3_600_000;
const UPLOAD_LIMIT_PAUSE_MS = 24 * 3_600_000;
const AUTH_RETRY_MS = 15 * 60_000;
/** Unknown answers in a row before a step gives up (about 40 minutes with the growing wait). */
const MAX_RETRIES = 10;
/** After the last chunk, an unanswered session is asked again this often, for as long as a session lives (about a week). */
const AFTER_LAST_CHUNK_RETRY_MS = 30 * 60_000;
const SESSION_LIFETIME_MS = 7 * 24 * 3_600_000;
const LEASE_MS = 2 * 60_000;
const ACTIVE: ReadonlyArray<StoredPublishingUpload["status"]> = ["queued", "uploading", "processing", "finishing", "paused"];

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const stepsOf = (job: Pick<StoredPublishingUpload, "stepsJson">) => parseJson<UploadSteps>(job.stepsJson, {});

/**
 * The parts of an error that decide what happens next, whatever its shape: a domain error (its code, `details.status`,
 * `details.reason`, `details.reasons`), a googleapis/gaxios error (`response.status`, `response.data.error.errors[].reason`, or a
 * top-level `errors[]` in older gaxios), or a plain network error (`code` such as ECONNRESET, TimeoutError).
 */
function errorInfo(error: unknown): { code: string | null; reasons: string[]; status: number | null; message: string } {
  const e = error as {
    code?: unknown;
    status?: unknown;
    name?: unknown;
    details?: { reason?: unknown; reasons?: unknown; status?: unknown };
    errors?: Array<{ reason?: unknown }>;
    response?: { status?: unknown; data?: { error?: { errors?: Array<{ reason?: unknown }> } } };
  } | null;
  const status = [e?.details?.status, e?.response?.status, e?.status, e?.code].find((value): value is number => typeof value === "number") ?? null;
  const reasons = [
    e?.details?.reason,
    ...(Array.isArray(e?.details?.reasons) ? e.details.reasons : []),
    ...(Array.isArray(e?.response?.data?.error?.errors) ? e.response.data.error.errors.map((x) => x?.reason) : []),
    ...(Array.isArray(e?.errors) ? e.errors.map((x) => x?.reason) : []),
  ].filter((value): value is string => typeof value === "string");
  const code = typeof e?.code === "string" ? e.code : typeof e?.name === "string" && /^(TimeoutError|AbortError)$/.test(e.name) ? e.name : null;
  return { code, reasons, status, message: error instanceof Error ? error.message : String(error) };
}

/** Codes that only say "it did not work" without saying it was refused (video-details wraps a lost answer into these). */
const AMBIGUOUS_CODES = new Set(["update_failed", "not_found", "backup_infrastructure_unavailable", "internal_error", "TimeoutError", "AbortError"]);

export type UploadErrorOutcome =
  | { kind: "pause"; reason: "live_writes_off" | "quota_exceeded" | "upload_limit" | "auth"; until: Date | null }
  | { kind: "retry"; message: string }
  | { kind: "fail"; code: string; message: string };

/**
 * What an error means for a job (review B3): Live writes off, quota and the upload cap pause it until they come back; a 5xx, a
 * 429, a timeout, a network failure or an answer that does not say "refused" is asked again (a bounded number of times); a
 * refusal (a 4xx, a validation, a wrong channel) fails it.
 */
export function classifyUploadError(error: unknown, now: Date, nextQuotaReset: (now: Date) => Date): UploadErrorOutcome {
  const info = errorInfo(error);
  if (info.code === "live_writes_disabled") return { kind: "pause", reason: "live_writes_off", until: null };
  if (info.code === "youtube_quota_exceeded" || info.reasons.some((r) => r === "quotaExceeded" || r === "dailyLimitExceeded")) {
    return { kind: "pause", reason: "quota_exceeded", until: nextQuotaReset(now) };
  }
  if (info.reasons.includes("uploadLimitExceeded")) return { kind: "pause", reason: "upload_limit", until: new Date(now.getTime() + UPLOAD_LIMIT_PAUSE_MS) };
  if (info.code === "unauthorized" || info.code === "AUTH_SCOPE_INSUFFICIENT" || /invalid_grant/i.test(info.message)) {
    return { kind: "pause", reason: "auth", until: new Date(now.getTime() + AUTH_RETRY_MS) };
  }
  if (info.status !== null) {
    if (info.status >= 500 || info.status === 429 || info.reasons.some((r) => /rateLimitExceeded|backendError/.test(r))) return { kind: "retry", message: info.message };
    return { kind: "fail", code: info.reasons[0] ?? info.code ?? `http_${info.status}`, message: info.message };
  }
  // ECONNRESET, EAI_AGAIN (DNS on a dropped Wi-Fi), ERR_STREAM_PREMATURE_CLOSE, UND_ERR_SOCKET, ... (re-check item 2).
  if (info.code === null || /^(E[A-Z_]+|ERR_[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(info.code) || AMBIGUOUS_CODES.has(info.code)) return { kind: "retry", message: info.message };
  return { kind: "fail", code: info.code, message: info.message };
}

/** Line endings the factory's Windows files may carry; YouTube keeps a description's lines, not their CR (review question). */
export const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, "\n");

/** The UTC instant two read-backs both mean (`...:00Z` and `...:00.000Z` are the same time). */
const sameInstant = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));

/** Every field the read-back shows differently from what was approved; AI use is not readable (G1) and is not compared. */
export function readBackMismatches(after: VideoReadBack, pkg: ApprovedPackage, settings: PublishingSettings, publishAt: string | null, nowMs: number): string[] {
  const mismatches: string[] = [];
  if (after.title !== pkg.title) mismatches.push("title");
  // Seen on the first real uploads (2026-10-13, V50-V57): YouTube drops a description's trailing line breaks and returns the tags
  // sorted -- the same text and the same tags are no mismatch.
  if (normalizeLineEndings(after.description ?? "").trimEnd() !== normalizeLineEndings(pkg.description).trimEnd()) mismatches.push("description");
  if (JSON.stringify([...(after.tags ?? [])].sort()) !== JSON.stringify([...pkg.tags].sort())) mismatches.push("tags");
  if (after.categoryId !== settings.categoryId) mismatches.push("categoryId");
  if (after.defaultLanguage !== pkg.defaultLanguage) mismatches.push("defaultLanguage");
  if (after.defaultAudioLanguage !== pkg.defaultAudioLanguage) mismatches.push("defaultAudioLanguage");
  const published = publishAt !== null && Date.parse(publishAt) <= nowMs;
  if (after.privacyStatus !== "private" && !(published && after.privacyStatus === "public")) mismatches.push("privacyStatus");
  if (publishAt !== null && !published && !sameInstant(after.publishAt, publishAt)) mismatches.push("publishAt");
  // Independent review: no date is expected yet (a new row before its date step, or an undated one) -- a video that already has
  // one would be scheduled before it was verified.
  if (publishAt === null && after.publishAt !== null && after.publishAt !== undefined) mismatches.push("publishAt");
  if (after.selfDeclaredMadeForKids !== settings.madeForKids) mismatches.push("madeForKids");
  if (after.containsSyntheticMedia !== null && after.containsSyntheticMedia !== undefined && after.containsSyntheticMedia !== syntheticMediaOf(pkg, settings)) mismatches.push("containsSyntheticMedia");
  if (after.license !== settings.license) mismatches.push("license");
  if (after.embeddable !== settings.embeddable) mismatches.push("embeddable");
  return mismatches;
}

const recordPath = (pkg: ApprovedPackage) => `${pkg.manifestPath.slice(0, pkg.manifestPath.lastIndexOf("/"))}/${pkg.video}_youtube.json`;

export function createUploadRunner(deps: UploadRunnerDeps) {
  const now = () => deps.clock.now();

  async function pause(job: StoredPublishingUpload, outcome: Extract<UploadErrorOutcome, { kind: "pause" }>): Promise<void> {
    await deps.store.update(job.id, job.status, {
      status: "paused",
      resumeStatus: job.status === "paused" ? job.resumeStatus : job.status,
      pausedReason: outcome.reason,
      pausedUntil: outcome.until,
      updatedAt: now(),
    });
  }

  /** A terminal failure. A row whose video exists keeps it, so the package stays blocked (review B1). */
  async function fail(job: StoredPublishingUpload, code: string, message: string): Promise<void> {
    await deps.store.update(job.id, job.status, { status: "failed", errorCode: code, errorMessage: message.slice(0, 2000), finishedAt: now(), updatedAt: now() });
    await deps.audit({ channelId: job.channelId, videoId: job.videoId, detail: { event: "publishing.upload_failed", uploadId: job.id, video: job.video, code, message: message.slice(0, 500) } });
  }

  /**
   * Applies what an error means. A retry is due again after a wait that grows with the retries in a row; after MAX_RETRIES the step
   * gives up through `giveUp` (a finishing step is noted as failed; an upload or the processing wait fails the job).
   */
  async function onError(job: StoredPublishingUpload, error: unknown, giveUp?: (message: string) => Promise<void>): Promise<void> {
    const outcome = classifyUploadError(error, now(), deps.nextQuotaReset);
    if (outcome.kind === "pause") return pause(job, outcome);
    if (outcome.kind === "fail") return giveUp && job.status === "finishing" ? giveUp(outcome.message) : failAfterError(job, outcome.code, outcome.message);
    const steps = stepsOf(job);
    const retries = (steps.retries ?? 0) + 1;
    if (retries > MAX_RETRIES) {
      if (giveUp) return giveUp(outcome.message);
      // After the last chunk the video may exist: the session keeps being asked, slowly, while it can still answer (re-check 1).
      if (job.status === "uploading" && steps.finalChunkSentAt) {
        if (now().getTime() - Date.parse(steps.finalChunkSentAt) > SESSION_LIFETIME_MS) return failAfterError(job, "retries_exhausted", outcome.message);
        await deps.store.update(job.id, job.status, { errorMessage: outcome.message.slice(0, 2000), nextAttemptAt: new Date(now().getTime() + AFTER_LAST_CHUNK_RETRY_MS), stepsJson: JSON.stringify({ ...steps, retries }), updatedAt: now() });
        return;
      }
      return failAfterError(job, "retries_exhausted", outcome.message);
    }
    const waitMs = Math.min(10 * 60_000, 30_000 * retries);
    await deps.store.update(job.id, job.status, { errorMessage: outcome.message.slice(0, 2000), nextAttemptAt: new Date(now().getTime() + waitMs), stepsJson: JSON.stringify({ ...steps, retries }), updatedAt: now() });
  }

  /** While sending, a job whose last chunk may have arrived is never failed into "approvable again" without saying so. */
  async function failAfterError(job: StoredPublishingUpload, code: string, message: string): Promise<void> {
    if (job.status === "uploading" && job.videoId === null && stepsOf(job).finalChunkSentAt) {
      return fail(job, "unknown_outcome", `Every byte was sent, then: ${message}. Look in Studio before approving this package again.`);
    }
    return fail(job, code, message);
  }

  async function identity(job: StoredPublishingUpload): Promise<UploadCredentials> {
    const creds = await deps.credentials(job);
    await deps.assertWriteChannel({ channelId: job.channelId, ...creds });
    return creds;
  }

  /**
   * The video exists: its id is stored before anything else happens to it, and a first `Vn_youtube.json` names it next to the
   * package at once -- so the package reads "uploaded" on every computer that sees the folder, whatever happens next (review B1).
   */
  async function adopt(job: StoredPublishingUpload, pkg: ApprovedPackage, videoId: string, how: "uploaded" | "found"): Promise<void> {
    const uploadedAt = now().toISOString();
    const stepsJson = JSON.stringify({ ...stepsOf(job), uploadedAt, retries: 0 });
    const ok = await deps.store.update(job.id, "uploading", { status: "processing", videoId, storedBytes: job.totalBytes, stepsJson, nextAttemptAt: now(), errorMessage: null, updatedAt: now() });
    if (!ok) return;
    await deps.audit({ channelId: job.channelId, videoId, detail: { event: how === "uploaded" ? "publishing.uploaded" : "publishing.adopted_after_lost_answer", uploadId: job.id, video: job.video } });
    await deps.files
      .writeRecord(job.channelId, recordPath(pkg), { schema: "yt-release-upload/1", channelId: job.channelId, video: pkg.video, videoId, uploadedAt, device: await deps.device(), result: "uploaded" })
      .catch(() => undefined); // the record step writes it again, and notes it if it still cannot
  }

  /**
   * An expired session: a video with this title among the newest uploads is this upload (adopted). Otherwise a new session -- but
   * only when the last chunk was never sent. Once it was, YouTube may have made the video and the uploads list may not show it
   * yet, so the job stops as `unknown_outcome` for the owner to look in Studio (ADR 0037 §4: "adopts it, or asks the owner").
   */
  async function onExpired(job: StoredPublishingUpload, pkg: ApprovedPackage, creds: UploadCredentials): Promise<void> {
    const found = (await deps.reads.recentUploads(creds.credentials, job.channelId)).find((video) => video.title === pkg.title);
    if (found) return adopt(job, pkg, found.videoId, "found");
    if (stepsOf(job).finalChunkSentAt) {
      return fail(job, "unknown_outcome", "Every byte was sent but the upload session expired before YouTube's answer was read, and no video with this title is among the channel's newest uploads yet. Look in Studio before approving this package again: a second upload could make a duplicate.");
    }
    await deps.store.update(job.id, "uploading", { sessionUri: null, storedBytes: 0, updatedAt: now() });
  }

  /**
   * A publish time set at insert that comes within the margin before the last chunk: nothing is made, the owner picks a new date.
   * Only a row whose session began with the date in the insert (before owner msgs 3510/3511); a new row never has one.
   */
  function publishTimePassed(job: StoredPublishingUpload): boolean {
    return job.publishAtAtInsert && job.publishAt !== null && Date.parse(job.publishAt) - now().getTime() <= PUBLISH_AT_MARGIN_MS;
  }

  /** BL-209 review L5: an automatic row whose video file's SHA-256 is no longer its manifest's (false for an approval's row). */
  async function videoHashDiffers(job: StoredPublishingUpload, pkg: ApprovedPackage, filePath: string): Promise<boolean> {
    if (!job.automatic || !pkg.videoSha256) return false;
    return (await deps.files.sha256(filePath)).toLowerCase() !== pkg.videoSha256;
  }

  async function upload(job: StoredPublishingUpload): Promise<void> {
    const pkg = parseJson<ApprovedPackage | null>(job.packageJson, null);
    const settings = parseJson<PublishingSettings | null>(job.settingsJson, null);
    if (!pkg || !settings) return fail(job, "job_damaged", "The approved package of this upload cannot be read.");
    let current = job;
    let hashChecked = false;
    // BL-233: held while a live stream here starves -- before anything is read, hashed or asked (the next tick asks again).
    if (deps.bandwidth && !(await deps.bandwidth.mayStart())) return;
    try {
      if (current.status === "queued") {
        // Review #1: a slot vetoed since the row was queued -- the row stops here, before anything is read or sent.
        if (job.slotId && deps.slotDecision && (await deps.slotDecision(job.channelId, job.slotId))?.kind === "vetoed") {
          if (await deps.store.update(job.id, "queued", { status: "cancelled", errorCode: "slot_vetoed", finishedAt: now(), updatedAt: now() })) {
            await deps.audit({ channelId: job.channelId, videoId: null, detail: { event: "publishing.upload_cancelled_slot_vetoed", uploadId: job.id, video: job.video, slotId: job.slotId } });
          }
          return;
        }
        // The files must still be what the owner approved: the same manifest, a video of the same size.
        const manifest = await deps.files.resolve(job.channelId, pkg.manifestPath);
        if (!manifest || (await deps.files.sha256(manifest.path)) !== job.manifestSha256) return fail(job, "package_changed", "The package changed on disk after it was approved.");
        const videoFile = await deps.files.resolve(job.channelId, pkg.videoFile);
        if (!videoFile || videoFile.bytes !== job.totalBytes) return fail(job, "package_changed", "The video file changed or is missing since it was approved.");
        // Review L5: an automatic row was queued because the file matched its manifest's SHA-256; the file is hashed again before
        // anything reaches YouTube (not even the identity read). A mismatch fails the row for good -- never retried by itself.
        if (await videoHashDiffers(job, pkg, videoFile.path)) return fail(job, VIDEO_HASH_MISMATCH, "The video file no longer matches the SHA-256 in its manifest, so the automatic upload stopped before anything was sent.");
        hashChecked = true;
        await identity(job);
        if (!(await deps.store.update(job.id, "queued", { status: "uploading", attempts: job.attempts + 1, sessionUri: null, storedBytes: 0, updatedAt: now() }))) return;
        current = { ...job, status: "uploading", attempts: job.attempts + 1, sessionUri: null, storedBytes: 0 };
      }
      const creds = await identity(current);
      const token = await deps.accessToken(creds.credentials);
      const contentType = "video/*";
      let stored = current.storedBytes;
      if (current.sessionUri) {
        // Resuming (a restart, a cut connection, a lost answer): the session is asked first, before anything can fail the job --
        // its last chunk may already have made the video (review B2).
        const progress = await deps.gateway.queryOffset({ accessToken: token, sessionUri: current.sessionUri, total: current.totalBytes });
        if ("expired" in progress) return onExpired(current, pkg, creds);
        if (progress.done) return adopt(current, pkg, progress.videoId, "uploaded");
        stored = progress.storedBytes;
      }
      const videoFile = await deps.files.resolve(current.channelId, pkg.videoFile);
      if (!videoFile || videoFile.bytes !== current.totalBytes) return failAfterError(current, "package_changed", "The video file changed or is missing during the upload.");
      if (!current.sessionUri) {
        // A new session after an expired one (no byte of it kept): the automatic row's file is checked again first.
        if (!hashChecked && (await videoHashDiffers(current, pkg, videoFile.path))) {
          return fail(current, VIDEO_HASH_MISMATCH, "The video file no longer matches the SHA-256 in its manifest, so the automatic upload stopped before a new session.");
        }
        // Owner msgs 3510/3511 (FO-REQ-0040 item 4): the insert is private and never carries a publish time, whatever the date; the
        // date is written last, after the thumbnail, the playlist and a passing read-back. The column stays (old rows) and is false.
        const publishAtAtInsert = false;
        const resource: InsertResource = {
          snippet: { title: pkg.title, description: pkg.description, tags: pkg.tags, categoryId: settings.categoryId, defaultLanguage: pkg.defaultLanguage, defaultAudioLanguage: pkg.defaultAudioLanguage },
          status: {
            privacyStatus: "private",
            selfDeclaredMadeForKids: settings.madeForKids,
            // BL-225 stage 3: the package's own AI flag when it has one, else the channel's.
            containsSyntheticMedia: syntheticMediaOf(pkg, settings),
            license: settings.license,
            embeddable: settings.embeddable,
          },
          // Only when the owner turned it on (independent review): with it off -- and for an approval from before the setting -- the
          // insert is exactly as before, so a YouTube that refused the part could never stop ordinary uploads.
          ...(settings.paidProductPlacement === true ? { paidProductPlacementDetails: { hasPaidProductPlacement: true } } : {}),
        };
        const { sessionUri } = await deps.gateway.begin({ accessToken: token, resource, contentLength: current.totalBytes, contentType, notifySubscribers: settings.notifySubscribers });
        // The session is stored before the first byte: a restart resumes it rather than starting another.
        if (!(await deps.store.update(current.id, "uploading", { sessionUri, storedBytes: 0, publishAtAtInsert, updatedAt: now() }))) return;
        current = { ...current, sessionUri, storedBytes: 0, publishAtAtInsert };
        stored = 0;
      }
      const deadline = now().getTime() + deps.sliceMs;
      while (stored < current.totalBytes && now().getTime() < deadline) {
        // BL-233: a hold starts between chunks only (a chunk in flight finishes at the limit); the session stays as it is.
        if (deps.bandwidth && !(await deps.bandwidth.mayStart())) break;
        const length = Math.min(deps.bandwidth ? deps.bandwidth.chunkBytes(deps.chunkBytes) : deps.chunkBytes, current.totalBytes - stored);
        const last = stored + length === current.totalBytes;
        if (!stepsOf(current).finalChunkSentAt && publishTimePassed(current)) {
          // Review should-fix 2: the video would go public the moment it is made, before its thumbnail and playlist.
          return fail(current, "publish_at_passed", "The publish time came within 15 minutes before the upload finished, so it was stopped before its last chunk: nothing was published. Approve the package again with a new date.");
        }
        if (last && !stepsOf(current).finalChunkSentAt) {
          // Stored before the last chunk goes: from now on the video may exist, so the job is never cancelled or restarted blindly.
          const stepsJson = JSON.stringify({ ...stepsOf(current), finalChunkSentAt: now().toISOString() });
          if (!(await deps.store.update(current.id, "uploading", { stepsJson, updatedAt: now() }))) return;
          current = { ...current, stepsJson };
        }
        // The lease is renewed before every chunk: a slow chunk never lets another process take the upload (re-check nit).
        if (!(await deps.store.claim(current.id, deps.runnerId, new Date(now().getTime() + LEASE_MS + 10 * 60_000), now()))) return;
        const chunk = await deps.files.readChunk(videoFile.path, stored, length);
        const pace = deps.bandwidth ? (bytes: number) => deps.bandwidth!.pace(bytes) : undefined;
        const progress = await deps.gateway.putChunk({ accessToken: token, sessionUri: current.sessionUri as string, chunk, start: stored, total: current.totalBytes, contentType, ...(pace ? { pace } : {}) });
        if ("expired" in progress) return onExpired(current, pkg, creds);
        if (progress.done) return adopt(current, pkg, progress.videoId, "uploaded");
        stored = progress.storedBytes;
        const stepsJson = JSON.stringify({ ...stepsOf(current), retries: 0 });
        if (!(await deps.store.update(current.id, "uploading", { storedBytes: stored, stepsJson, errorMessage: null, updatedAt: now() }))) return;
        current = { ...current, storedBytes: stored, stepsJson };
      }
    } catch (error) {
      await onError(current, error);
    } finally {
      // Back to a short lease after the pass (a chunk holds it 12 minutes): a restarted process resumes within LEASE_MS.
      await deps.store.claim(job.id, deps.runnerId, new Date(now().getTime() + LEASE_MS), now()).catch(() => undefined);
    }
  }

  async function processing(job: StoredPublishingUpload): Promise<void> {
    const steps = stepsOf(job);
    const since = Date.parse(steps.uploadedAt ?? job.updatedAt.toISOString());
    try {
      const creds = await deps.credentials(job);
      const state = await deps.reads.uploadState(creds.credentials, job.videoId as string);
      const status = state?.uploadStatus ?? null;
      if (status === "processed") {
        await deps.store.update(job.id, "processing", { status: "finishing", nextAttemptAt: now(), stepsJson: JSON.stringify({ ...steps, retries: 0 }), updatedAt: now() });
        return;
      }
      if (status === "rejected" || status === "failed" || status === "deleted") {
        return fail(job, `processing_${status}`, `YouTube ${status} the video: ${state?.rejectionReason ?? state?.failureReason ?? "no reason given"}`);
      }
      const elapsed = now().getTime() - since;
      // Review should-fix 3: a video YouTube no longer returns (deleted in Studio) or processing that never ends stops the wait.
      if (state === null && elapsed > VIDEO_MISSING_AFTER_MS) return fail(job, "video_missing", "YouTube no longer returns the uploaded video (deleted in Studio?).");
      if (elapsed > PROCESSING_GIVE_UP_MS) return fail(job, "processing_timeout", "YouTube was still processing the video after 24 hours.");
      await deps.store.update(job.id, "processing", { nextAttemptAt: new Date(now().getTime() + (elapsed > 30 * 60_000 ? PROCESSING_SLOW_POLL_MS : PROCESSING_POLL_MS)), updatedAt: now() });
    } catch (error) {
      // The video exists: answers that stay unknown never strand it -- it is polled again slowly until processing's own limit.
      await onError(job, error, async (message) => {
        if (now().getTime() - since > PROCESSING_GIVE_UP_MS) return fail(job, "processing_timeout", `YouTube's processing state could not be read for 24 hours: ${message}`);
        await deps.store.update(job.id, "processing", { errorMessage: message.slice(0, 2000), nextAttemptAt: new Date(now().getTime() + PROCESSING_SLOW_POLL_MS), stepsJson: JSON.stringify({ ...stepsOf(job), retries: 0 }), updatedAt: now() });
      });
    }
  }

  async function saveSteps(job: StoredPublishingUpload, steps: UploadSteps): Promise<boolean> {
    return deps.store.update(job.id, "finishing", { stepsJson: JSON.stringify({ ...steps, retries: 0 }), errorMessage: null, updatedAt: now() });
  }

  /**
   * One step after the upload, in order; each outcome is stored before the next. A failed step is noted, the others still run --
   * except the publish time. Owner msgs 3510/3511 (FO-REQ-0040 item 4): it is written last, after the thumbnail, the playlist and
   * a read-back of everything else, and only when the thumbnail is set, the playlist step did not fail and the read-back verified;
   * otherwise it is withheld and the video stays private without a date. The write is then read back on its own.
   */
  async function finishing(job: StoredPublishingUpload): Promise<void> {
    const pkg = parseJson<ApprovedPackage | null>(job.packageJson, null);
    const settings = parseJson<PublishingSettings | null>(job.settingsJson, null);
    if (!pkg || !settings || !job.videoId) return fail(job, "job_damaged", "The approved package of this upload cannot be read.");
    const steps = stepsOf(job);
    const note = (text: string) => (steps.notes = [...(steps.notes ?? []), text.slice(0, 300)]);
    const videoId = job.videoId;
    let step: "localizations" | "thumbnail" | "playlist" | "verify" | "publishAt" | "record" | "sync" = "thumbnail";
    const giveUp = async (message: string) => {
      if (step === "publishAt" || step === "thumbnail" || step === "playlist" || step === "localizations") steps[step] = "failed";
      else if (step === "verify") steps.verify = { result: "mismatch", mismatches: ["unreadable"] };
      else if (step === "record") steps.record = "failed";
      else steps.sync = "failed";
      note(`${step}: ${message}`);
      await saveSteps(job, steps);
    };
    try {
      const publishAtDue = job.publishAt !== null && steps.publishAt === undefined;
      // A row whose session began before msgs 3510/3511 with the date in the insert: the video already has it. Stored first, so the
      // read-back below checks it; nothing is written for it.
      if (publishAtDue && job.publishAtAtInsert) {
        steps.publishAt = "at_insert";
        return void (await saveSteps(job, steps));
      }
      // The writes below check the channel first, like the upload (review should-fix 1; PUBLISHING_PLAN §3).
      const creds = publishAtDue || steps.thumbnail === undefined || steps.playlist === undefined || steps.localizations === undefined ? await identity(job) : await deps.credentials(job);
      // BL-225 stage 3 (ADR 0051 §8): the package's translations first, onto this upload's own video; the writer reads back.
      step = "localizations";
      const translations = pkg.localizations && Object.keys(pkg.localizations).length > 0 ? pkg.localizations : null;
      // No translations (every v1 package, and a row from before this step): nothing to write -- noted, and the next step runs now.
      if (steps.localizations === undefined && !translations) steps.localizations = "none";
      if (steps.localizations === undefined && translations) {
        const set = translations;
        if (!deps.writeLocalizations) {
          steps.localizations = "failed";
          note("translations: no writer on this computer");
        } else {
          const result = await deps.writeLocalizations({
            channelId: job.channelId,
            videoId,
            localizations: set,
            expected: { tags: pkg.tags, categoryId: settings.categoryId, defaultLanguage: pkg.defaultLanguage, defaultAudioLanguage: pkg.defaultAudioLanguage },
            ...creds,
          });
          if (result.verified) steps.localizations = "verified";
          else {
            steps.localizations = "mismatch";
            note(`translations read back differently: ${result.detail}`);
          }
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
        // «Прямая реклама» is not in the snapshot; the upload state read shows it. Checked only when it was sent: YouTube must say
        // true (not returned, or false, is a mismatch the owner sees). The same read carries `contentDetails.hasCustomThumbnail`
        // (independent review): after a set thumbnail, false is a mismatch; not returned (null) leaves thumbnails.set's 200 as the
        // evidence. Read only when one of them is to be checked.
        if (settings.paidProductPlacement === true || steps.thumbnail === "set") {
          const state = await deps.reads.uploadState(creds.credentials, videoId);
          if (settings.paidProductPlacement === true && state?.hasPaidProductPlacement !== true) mismatches.push("paidProductPlacement");
          if (steps.thumbnail === "set" && state?.hasCustomThumbnail === false) mismatches.push("thumbnail");
        }
        if (mismatches.length > 0 && (steps.verifyRereads ?? 0) < READ_BACK_RETRIES) {
          // Read again later, never decided on one read (independent review): the job waits, the step stays open.
          const stepsJson = JSON.stringify({ ...steps, verifyRereads: (steps.verifyRereads ?? 0) + 1, retries: 0 });
          return void (await deps.store.update(job.id, "finishing", { stepsJson, nextAttemptAt: new Date(now().getTime() + READ_BACK_RETRY_DELAY_MS), updatedAt: now() }));
        }
        steps.verify = { result: mismatches.length === 0 ? "verified" : "mismatch", mismatches };
        return void (await saveSteps(job, steps));
      }
      step = "publishAt";
      // Review #1: the plan's word right before the date -- a veto or (on an automatic row, whose date came from the approval) a slot
      // no longer approved withholds it; an approval with another time replaces it.
      let publishAtNow = job.publishAt;
      let slotWithheld: string | null = null;
      if (job.publishAt !== null && steps.publishAt === undefined && job.slotId && deps.slotDecision) {
        const decision = await deps.slotDecision(job.channelId, job.slotId);
        if (decision?.kind === "vetoed") slotWithheld = "the slot was vetoed";
        else if (decision?.kind === "approved") publishAtNow = new Date(decision.publishAt).toISOString();
        else if (job.automatic) slotWithheld = "the slot is no longer approved";
      }
      if (publishAtNow !== job.publishAt && publishAtNow !== null) {
        if (!(await deps.store.update(job.id, "finishing", { publishAt: publishAtNow, updatedAt: now() }))) return;
        job = { ...job, publishAt: publishAtNow };
      }
      if (slotWithheld && job.publishAt !== null && steps.publishAt === undefined) {
        steps.publishAt = "withheld";
        note(`publish time not set (${slotWithheld}): the video stays private without a date`);
        return void (await saveSteps(job, steps));
      }
      if (job.publishAt !== null && steps.publishAt === undefined) {
        const failedBefore = [
          // BL-225 stage 3: a package's translations must be on the video, read back, before it gets a date.
          steps.localizations === undefined || steps.localizations === "none" || steps.localizations === "verified" ? null : "translations",
          steps.thumbnail === "set" ? null : "thumbnail",
          steps.playlist === "failed" ? "playlist" : null,
          steps.verify.result === "verified" ? null : "read-back",
        ].filter(
          (name): name is string => name !== null
        );
        if (failedBefore.length > 0) {
          steps.publishAt = "withheld";
          note(`publish time not set (${failedBefore.join(", ")} failed): the video stays private without a date`);
        } else if (Date.parse(job.publishAt) - now().getTime() <= PUBLISH_AT_MARGIN_MS) {
          steps.publishAt = "skipped_too_soon";
        } else {
          // A write whose answer was lost and is asked again: the date may already be there, and is not written twice.
          const before = await deps.reads.snapshot({ channelId: job.channelId, videoId, ...creds });
          if (!(before.privacyStatus === "private" && sameInstant(before.publishAt, job.publishAt))) {
            await deps.setPublishAt({ channelId: job.channelId, videoId, publishAt: job.publishAt, containsSyntheticMedia: syntheticMediaOf(pkg, settings), ...creds });
          }
          // The date itself, read back: private with exactly this time, or the step failed (the video is not marked scheduled).
          const after = await deps.reads.snapshot({ channelId: job.channelId, videoId, ...creds });
          if (after.privacyStatus === "private" && sameInstant(after.publishAt, job.publishAt)) steps.publishAt = "set";
          else {
            steps.publishAt = "failed";
            note(`publishAt: read back as ${after.publishAt ?? "none"} (${after.privacyStatus ?? "no privacy status"})`);
          }
        }
        return void (await saveSteps(job, steps));
      }
      step = "record";
      if (steps.record === undefined) {
        try {
          await deps.files.writeRecord(job.channelId, recordPath(pkg), {
            schema: "yt-release-upload/1",
            channelId: job.channelId,
            video: pkg.video,
            videoId,
            publishAt: steps.publishAt === "at_insert" || steps.publishAt === "set" ? job.publishAt : null,
            uploadedAt: steps.uploadedAt ?? now().toISOString(),
            device: await deps.device(),
            result: steps.verify.result,
            mismatches: steps.verify.mismatches,
          });
          steps.record = "written";
        } catch (error) {
          steps.record = "failed";
          note(`upload record not written: ${errorInfo(error).message}`);
        }
        if (deps.costFile) {
          try {
            await deps.costFile({ channelId: job.channelId, video: pkg.video, folder: pkg.manifestPath.slice(0, pkg.manifestPath.lastIndexOf("/")) });
            steps.cost = "written";
          } catch (error) {
            steps.cost = "failed";
            note(`${pkg.video}_cost.json not written: ${errorInfo(error).message}`);
          }
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
      const problem = steps.verify.result === "mismatch" || steps.localizations === "mismatch" ? "verify_mismatch" : [steps.publishAt, steps.thumbnail, steps.playlist, steps.record, steps.localizations].includes("failed") ? "step_failed" : steps.publishAt === "skipped_too_soon" ? "publish_at_too_soon" : null;
      if (await deps.store.update(job.id, "finishing", { status: "done", stepsJson: JSON.stringify(steps), errorCode: problem, finishedAt: now(), updatedAt: now() })) {
        await deps.audit({ channelId: job.channelId, videoId, detail: { event: "publishing.upload_done", uploadId: job.id, video: job.video, steps } });
      }
    } catch (error) {
      // A refused write does not undo the upload: it is noted and the next step runs; a pause waits; an unknown answer is asked
      // again a bounded number of times.
      await onError(job, error, giveUp);
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

  /** This runner's lease on a row for the pass; a row another process works on is left alone (review should-fix 6). */
  const claim = (job: StoredPublishingUpload) => deps.store.claim(job.id, deps.runnerId, new Date(now().getTime() + LEASE_MS), now());

  return {
    /**
     * One pass: resume what can resume, advance one sent upload by one step, then keep one upload's bytes flowing for a slice.
     * A quota pause holds every queued upload back (the quota is the project's); an upload-cap pause holds that channel's.
     */
    async tick(): Promise<void> {
      await resumePaused(await deps.store.listActive());
      const jobs = (await deps.store.listActive()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const at = now().getTime();
      const due = (job: StoredPublishingUpload) => job.nextAttemptAt === null || job.nextAttemptAt.getTime() <= at;
      const afterUpload = jobs.find((job) => (job.status === "processing" || job.status === "finishing") && due(job));
      if (afterUpload && (await claim(afterUpload))) await (afterUpload.status === "processing" ? processing(afterUpload) : finishing(afterUpload));
      const pausedFor = (reason: string) => jobs.filter((job) => job.status === "paused" && job.pausedReason === reason);
      const quotaHeld = pausedFor("quota_exceeded").length > 0;
      const capHeld = new Set(pausedFor("upload_limit").map((job) => job.channelId));
      const liveWritesHeld = pausedFor("live_writes_off").some((job) => job.resumeStatus === "uploading");
      const sending = jobs.find((job) => job.status === "uploading");
      const next = sending ?? (quotaHeld || liveWritesHeld ? undefined : jobs.find((job) => job.status === "queued" && !capHeld.has(job.channelId) && due(job)));
      if (next && due(next) && (await claim(next))) await upload(next);
    },
    /** Whether an upload is being sent or finished now (the idle watcher keeps the session while it is). */
    async isBusy(): Promise<boolean> {
      return (await deps.store.listActive()).some((job) => job.status === "uploading" || job.status === "processing" || job.status === "finishing");
    },
  };
}

/**
 * Whether the owner may cancel an upload: only before it can have reached YouTube -- queued, or paused while sending with its last
 * chunk never sent. Once the last chunk went the video may exist (an answer can be lost), so it is finished instead (review B2).
 */
export function isCancellable(row: Pick<StoredPublishingUpload, "status" | "resumeStatus" | "videoId" | "storedBytes" | "totalBytes" | "stepsJson">): boolean {
  if (row.status === "queued") return true;
  return (
    row.status === "paused" &&
    (row.resumeStatus === "queued" || row.resumeStatus === "uploading") &&
    row.videoId === null &&
    row.storedBytes < row.totalBytes &&
    !stepsOf(row).finalChunkSentAt
  );
}

/** Whether the upload's date is on the video (written, or in an old row's insert) -- not merely planned (independent review). */
export function isPublishAtSet(row: Pick<StoredPublishingUpload, "stepsJson">): boolean {
  const value = stepsOf(row).publishAt;
  return value === "set" || value === "at_insert";
}

/** BL-209 review L5: an automatic upload whose video no longer matched its manifest's SHA-256 before a session started. */
export const VIDEO_HASH_MISMATCH = "video_hash_mismatch";

/** The owner looked in Studio and found no video: the `unknown_outcome` row stops holding its package (re-check 1). */
export const UNKNOWN_OUTCOME_RELEASED = "unknown_outcome_released";

/**
 * A row that holds its package: under way, done, one whose video exists whatever became of the job (review B1), or one whose
 * outcome is unknown (its last chunk went) until the owner releases it after looking in Studio (re-check 1).
 */
export function holdsPackage(row: Pick<StoredPublishingUpload, "status" | "videoId" | "errorCode">): boolean {
  return (ACTIVE as readonly string[]).includes(row.status) || row.status === "done" || row.videoId !== null || row.errorCode === "unknown_outcome";
}

export type UploadRunner = ReturnType<typeof createUploadRunner>;
export const ACTIVE_UPLOAD_STATUSES = ACTIVE;
