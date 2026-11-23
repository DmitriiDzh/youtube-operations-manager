import type { MetaClient, UploadBody } from "@/lib/social-gateway";
import { zonedInstant } from "@/lib/zoned-time";
import { DomainError, SOCIAL_NETWORKS, type PostingTarget, type SocialNetwork } from "./contracts";
import { parseCrossPostBlock, videoProblems, type CrossPostTarget } from "./cross-post-block";

export type { PostingTarget };

// ---------------------------------------------------------------------------
// BL-252 stage 2 (ADR 0068 amendment 1): the runner. For every APPROVED weekly-plan slot whose package carries a `crossPost`
// block, it posts the package's video to each listed network at the planned time -- on this computer only while its switch
// «Публикация в соцсети» is on. One job per (channel, slot, network):
//   uploading  -> the container / Reel is being created and the bytes sent (nothing public yet)
//   processing -> Meta is processing; Instagram is published once its container is FINISHED, Facebook was published by `finish`
//   published  -> done, with the post id and permalink          failed -> done, with a code (the owner can retry)
// The remote id is stored before the publish / finish call (AC-XP-6). Immediately before each publishing call: the switch (in the
// gateway), the slot still approved for the same manifest (AC-XP-10), and the identity read of THAT network (AC-XP-8).
//
// 2026-11-23 (owner TG 4779, ADR 0068 amendment 2): every network runs in its own lane -- its own identity read, quota, jobs and
// errors, concurrently with the others -- so a network that fails, hangs or is refused never stops, skips or delays another.
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
  /** The manifest's own `sha256` of the video file (required for a social post: it binds the mp4 to the approved manifest). */
  videoSha256: string | null;
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
  /** A publishing call was sent (the post may be live even if its answer was lost): never retried. */
  publishAttempted: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Owner TG 4780: the owner's explicit retry from the Web UI, waiting for the runner (null / absent: none). The runner then posts
   * the job however late -- the 12 h window binds only the automatic start -- and clears the mark when it acts on it.
   */
  ownerRetryAt?: number | null;
};

/** A failed job the owner asked to retry, that never sent a publishing call (only those may ever be posted again). */
export function ownerRetryPending(job: SocialJob): boolean {
  return job.status === "failed" && typeof job.ownerRetryAt === "number" && !job.publishAttempted && !job.remotePostId;
}

export type RunnerDeps = {
  plan: { entries(): Promise<PlannedCrossPost[]>; stillApproved(entry: PlannedCrossPost): Promise<boolean> };
  jobs: {
    get(jobId: string): Promise<SocialJob | null>;
    /** Jobs still `uploading` / `processing` (also those whose slot no longer lists the network). */
    listActive(): Promise<SocialJob[]>;
    insert(job: SocialJob): Promise<boolean>;
    update(jobId: string, set: Partial<SocialJob>): Promise<void>;
  };
  /**
   * The Page token and ONE network's account after that network's identity read passed; throws `social_account_mismatch`
   * (with `details.problems`) otherwise. Another network's problem never makes it throw.
   */
  postingTarget(channelId: string, network: SocialNetwork): Promise<PostingTarget>;
  meta: Pick<MetaClient, "igCreateReelContainer" | "igUploadReel" | "igContainerStatus" | "igPublish" | "igPermalink" | "fbReelStart" | "fbUploadReel" | "fbReelFinish" | "fbVideoStatus">;
  files: { body(path: string, sizeBytes: number): UploadBody; sha256(path: string): Promise<string> };
  enabled(): Promise<boolean>;
  now(): number;
  /** AC-XP-16: false when one more post would pass the network's rolling 24 h limit -- the post waits (no job, nothing sent). */
  quotaOk?(channelId: string, network: SocialNetwork): Promise<boolean>;
};

/** A post more than this late (the computer was off at the planned time) is not sent; the owner can retry it. */
export const MAX_LATE_MS = 12 * 60 * 60_000;
/** Meta processing that does not finish in this time fails the job (Instagram: a container expires after 24 h). */
export const PROCESSING_TIMEOUT_MS = 60 * 60_000;

