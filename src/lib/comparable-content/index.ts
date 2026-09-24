import { createChangeSetChannelStoreAdapter } from "@/lib/changesets/adapters/store";
import { createAnalyticsCore } from "@/lib/analytics";
import { createComparableContentServices } from "./services";
import { isDomainError } from "./contracts";

export function createComparableContentCore() {
  // Reused unchanged (AGENTS.md §D) -- the same channel/video store adapter `ai-localization`/
  // `content-proposals`/`agent-operations` already use, and `analyticsCore`'s own already-tested
  // `listMetrics`. No new store, no new YouTube call, no parallel age-alignment implementation
  // (`computeComparableAgeSeries` is imported directly by `services.ts`, not reimplemented here).
  const channelStore = createChangeSetChannelStoreAdapter();
  const analyticsCore = createAnalyticsCore();

  return createComparableContentServices({
    listVideosByChannel: channelStore.listVideosByChannel,
    listMetrics: analyticsCore.listMetrics,
    now: () => new Date(),
  });
}

export type ComparableContentCore = ReturnType<typeof createComparableContentCore>;
export type {
  ComparableVideoCandidate,
  ComparableVideosSortMode,
  FindComparableVideosInput,
  FindComparableVideosResult,
  PerformanceThresholdOperator,
} from "./contracts";
export { COMPARABLE_VIDEOS_SORT_MODES } from "./contracts";
export { isDomainError };
