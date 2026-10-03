import {
  getChannelReachCoverage,
  getReportingSyncAttempt,
  listReportingReportFiles,
  recordReportingSyncAttempt,
  getReportingJob,
  importReachReport,
  listChannelReachDaily,
  listSeenReportingReportIds,
  upsertReportingJob,
} from "@/lib/db";
import type { ReachReportsDependencies } from "../services";

// Deliberately thin: only the Reporting/Reach persistence functions. Never touches `videos`, `channels` or
// anything in youtube-write-gateway.
export function createReachReportsStoreAdapter(): ReachReportsDependencies["store"] {
  return {
    upsertJob: (args) => upsertReportingJob(args),
    async getJob(channelId, reportTypeId) {
      const job = await getReportingJob(channelId, reportTypeId);
      return job ? { jobId: job.jobId, jobCreatedAt: job.jobCreatedAt, lastCheckedAt: job.lastCheckedAt } : null;
    },
    listSeenReportIds: (channelId, reportTypeId) => listSeenReportingReportIds(channelId, reportTypeId),
    importReport: (args) => importReachReport(args),
    async listDaily(channelId, range) {
      const rows = await listChannelReachDaily(channelId, range);
      return rows.map((row) => ({ date: row.date, videoId: row.videoId, impressions: row.impressions, ctr: row.ctr }));
    },
    getCoverage: (channelId) => getChannelReachCoverage(channelId),
    recordAttempt: (args) => recordReportingSyncAttempt(args),
    getAttempt: (channelId, reportTypeId) => getReportingSyncAttempt(channelId, reportTypeId),
    listFiles: (channelId, reportTypeId, limit) => listReportingReportFiles(channelId, reportTypeId, limit),
  };
}
