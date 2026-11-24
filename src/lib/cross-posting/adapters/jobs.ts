import { deleteSocialPostJob, getSocialPostJob, insertSocialPostJob, listSocialPostJobs, markSocialPostJobOwnerRetry, updateSocialPostJob, type StoredSocialPostJob } from "@/lib/db";
import { ownerRetryPending, type SocialJob } from "../runner";

// BL-252 stage 2: this computer's cross-posting jobs through `db.ts`'s helpers only (times as Unix ms in the module, Dates in the table).
const toJob = (r: StoredSocialPostJob): SocialJob => ({
  jobId: r.jobId,
  channelId: r.channelId,
  slotId: r.slotId,
  video: r.video,
  network: r.network,
  manifestSha256: r.manifestSha256,
  plannedAt: r.plannedAt.getTime(),
  status: r.status,
  remoteId: r.remoteId,
  uploadUrl: r.uploadUrl,
  remotePostId: r.remotePostId,
  permalink: r.permalink,
  publishAttempted: r.publishAttempted,
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
  ownerRetryAt: r.ownerRetryAt ? r.ownerRetryAt.getTime() : null,
});

const toDates = (set: Partial<SocialJob>) => {
  const { plannedAt, createdAt, updatedAt, ownerRetryAt, ...rest } = set;
  return {
    ...rest,
    ...(ownerRetryAt !== undefined ? { ownerRetryAt: ownerRetryAt === null ? null : new Date(ownerRetryAt) } : {}),
    ...(plannedAt !== undefined ? { plannedAt: new Date(plannedAt) } : {}),
    ...(createdAt !== undefined ? { createdAt: new Date(createdAt) } : {}),
    ...(updatedAt !== undefined ? { updatedAt: new Date(updatedAt) } : {}),
  };
};

export function createSocialJobStore() {
  return {
    get: async (jobId: string) => {
      const row = await getSocialPostJob(jobId);
      return row ? toJob(row) : null;
    },
    list: async (channelId: string | null) => (await listSocialPostJobs(channelId)).map(toJob),
    listActive: async () => (await listSocialPostJobs(null)).filter((r) => r.status === "uploading" || r.status === "processing").map(toJob),
    /** Jobs carrying a pending owner retry (failed, never sent a publishing call, marked). */
    listRetries: async () => (await listSocialPostJobs(null)).map(toJob).filter(ownerRetryPending),
    insert: (job: SocialJob) => insertSocialPostJob({ ...job, plannedAt: new Date(job.plannedAt), createdAt: new Date(job.createdAt), updatedAt: new Date(job.updatedAt), ownerRetryAt: typeof job.ownerRetryAt === "number" ? new Date(job.ownerRetryAt) : null }),
    update: (jobId: string, set: Partial<SocialJob>) => updateSocialPostJob(jobId, toDates(set)),
    markOwnerRetry: (jobId: string, at: number) => markSocialPostJobOwnerRetry(jobId, new Date(at)),
    remove: (jobId: string) => deleteSocialPostJob(jobId),
  };
}
