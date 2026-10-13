import {
  countImportedReportingFiles,
  getChannelReachCoverage,
  getChannelTrafficSourceCoverage,
  listChannelTrafficSourceDaily,
  listImportedReportingFilesInRange,
  getReportingSyncAttempt,
  listReportingReportFiles,
  recordReportingSyncAttempt,
  getReportingJob,
  importBasicReport,
  importReachReport,
  importTrafficSourceReport,
  listChannelReachDaily,
  listSeenReportingReportIds,
  upsertReportingJob,
} from "@/lib/db";
import { listChannelConnections } from "@/lib/channel-fanout";
import type { ReachReportsDependencies } from "../services";
import { TRAFFIC_SOURCE_REPORT_TYPE_ID } from "../contracts";

// Deliberately thin: only the Reporting/Reach persistence functions. Never touches `videos` or anything in
// youtube-write-gateway; each channel's connected Google user comes from the shared channel-fanout module (BL-141).
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
    listChannelConnections,
    getAttempt: (channelId, reportTypeId) => getReportingSyncAttempt(channelId, reportTypeId),
    listFiles: (channelId, reportTypeId, limit) => listReportingReportFiles(channelId, reportTypeId, limit),
    countImportedFiles: (channelId, reportTypeId) => countImportedReportingFiles(channelId, reportTypeId),
  };
}

/** BL-181: the storage of the basic and traffic-source report files (the module's one db boundary, like the store above). */
export function createOtherReportStoreAdapter() {
  return {
    importBasicReport: (input: Parameters<typeof importBasicReport>[0]) => importBasicReport(input),
    importTrafficSourceReport: (input: Parameters<typeof importTrafficSourceReport>[0]) => importTrafficSourceReport(input),
  };
}

/** BL-181 (owner msg 2702): the stored traffic-source rows and their files, for `getReportingTrafficSources`. */
export function createTrafficSourceReadAdapter(): NonNullable<ReachReportsDependencies["trafficSourceStore"]> {
  return {
    async listDaily(channelId, range, videoId) {
      const rows = await listChannelTrafficSourceDaily(channelId, range, undefined, videoId);
      return rows.map(({ date, videoId, trafficSourceType, views, engagedViews, watchTimeMinutes }) => ({ date, videoId, trafficSourceType, views, engagedViews, watchTimeMinutes }));
    },
    getCoverage: (channelId) => getChannelTrafficSourceCoverage(channelId),
    listFiles: (channelId, range) => listImportedReportingFilesInRange(channelId, TRAFFIC_SOURCE_REPORT_TYPE_ID, range),
  };
}
