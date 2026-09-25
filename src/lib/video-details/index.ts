import { createIdGenerator } from "@/lib/video-metadata/contracts";
import { setSelectedChannelId } from "@/lib/db";
import { createWriteContextCore } from "@/lib/write-context";
import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createBackupCore } from "@/lib/backup";
import { createVideoDetailsYoutubeApiAdapter } from "./adapters/youtube-api";
import { createVideoDetailsAuditStoreAdapter, createVideoDetailsLocalCacheAdapter } from "./adapters/store";
import { createVideoDetailsServices } from "./services";

export function createVideoDetailsCore() {
  const writeContext = createWriteContextCore();

  return createVideoDetailsServices({
    authResolver: { resolve: resolveGoogleCredentials },
    writeContext,
    channelSelectionStore: { setSelectedChannelId },
    youtubeApi: createVideoDetailsYoutubeApiAdapter(),
    backup: createBackupCore(),
    auditStore: createVideoDetailsAuditStoreAdapter(),
    localCache: createVideoDetailsLocalCacheAdapter(),
    idGenerator: createIdGenerator(),
  });
}

export type VideoDetailsCore = ReturnType<typeof createVideoDetailsCore>;
