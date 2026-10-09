import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createReachReportsApiAdapter } from "./adapters/reporting-api";
import { createReachReportsStoreAdapter } from "./adapters/store";
import { createReachReportsServices } from "./services";

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
  });
}

export type ReachReportsCore = ReturnType<typeof createReachReportsCore>;
export { REACH_BASIC_REPORT_TYPE_ID } from "./contracts";
export type {
  GetChannelReachResult,
  GetVideoWindowsReachResult,
  VideoWindowReach,
  GetReachStatusResult,
  ReachFileView,
  ReachSyncAttemptView,
  ReachDailyPoint,
  ReachRow,
  ReachState,
  ReachVideoPoint,
  SyncReachReportsResult,
  SyncReachReportsSkipped,
} from "./contracts";
export type { SyncAllReachChannelOutcome } from "./services";
