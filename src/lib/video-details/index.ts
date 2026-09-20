import { randomUUID } from "node:crypto";
import { getSelectedChannelId, setSelectedChannelId } from "@/lib/db";
import { createWriteContextYoutubeApiAdapter } from "@/lib/write-context/adapters/youtube-api";
import { createWriteContextService } from "@/lib/write-context/service";
import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createBackupCore } from "@/lib/backup";
import { createVideoDetailsYoutubeApiAdapter } from "./adapters/youtube-api";
import { createVideoDetailsAuditStoreAdapter, createVideoDetailsLocalCacheAdapter } from "./adapters/store";
import { createVideoDetailsServices } from "./services";

export function createVideoDetailsCore() {
  const writeContext = createWriteContextService({
    youtubeApi: createWriteContextYoutubeApiAdapter(),
    channelSelectionStore: {
      getSelectedChannelId,
      setSelectedChannelId,
    },
  });

  return createVideoDetailsServices({
    authResolver: { resolve: resolveGoogleCredentials },
    writeContext,
    channelSelectionStore: { setSelectedChannelId },
    youtubeApi: createVideoDetailsYoutubeApiAdapter(),
    backup: createBackupCore(),
    auditStore: createVideoDetailsAuditStoreAdapter(),
    localCache: createVideoDetailsLocalCacheAdapter(),
    idGenerator: () => randomUUID(),
  });
}

export type VideoDetailsCore = ReturnType<typeof createVideoDetailsCore>;