export const jobIdOf = (channelId: string, slotId: string, network: SocialNetwork) => `${channelId}|${slotId}|${network}`;

export function plannedAtOf(entry: PlannedCrossPost, target: CrossPostTarget): number {
  return target.at ? zonedInstant({ localDate: entry.slotDate, localTime: target.at, timezone: entry.timeZone }).getTime() : entry.publishAt;
}

/**
 * A failure that says nothing about whether Meta acted: no answer, a rate limit, or Meta's own 5xx. After a publishing call (or
 * while reading the status of one) such a failure keeps the job `processing` -- only a definite answer or the timeout ends it.
 */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof DomainError)) return false;
  if (error.code === "social_unavailable" || error.code === "social_rate_limited") return true;
  const status = (error.details as { status?: unknown } | undefined)?.status;
  return typeof status === "number" && status >= 500;
}

/**
 * The job's own code: a refused identity read records its network's own problem (`instagram_unlinked`, `token_invalid`,
 * `not_connected`, ...) rather than the generic `social_account_mismatch`; the message keeps the whole refusal.
 */
function errorParts(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof DomainError) {
    const problems = (error.details as { problems?: unknown } | undefined)?.problems;
    const first = error.code === "social_account_mismatch" && Array.isArray(problems) && typeof problems[0] === "string" ? problems[0] : null;
    return { errorCode: first ?? error.code, errorMessage: error.message.slice(0, 500) };
  }
  return { errorCode: "internal_error", errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
}

type TickReport = {
  skipped?: "disabled";
  started: string[];
  advanced: string[];
  failed: string[];
  /** Networks whose previous pass was still running (e.g. a long upload): skipped this time, the others ran. */
  busy: SocialNetwork[];
  /** Jobs (or `<network>:listActive`) whose step threw outside the job's own handling: left for the next pass. */
  errors: string[];
};

type LaneItem = { entry: PlannedCrossPost; target: CrossPostTarget; blocked: boolean };

