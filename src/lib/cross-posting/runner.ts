import type { MetaClient, UploadBody } from "@/lib/social-gateway";
import { zonedInstant } from "@/lib/zoned-time";
import { DomainError, type SocialNetwork } from "./contracts";
import { parseCrossPostBlock, videoProblems, type CrossPostTarget } from "./cross-post-block";

// ---------------------------------------------------------------------------
// BL-252 stage 2 (ADR 0068 amendment 1): the runner. For every APPROVED weekly-plan slot whose package carries a `crossPost`
// block, it posts the package's video to each listed network at the planned time -- on this computer only while its switch
// «Публикация в соцсети» is on. One job per (channel, slot, network):
//   uploading  -> the container / Reel is being created and the bytes sent (nothing public yet)
//   processing -> Meta is processing; Instagram is published once its container is FINISHED, Facebook was published by `finish`
//   published  -> done, with the post id and permalink          failed -> done, with a code (the owner can retry)
// The remote id is stored before the publish / finish call (AC-XP-6). Immediately before each publishing call: the switch (in the
// gateway), the slot still approved for the same manifest (AC-XP-10), and the identity read (AC-XP-8).
// ---------------------------------------------------------------------------

/** One approved slot with a `crossPost` block, as the composition layer reads it (plan decision + package scan). */
export type PlannedCrossPost = {
  channelId: string;
  slotId: string;
  video: string;
  /** The manifest SHA-256 the owner's approval names. */
  manifestSha256: string;
  /** The slot's own release time (UTC ms) and day / zone, for a network's `at`. */
  publishAt: number;
  slotDate: string;
  timeZone: string;
  crossPost: unknown;
  videoFile: { path: string; sizeBytes: number | null; durationSeconds: number | null; width: number | null; height: number | null } | null;
  isAiGenerated: boolean;
};

export type SocialJobStatus = "uploading" | "processing" | "published" | "failed";

