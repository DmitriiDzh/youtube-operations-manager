import { deleteSocialPostJob, getSocialPostJob, insertSocialPostJob, listSocialPostJobs, updateSocialPostJob, type StoredSocialPostJob } from "@/lib/db";
import type { SocialJob } from "../runner";

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
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
});

const toDates = (set: Partial<SocialJob>) => {
  const { plannedAt, createdAt, updatedAt, ...rest } = set;
  return {
    ...rest,
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
    insert: (job: SocialJob) => insertSocialPostJob({ ...job, plannedAt: new Date(job.plannedAt), createdAt: new Date(job.createdAt), updatedAt: new Date(job.updatedAt) }),
    update: (jobId: string, set: Partial<SocialJob>) => updateSocialPostJob(jobId, toDates(set)),
    remove: (jobId: string) => deleteSocialPostJob(jobId),
  };
}
