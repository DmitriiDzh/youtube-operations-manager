import { createDefaultLogger } from "@/lib/channel-sync/adapters/logger";
import { getSelectedChannelId, setSelectedChannelId } from "@/lib/db";
import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createWriteContextYoutubeApiAdapter } from "@/lib/write-context/adapters/youtube-api";
import { createWriteContextService } from "@/lib/write-context/service";
import { createBackupCore } from "@/lib/backup";
import { createAuditCore } from "@/lib/audit";
import { createBatchStoreAdapter, createChangeSetStoreAdapter, createIdGenerator } from "./adapters/store";
import { createBatchYoutubeApiAdapter } from "./adapters/youtube-api";
import { createBatchServices } from "./services";

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
  const writeContext = createWriteContextService({
    youtubeApi: createWriteContextYoutubeApiAdapter(),
    channelSelectionStore: { getSelectedChannelId, setSelectedChannelId },
  });

  return createBatchServices({
    batchStore: createBatchStoreAdapter(),
    changeSetStore: createChangeSetStoreAdapter(),
    authResolver: { resolve: resolveGoogleCredentials },
    writeContext,
    youtubeApi: createBatchYoutubeApiAdapter(),
    backup: createBackupCore(),
    audit: createAuditCore(),
    clock: createRealClock(),
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type BatchCore = ReturnType<typeof createBatchCore>;