export type SocialJob = {
  jobId: string;
  channelId: string;
  slotId: string;
  video: string;
  network: SocialNetwork;
  manifestSha256: string;
  plannedAt: number;
  status: SocialJobStatus;
  remoteId: string | null;
  uploadUrl: string | null;
  remotePostId: string | null;
  permalink: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PostingTarget = { token: string; pageId: string; igUserId: string | null };

export type RunnerDeps = {
  plan: { entries(): Promise<PlannedCrossPost[]>; stillApproved(entry: PlannedCrossPost): Promise<boolean> };
  jobs: {
    get(jobId: string): Promise<SocialJob | null>;
    /** Jobs still `uploading` / `processing` (also those whose slot no longer lists the network). */
    listActive(): Promise<SocialJob[]>;
    insert(job: SocialJob): Promise<boolean>;
    update(jobId: string, set: Partial<SocialJob>): Promise<void>;
  };
  /** The channel's Page token and ids after the identity read passed; throws `social_account_mismatch` otherwise. */
  postingTarget(channelId: string): Promise<PostingTarget>;
  meta: Pick<MetaClient, "igCreateReelContainer" | "igUploadReel" | "igContainerStatus" | "igPublish" | "igPermalink" | "fbReelStart" | "fbUploadReel" | "fbReelFinish" | "fbVideoStatus">;
  files: { body(path: string, sizeBytes: number): UploadBody };
  enabled(): Promise<boolean>;
  now(): number;
};

/** A post more than this late (the computer was off at the planned time) is not sent; the owner can retry it. */
export const MAX_LATE_MS = 12 * 60 * 60_000;
/** Meta processing that does not finish in this time fails the job (Instagram: a container expires after 24 h). */
export const PROCESSING_TIMEOUT_MS = 60 * 60_000;

export const jobIdOf = (channelId: string, slotId: string, network: SocialNetwork) => `${channelId}|${slotId}|${network}`;

export function plannedAtOf(entry: PlannedCrossPost, target: CrossPostTarget): number {
  return target.at ? zonedInstant({ localDate: entry.slotDate, localTime: target.at, timezone: entry.timeZone }).getTime() : entry.publishAt;
}

function errorParts(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof DomainError) return { errorCode: error.code, errorMessage: error.message.slice(0, 500) };
  return { errorCode: "internal_error", errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
}

export function createCrossPostRunner(deps: RunnerDeps) {
  let running: Promise<TickReport> | null = null;

  type TickReport = { skipped?: "disabled"; started: string[]; advanced: string[]; failed: string[] };

  async function fail(jobId: string, errorCode: string, errorMessage: string, report: TickReport) {
    await deps.jobs.update(jobId, { status: "failed", errorCode, errorMessage, updatedAt: deps.now() });
    report.failed.push(jobId);
  }

  async function start(entry: PlannedCrossPost, target: CrossPostTarget, plannedAt: number, report: TickReport) {
    const jobId = jobIdOf(entry.channelId, entry.slotId, target.network);
    const now = deps.now();
    const base: SocialJob = { jobId, channelId: entry.channelId, slotId: entry.slotId, video: entry.video, network: target.network, manifestSha256: entry.manifestSha256, plannedAt, status: "uploading", remoteId: null, uploadUrl: null, remotePostId: null, permalink: null, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now };
    if (now - plannedAt > MAX_LATE_MS) {
      if (await deps.jobs.insert({ ...base, status: "failed", errorCode: "missed_window", errorMessage: "This computer was not posting at the planned time." })) report.failed.push(jobId);
      return;
    }
    if (!(await deps.plan.stillApproved(entry))) return;
    if (!(await deps.jobs.insert(base))) return; // another tick already started it
    report.started.push(jobId);
    try {
      const file = entry.videoFile;
      if (!file || file.sizeBytes === null) throw new DomainError({ code: "validation_failed", message: "The package's video file is not readable." });
      const ctx = await deps.postingTarget(entry.channelId);
      const body = deps.files.body(file.path, file.sizeBytes);
      if (target.network === "instagram") {
        if (!ctx.igUserId) throw new DomainError({ code: "social_account_mismatch", message: "No Instagram account is connected for this channel." });
        const { containerId } = await deps.meta.igCreateReelContainer({ igUserId: ctx.igUserId, token: ctx.token, caption: target.caption, shareToFeed: target.shareToFeed, isAiGenerated: entry.isAiGenerated });
        await deps.jobs.update(jobId, { remoteId: containerId, updatedAt: deps.now() });
        await deps.meta.igUploadReel({ containerId, token: ctx.token, body });
        await deps.jobs.update(jobId, { status: "processing", updatedAt: deps.now() });
      } else {
        const { videoId, uploadUrl } = await deps.meta.fbReelStart({ pageId: ctx.pageId, token: ctx.token });
        await deps.jobs.update(jobId, { remoteId: videoId, uploadUrl, updatedAt: deps.now() });
        await deps.meta.fbUploadReel({ uploadUrl, token: ctx.token, body });
        if (!(await deps.plan.stillApproved(entry))) throw new DomainError({ code: "social_approval_stale", message: "The slot's approval no longer covers this package; nothing was published." });
        // `processing` BEFORE finish: a crash after Meta accepted `finish` must never lead to a second post.
        await deps.jobs.update(jobId, { status: "processing", updatedAt: deps.now() });
        await deps.meta.fbReelFinish({ pageId: ctx.pageId, token: ctx.token, videoId, title: target.network === "facebook" ? target.title : null, description: target.description, isAiGenerated: entry.isAiGenerated });
      }
    } catch (error) {
      const { errorCode, errorMessage } = errorParts(error);
      await fail(jobId, errorCode, errorMessage, report);
    }
  }

  async function advance(job: SocialJob, entry: PlannedCrossPost | undefined, report: TickReport) {
    const now = deps.now();
    if (job.status === "uploading") {
      // An upload this process is not running any more (a restart mid-upload): nothing was published -- fail, the owner may retry.
      await fail(job.jobId, "interrupted", "The upload was interrupted (the app restarted); nothing was published.", report);
      return;
    }
    if (job.status !== "processing" || !job.remoteId) return;
    try {
      const ctx = await deps.postingTarget(job.channelId);
      if (job.network === "instagram") {
        const status = await deps.meta.igContainerStatus({ containerId: job.remoteId, token: ctx.token });
        if (status === "PUBLISHED") {
          await deps.jobs.update(job.jobId, { status: "published", updatedAt: now });
          report.advanced.push(job.jobId);
        } else if (status === "FINISHED") {
          if (!entry || entry.manifestSha256 !== job.manifestSha256 || !(await deps.plan.stillApproved(entry))) {
            await fail(job.jobId, "social_approval_stale", "The slot's approval no longer covers this package; nothing was published.", report);
            return;
          }
          if (!ctx.igUserId) throw new DomainError({ code: "social_account_mismatch", message: "No Instagram account is connected for this channel." });
          const { mediaId } = await deps.meta.igPublish({ igUserId: ctx.igUserId, containerId: job.remoteId, token: ctx.token });
          await deps.jobs.update(job.jobId, { status: "published", remotePostId: mediaId, updatedAt: deps.now() });
          const permalink = await deps.meta.igPermalink({ mediaId, token: ctx.token }).catch(() => null);
          if (permalink) await deps.jobs.update(job.jobId, { permalink });
          report.advanced.push(job.jobId);
        } else if (status === "ERROR" || status === "EXPIRED") {
          await fail(job.jobId, `instagram_${status.toLowerCase()}`, `Instagram could not process the video (${status}).`, report);
        } else if (now - job.updatedAt > PROCESSING_TIMEOUT_MS) {
          await fail(job.jobId, "processing_timeout", "Instagram did not finish processing in time.", report);
        }
      } else {
        const s = await deps.meta.fbVideoStatus({ videoId: job.remoteId, token: ctx.token });
        if (s.publishStatus === "published" || s.videoStatus === "ready") {
          await deps.jobs.update(job.jobId, { status: "published", remotePostId: job.remoteId, permalink: s.permalink, updatedAt: now });
          report.advanced.push(job.jobId);
        } else if (s.videoStatus === "error" || s.videoStatus === "upload_failed" || s.publishStatus === "error") {
          await fail(job.jobId, "facebook_error", "Facebook could not process the Reel.", report);
        } else if (now - job.updatedAt > PROCESSING_TIMEOUT_MS) {
          await fail(job.jobId, "processing_timeout", "Facebook did not finish processing in time.", report);
        }
      }
    } catch (error) {
      const { errorCode, errorMessage } = errorParts(error);
      await fail(job.jobId, errorCode, errorMessage, report);
    }
  }

  async function tickOnce(): Promise<TickReport> {
    const report: TickReport = { started: [], advanced: [], failed: [] };
    if (!(await deps.enabled())) return { ...report, skipped: "disabled" };
    const entries = await deps.plan.entries();
    const visited = new Set<string>();
    for (const entry of entries) {
      const { targets, problems } = parseCrossPostBlock(entry.crossPost);
      const video = entry.videoFile ?? { durationSeconds: null, sizeBytes: null, width: null, height: null };
      const badNetworks = new Set([...problems, ...videoProblems(targets, video)].map((p) => p.network));
      if (badNetworks.has(null)) continue; // the block itself is broken: nothing from it is posted
      for (const target of targets) {
        const jobId = jobIdOf(entry.channelId, entry.slotId, target.network);
        visited.add(jobId);
        const job = await deps.jobs.get(jobId);
        if (job) {
          if (job.status === "uploading" || job.status === "processing") await advance(job, entry, report);
          continue;
        }
        if (badNetworks.has(target.network)) continue;
        const plannedAt = plannedAtOf(entry, target);
        if (deps.now() < plannedAt) continue;
        await start(entry, target, plannedAt, report);
      }
    }
    // A job whose slot was withdrawn or changed after it started: an Instagram container is never published then (no entry, so
    // the approval check fails); a Facebook Reel already published by `finish` is still read back to `published`.
    for (const job of await deps.jobs.listActive()) {
      if (!visited.has(job.jobId)) await advance(job, entries.find((e) => e.channelId === job.channelId && e.slotId === job.slotId), report);
    }
    return report;
  }

  return {
    /** One pass; a pass already running is joined, never doubled. */
    tick(): Promise<TickReport> {
      if (!running) running = tickOnce().finally(() => (running = null));
      return running;
    },
    /** True while an upload is in flight (restart-when-idle waits for it, §N). */
    busy: () => running !== null,
  };
}

export type CrossPostRunner = ReturnType<typeof createCrossPostRunner>;