export function createCrossPostRunner(deps: RunnerDeps) {
  /** The pass each network is running now; a network never runs two passes at once (so `uploading` means interrupted). */
  const lanes = new Map<SocialNetwork, Promise<void>>();

  async function fail(jobId: string, errorCode: string, errorMessage: string, report: TickReport) {
    await deps.jobs.update(jobId, { status: "failed", errorCode, errorMessage, updatedAt: deps.now() });
    report.failed.push(jobId);
  }

  type UploadArgs = { entry: PlannedCrossPost; target: CrossPostTarget; jobId: string; ctx: PostingTarget; body: UploadBody };
  type AdvanceArgs = { job: SocialJob & { remoteId: string }; entry: PlannedCrossPost | undefined; ctx: PostingTarget; now: number; report: TickReport };

  /**
   * What differs per network: the upload up to `processing`, and reading a processing job on. A new network is a new entry here
   * (the Record makes it required); nothing falls into another network's branch.
   */
  const NETWORK_OPS: Record<SocialNetwork, { upload(a: UploadArgs): Promise<void>; advance(a: AdvanceArgs): Promise<void> }> = {
    instagram: {
      async upload({ target, jobId, ctx, body, entry }) {
        if (target.network !== "instagram") throw new DomainError({ code: "validation_failed", message: "An Instagram job got another network's target." });
        const { containerId } = await deps.meta.igCreateReelContainer({ igUserId: ctx.accountId, token: ctx.token, caption: target.caption, shareToFeed: target.shareToFeed, isAiGenerated: entry.isAiGenerated });
        await deps.jobs.update(jobId, { remoteId: containerId, updatedAt: deps.now() });
        await deps.meta.igUploadReel({ containerId, token: ctx.token, body });
        await deps.jobs.update(jobId, { status: "processing", updatedAt: deps.now() });
      },
      async advance({ job, entry, ctx, now, report }) {
        const status = await deps.meta.igContainerStatus({ containerId: job.remoteId, token: ctx.token });
        if (status === "PUBLISHED") {
          await deps.jobs.update(job.jobId, { status: "published", updatedAt: now });
          report.advanced.push(job.jobId);
        } else if (status === "FINISHED") {
          if (!entry || entry.manifestSha256 !== job.manifestSha256 || !(await deps.plan.stillApproved(entry))) {
            await fail(job.jobId, "social_approval_stale", "The slot's approval no longer covers this package; nothing was published.", report);
            return;
          }
          let mediaId: string;
          await deps.jobs.update(job.jobId, { publishAttempted: true, updatedAt: deps.now() });
          try {
            ({ mediaId } = await deps.meta.igPublish({ igUserId: ctx.accountId, containerId: job.remoteId, token: ctx.token }));
          } catch (error) {
            // No answer / 5xx: it may still have published -- the container then reads PUBLISHED on the next pass.
            if (isTransient(error)) return;
            throw error;
          }
          await deps.jobs.update(job.jobId, { status: "published", remotePostId: mediaId, updatedAt: deps.now() });
          const permalink = await deps.meta.igPermalink({ mediaId, token: ctx.token }).catch(() => null);
          if (permalink) await deps.jobs.update(job.jobId, { permalink });
          report.advanced.push(job.jobId);
        } else if (status === "ERROR" || status === "EXPIRED") {
          await fail(job.jobId, `instagram_${status.toLowerCase()}`, `Instagram could not process the video (${status}).`, report);
        } else if (now - job.updatedAt > PROCESSING_TIMEOUT_MS) {
          await fail(job.jobId, "processing_timeout", "Instagram did not finish processing in time.", report);
        }
      },
    },
    facebook: {
      async upload({ entry, target, jobId, ctx, body }) {
        if (target.network !== "facebook") throw new DomainError({ code: "validation_failed", message: "A Facebook job got another network's target." });
        const { videoId, uploadUrl } = await deps.meta.fbReelStart({ pageId: ctx.pageId, token: ctx.token });
        await deps.jobs.update(jobId, { remoteId: videoId, uploadUrl, updatedAt: deps.now() });
        await deps.meta.fbUploadReel({ uploadUrl, token: ctx.token, body });
        if (!(await deps.plan.stillApproved(entry))) throw new DomainError({ code: "social_approval_stale", message: "The slot's approval no longer covers this package; nothing was published." });
        // AC-XP-8: Facebook's own identity read again right before publishing (the upload may have taken minutes).
        const fresh = await deps.postingTarget(entry.channelId, "facebook");
        // `processing` + `publishAttempted` BEFORE finish: a crash or a lost answer after Meta accepted `finish` must never lead to
        // a second post (no retry of an attempted publish).
        await deps.jobs.update(jobId, { status: "processing", publishAttempted: true, updatedAt: deps.now() });
        try {
          await deps.meta.fbReelFinish({ pageId: fresh.pageId, token: fresh.token, videoId, title: target.title, description: target.description, isAiGenerated: entry.isAiGenerated });
        } catch (error) {
          // No answer / 5xx: it may still have published -- stay `processing`, the status read decides.
          if (isTransient(error)) return;
          throw error;
        }
      },
      async advance({ job, ctx, now, report }) {
        const s = await deps.meta.fbVideoStatus({ videoId: job.remoteId, token: ctx.token });
        if (s.publishStatus === "published") {
          await deps.jobs.update(job.jobId, { status: "published", remotePostId: job.remoteId, permalink: s.permalink, updatedAt: now });
          report.advanced.push(job.jobId);
        } else if (s.videoStatus === "error" || s.videoStatus === "upload_failed" || s.publishStatus === "error") {
          await fail(job.jobId, "facebook_error", "Facebook could not process the Reel.", report);
        } else if (now - job.updatedAt > PROCESSING_TIMEOUT_MS) {
          await fail(job.jobId, "processing_timeout", "Facebook did not finish processing in time.", report);
        }
      },
    },
  };

  /**
   * Starts a network's post. `retry`: the owner's retry of that failed job (owner TG 4780) -- no lateness window, the existing row
   * is taken over instead of a new one inserted; every other gate (approval, identity, quota, sha256) is the same.
   */
  async function start(entry: PlannedCrossPost, target: CrossPostTarget, plannedAt: number, report: TickReport, retry: SocialJob | null = null) {
    const network = target.network;
    const jobId = jobIdOf(entry.channelId, entry.slotId, network);
    const now = deps.now();
    const base: SocialJob = { jobId, channelId: entry.channelId, slotId: entry.slotId, video: entry.video, network, manifestSha256: entry.manifestSha256, plannedAt, status: "uploading", remoteId: null, uploadUrl: null, remotePostId: null, permalink: null, publishAttempted: false, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now };
    if (!retry && now - plannedAt > MAX_LATE_MS) {
      if (await deps.jobs.insert({ ...base, status: "failed", errorCode: "missed_window", errorMessage: "This computer was not posting at the planned time." })) report.failed.push(jobId);
      return;
    }
    if (!(await deps.plan.stillApproved(entry))) return;
    // AC-XP-8 for THIS network first (owner TG 4779): a definite refusal is recorded on this network's own job at once (it used to
    // hide behind the quota gate and end as `missed_window`); an unreachable Meta proves nothing -- the next pass asks again.
    let ctx: PostingTarget;
    try {
      ctx = await deps.postingTarget(entry.channelId, network);
    } catch (error) {
      if (isTransient(error)) return;
      if (retry) {
        // The owner's retry is answered (refused again, with this network's own code); a new retry is the owner's to give.
        await deps.jobs.update(jobId, { status: "failed", ...errorParts(error), ownerRetryAt: null, updatedAt: now });
        report.failed.push(jobId);
      } else if (await deps.jobs.insert({ ...base, status: "failed", ...errorParts(error) })) report.failed.push(jobId);
      return;
    }
    if (deps.quotaOk && !(await deps.quotaOk(entry.channelId, network).catch(() => false))) return;
    if (retry) {
      // Re-read right before taking it over: still a pending retry that never sent a publishing call.
      const current = await deps.jobs.get(jobId);
      if (!current || !ownerRetryPending(current)) return;
      const { jobId: _ignoredId, createdAt: _ignoredCreated, ...fresh } = base;
      void _ignoredId;
      void _ignoredCreated;
      await deps.jobs.update(jobId, { ...fresh, ownerRetryAt: null });
    } else if (!(await deps.jobs.insert(base))) return; // another pass already started it
    report.started.push(jobId);
    try {
      const file = entry.videoFile;
      if (!file || file.sizeBytes === null) throw new DomainError({ code: "validation_failed", message: "The package's video file is not readable." });
      // AC-XP-10: the approval covers the manifest; the manifest's `sha256` covers the mp4 -- checked right before the upload.
      if (!entry.videoSha256 || (await deps.files.sha256(file.path)) !== entry.videoSha256) throw new DomainError({ code: "social_approval_stale", message: "The video file does not match the approved package's sha256; nothing was published." });
      if (ctx.network !== network) throw new DomainError({ code: "social_account_mismatch", message: `The identity read answered for ${ctx.network}, not ${network}.` });
      await NETWORK_OPS[network].upload({ entry, target, jobId, ctx, body: deps.files.body(file.path, file.sizeBytes) });
    } catch (error) {
      const { errorCode, errorMessage } = errorParts(error);
      await fail(jobId, errorCode, errorMessage, report);
    }
  }

  async function advance(job: SocialJob, entry: PlannedCrossPost | undefined, report: TickReport) {
    const now = deps.now();
    if (job.status === "uploading") {
      // An upload this network's lane is not running any more (a restart mid-upload): nothing was published -- fail, the owner may retry.
      await fail(job.jobId, "interrupted", "The upload was interrupted (the app restarted); nothing was published.", report);
      return;
    }
    if (job.status !== "processing" || !job.remoteId) return;
    try {
      const ctx = await deps.postingTarget(job.channelId, job.network);
      await NETWORK_OPS[job.network].advance({ job: { ...job, remoteId: job.remoteId }, entry, ctx, now, report });
    } catch (error) {
      // A read that failed for no definite reason (network, Meta 5xx, the identity read unreachable) proves nothing: keep waiting
      // until the processing timeout, so a live post is never marked failed (and retried) by a blip.
      if (isTransient(error) && now - job.updatedAt <= PROCESSING_TIMEOUT_MS) return;
      const { errorCode, errorMessage } = errorParts(error);
      await fail(job.jobId, errorCode, errorMessage, report);
    }
  }

  /** One network's pass: its slots in order, then its active jobs no slot lists any more. Never rejects; one step's throw skips only that step. */
  async function runLane(network: SocialNetwork, items: LaneItem[], entries: PlannedCrossPost[], report: TickReport) {
    const visited = new Set<string>();
    for (const { entry, target, blocked } of items) {
      const jobId = jobIdOf(entry.channelId, entry.slotId, network);
      visited.add(jobId);
      try {
        const job = await deps.jobs.get(jobId);
        if (job) {
          if (job.status === "uploading" || job.status === "processing") await advance(job, entry, report);
          else if (ownerRetryPending(job) && !blocked) await start(entry, target, plannedAtOf(entry, target), report, job);
          continue;
        }
        if (blocked) continue;
        const plannedAt = plannedAtOf(entry, target);
        if (deps.now() < plannedAt) continue;
        await start(entry, target, plannedAt, report);
      } catch {
        report.errors.push(jobId);
      }
    }
    // A job whose slot was withdrawn or changed after it started: an Instagram container is never published then (no entry, so
    // the approval check fails); a Facebook Reel already published by `finish` is still read back to `published`.
    let active: SocialJob[] = [];
    try {
      active = (await deps.jobs.listActive()).filter((j) => j.network === network);
    } catch {
      report.errors.push(`${network}:listActive`);
    }
    for (const job of active) {
      if (visited.has(job.jobId)) continue;
      try {
        await advance(job, entries.find((e) => e.channelId === job.channelId && e.slotId === job.slotId), report);
      } catch {
        report.errors.push(job.jobId);
      }
    }
  }

  async function tickOnce(): Promise<TickReport> {
    const report: TickReport = { started: [], advanced: [], failed: [], busy: [], errors: [] };
    if (!(await deps.enabled())) return { ...report, skipped: "disabled" };
    const entries = await deps.plan.entries();
    const work = new Map<SocialNetwork, LaneItem[]>(SOCIAL_NETWORKS.map((n) => [n, []]));
    for (const entry of entries) {
      const { targets, problems } = parseCrossPostBlock(entry.crossPost);
      const video = entry.videoFile ?? { durationSeconds: null, sizeBytes: null, width: null, height: null };
      const badNetworks = new Set([...problems, ...videoProblems(targets, video)].map((p) => p.network));
      if (targets.length > 0 && !entry.videoSha256) continue; // a package without the video's sha256 never posts (AC-XP-10)
      if (badNetworks.has(null)) continue; // the block itself is broken: nothing from it is posted
      for (const target of targets) work.get(target.network)?.push({ entry, target, blocked: badNetworks.has(target.network) });
    }
    const passes: Promise<void>[] = [];
    for (const network of SOCIAL_NETWORKS) {
      if (lanes.has(network)) {
        report.busy.push(network);
        continue;
      }
      const pass = runLane(network, work.get(network) ?? [], entries, report)
        .catch(() => void report.errors.push(network))
        .finally(() => lanes.delete(network));
      lanes.set(network, pass);
      passes.push(pass);
    }
    await Promise.all(passes);
    return report;
  }

  return {
    /** One pass over every network; a network whose previous pass still runs is skipped (never doubled), the others run. */
    tick(): Promise<TickReport> {
      return tickOnce();
    },
    /** True while some network's pass (e.g. an upload) is in flight. */
    busy: () => lanes.size > 0,
  };
}

export type CrossPostRunner = ReturnType<typeof createCrossPostRunner>;
