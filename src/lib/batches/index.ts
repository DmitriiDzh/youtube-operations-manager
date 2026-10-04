import { createDefaultLogger } from "@/lib/shared-logger";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createWriteContextCore } from "@/lib/write-context";
import { createBackupCore } from "@/lib/backup";
import { createAuditCore } from "@/lib/audit";
import { createBatchStoreAdapter, createChangeSetReaderAdapter, createChangeSetStoreAdapter, createIdGenerator } from "./adapters/store";
import { createBatchYoutubeApiAdapter } from "./adapters/youtube-api";
import { applyConfirmedWriteToStoredVideo, getChannelExpectedLanguages, getLiveWritesEnabled, rawSqlClient, splitPendingBatchForQuota } from "@/lib/db";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createBatchServices } from "./services";
import { createSendApprovedServices } from "./send-approved";

function createRealClock() {
  return {
    wait(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

// Slices 1-3. No WriteExecutor is constructed or wired in here -- executeWithRetry/
// executeBatch (Slice 3) and the earlier executeSingleAttempt (Slice 1) all *accept* a
// WriteExecutor as a parameter the CALLER must supply; this factory never supplies one
// itself, so no code path reachable through createBatchCore() can issue a real
// `videos.update` call. A live (non-dry-run) batch prepared via prepareBatchExecution
// stops at AWAITING_EXECUTION; only an explicit, separate call to executeBatch/
// executeWithRetry with a caller-supplied executor drives an actual attempt, and no such
// call exists anywhere in this repository outside of tests. Wiring a real YouTube adapter
// behind WriteExecutor is Slice 4's explicit, separately-authorized job.
export function createBatchCore() {
  const writeContext = createWriteContextCore();

  return createBatchServices({
    batchStore: createBatchStoreAdapter(),
    changeSetStore: createChangeSetStoreAdapter(),
    authResolver: { resolve: resolveGoogleCredentials },
    writeContext,
    youtubeApi: createBatchYoutubeApiAdapter(),
    channelLanguageBaseline: {
      getExpectedDefaultLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage,
      getExpectedDefaultAudioLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultAudioLanguage,
    },
    localMirror: { applyConfirmedWrite: (input) => applyConfirmedWriteToStoredVideo(input) },
    backup: createBackupCore(),
    audit: createAuditCore(),
    clock: createRealClock(),
    verifyRetryDelaysMs: [2000, 5000],
    assertMutationAllowed: () => assertDeviceAvailableForMutation(rawSqlClient),
    // BL-117 slice 2: a live batch that needs more quota than is left is refused before it starts (and can be split).
    quotaGuard: createQuotaGuardCore(),
    splitPendingBatch: (input) => splitPendingBatchForQuota(input),
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type BatchCore = ReturnType<typeof createBatchCore>;

/** BL-124 / ADR 0020: select a change set's sendable changes and create a LIVE batch from them (creates only, never executes). */
export function createSendApprovedCore() {
  const batches = createBatchCore();
  return createSendApprovedServices({
    batches,
    changeSets: createChangeSetReaderAdapter(),
    isLiveWritesEnabled: () => getLiveWritesEnabled(),
  });
}

// Architecture audit 2026-10-01 (M8): exported through the barrel so app-layer callers never reach
// into this module's services/adapters directly.
export { isApprovalStillValid } from "./services";
export { createLiveWriteExecutorIfEnabled } from "./adapters/write-executor";
