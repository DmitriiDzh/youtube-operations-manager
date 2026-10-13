import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createReachReportsApiAdapter } from "./adapters/reporting-api";
import { createOtherReportStoreAdapter, createReachReportsStoreAdapter, createTrafficSourceReadAdapter } from "./adapters/store";
import { mapBasicRows, mapTrafficSourceRows } from "./basic-csv";
import { BASIC_JOB_NAME, BASIC_REPORT_TYPE_ID, TRAFFIC_SOURCE_JOB_NAME, TRAFFIC_SOURCE_REPORT_TYPE_ID } from "./contracts";
import { createReachReportsServices, type OtherReportType } from "./services";

/**
 * BL-181 (FO-REQ-0020, owner msg 2687): the basic user-activity and traffic-source reports, synced after Reach in the same call so
 * their lag can be measured. Stored per device; never in the cross-computer analytics file.
 */
const otherReportStore = createOtherReportStoreAdapter();
const OTHER_REPORT_TYPES: readonly OtherReportType[] = [
  {
    reportTypeId: BASIC_REPORT_TYPE_ID,
    jobName: BASIC_JOB_NAME,
    async importFile({ meta, csv }) {
      const rows = mapBasicRows(csv, meta.channelId);
      return { outcome: await otherReportStore.importBasicReport({ ...meta, rows }), rowCount: rows.length };
    },
  },
  {
    reportTypeId: TRAFFIC_SOURCE_REPORT_TYPE_ID,
    jobName: TRAFFIC_SOURCE_JOB_NAME,
    async importFile({ meta, csv }) {
      const rows = mapTrafficSourceRows(csv, meta.channelId);
      return { outcome: await otherReportStore.importTrafficSourceReport({ ...meta, rows }), rowCount: rows.length };
    },
  },
];

// BL-114 (docs/decisions/0014-youtube-reporting-api-gateway-child.md). A feature module of its own
// (AGENTS.md §M): it does not import `src/lib/analytics`, so turning the Reporting reads toggle off, or this
// module failing, never affects the Analytics tab, collection or `agent_query_*`.
export function createReachReportsCore() {
  return createReachReportsServices({
    authResolver: { resolve: resolveGoogleCredentials },
    reportingApi: createReachReportsApiAdapter(),
    store: createReachReportsStoreAdapter(),
    channelAccess: createChannelAccessCore(),
    requiredScope: YOUTUBE_ANALYTICS_READ_SCOPE,
    clock: { now: () => new Date() },
    otherReportTypes: OTHER_REPORT_TYPES,
    trafficSourceStore: createTrafficSourceReadAdapter(),
  });
}

export type ReachReportsCore = ReturnType<typeof createReachReportsCore>;
export { BASIC_REPORT_TYPE_ID, REACH_BASIC_REPORT_TYPE_ID, TRAFFIC_SOURCE_REPORT_TYPE_ID } from "./contracts";
export type {
  GetChannelReachResult,
  GetVideoWindowsReachResult,
  VideoWindowReach,
  GetReachStatusResult,
  FirstFileLagView,
  GetReportingTrafficSourcesResult,
  OtherReportSyncResult,
  ReachFileView,
  ReportTypeStatusView,
  ReachSyncAttemptView,
  ReachDailyPoint,
  ReachRow,
  ReachState,
  ReachVideoPoint,
  SyncReachReportsResult,
  SyncReachReportsSkipped,
} from "./contracts";
export type { SyncAllReachChannelOutcome } from "./services";
