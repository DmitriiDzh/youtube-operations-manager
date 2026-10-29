import { createDefaultLogger } from "@/lib/shared-logger";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createWriteContextCore } from "@/lib/write-context";
import { createBackupCore } from "@/lib/backup";
import { createAuditCore } from "@/lib/audit";
import { createBatchStoreAdapter, createChangeSetReaderAdapter, createChangeSetStoreAdapter, createIdGenerator } from "./adapters/store";
import { createBatchYoutubeApiAdapter } from "./adapters/youtube-api";
import { applyConfirmedWriteToStoredVideo, getChannelExpectedLanguages, getLiveWritesEnabled, rawSqlClient, splitPendingBatchForQuota } from "@/lib/db";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { createChannelLanguageSettingsCoreForProduction } from "@/lib/sync-gateway";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createBatchServices } from "./services";
import { createSendApprovedServices } from "./send-approved";
import { createChangeSetCore, readWithChannelBaseline, remoteHoldsApprovedValue } from "@/lib/changesets";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { sameLanguage } from "@/lib/shared-language-baseline";

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
    changeSetStore: {
      ...createChangeSetStoreAdapter(),
      // BL-232: the change's whole set, each change marked when the synced copy already holds its approved value (BL-198's rule).
      async listSetChanges(changeId: string) {
        const reader = createChangeSetReaderAdapter();
        const changeSetId = await reader.changeSetIdOf(changeId);
        if (!changeSetId) return [];
        const changeSet = await reader.getChangeSet(changeSetId);
        if (!changeSet) return [];
        const baseline = (await getChannelExpectedLanguages(changeSet.channelId)).defaultLanguage;
        const byVideo = new Map(
          (await createChannelVideoStoreAdapter().listVideosByChannel(changeSet.channelId)).map((video) => [video.videoId, readWithChannelBaseline(video, baseline)])
        );
        return (await reader.listChanges(changeSetId)).map((change) => ({
          id: change.id,
          videoId: change.videoId,
          changeType: change.changeType,
          onYoutube:
            change.approvalStatus === "approved" &&
            remoteHoldsApprovedValue(byVideo.get(change.videoId) ?? null, {
              language: change.language ?? "",
              field: change.field ?? "title",
              changeType: change.changeType ?? "modify",
              approvedValue: change.approvedValue,
            }),
        }));
      },
    },
    authResolver: { resolve: resolveGoogleCredentials },
    writeContext,
    youtubeApi: createBatchYoutubeApiAdapter(),
    channelLanguageBaseline: {
      getExpectedDefaultLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage,
      getExpectedDefaultAudioLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultAudioLanguage,
      getConflictedBaselineFields: (channelId) => createChannelLanguageSettingsCoreForProduction().conflictedBaselineFields(channelId),
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
  const reader = createChangeSetReaderAdapter();
  const videoStore = createChannelVideoStoreAdapter();
  // One change-set core for this send core: a merge may reject many losing variants in a row.
  let changeSetCore: ReturnType<typeof createChangeSetCore> | null = null;
  return createSendApprovedServices({
    batches,
    changeSets: {
      getChangeSet: (changeSetId) => reader.getChangeSet(changeSetId),
      listChanges: (changeSetId) => reader.listChanges(changeSetId),
      // BL-198: the channel's synced copy, read once per call against its language baseline, tells a change already on YouTube.
      async remoteHolds(channelId) {
        const baseline = (await getChannelExpectedLanguages(channelId)).defaultLanguage;
        const byVideo = new Map((await videoStore.listVideosByChannel(channelId)).map((video) => [video.videoId, readWithChannelBaseline(video, baseline)]));
        return (change) =>
          remoteHoldsApprovedValue(byVideo.get(change.videoId) ?? null, {
            language: change.language ?? "",
            field: change.field ?? "title",
            changeType: change.changeType ?? "modify",
            approvedValue: change.approvedValue,
          });
      },
      // BL-226: the same synced copy, for the titles a translation would keep.
      async currentTitles(channelId) {
        const baseline = (await getChannelExpectedLanguages(channelId)).defaultLanguage;
        const byVideo = new Map(
          (await videoStore.listVideosByChannel(channelId)).map((video) => {
            const read = readWithChannelBaseline(video, baseline);
            // A video without its own language gets the channel's at the write (owner exception 2026-10-02).
            const ownLanguage = read.alignedTo ?? video.defaultLanguage ?? baseline;
            return [video.videoId, { isOwnLanguage: (language: string) => sameLanguage(language, ownLanguage), title: (language: string) => read.current(language, "title") }];
          })
        );
        return (videoId) => byVideo.get(videoId) ?? null;
      },
      // Through the change-set service, so the set's status is recomputed exactly as a rejection in the Languages tab does.
      async rejectChange(input) {
        changeSetCore ??= createChangeSetCore();
        await changeSetCore.rejectChange(input);
      },
      async videoTitles(channelId) {
        return new Map((await videoStore.listVideosByChannel(channelId)).map((video) => [video.videoId, video.title]));
      },
    },
    isLiveWritesEnabled: () => getLiveWritesEnabled(),
  });
}

// Architecture audit 2026-10-01 (M8): exported through the barrel so app-layer callers never reach
// into this module's services/adapters directly.
export { isApprovalStillValid } from "./services";
export { createLiveWriteExecutorIfEnabled } from "./adapters/write-executor";
