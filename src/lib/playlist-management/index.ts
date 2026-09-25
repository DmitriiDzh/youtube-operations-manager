import { setSelectedChannelId } from "@/lib/db";
import { createWriteContextCore } from "@/lib/write-context";
import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createPlaylistYoutubeApiAdapter } from "./adapters/youtube-api";
import { createPlaylistManagementServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createPlaylistManagementCore() {
  const writeContext = createWriteContextCore();

  return createPlaylistManagementServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createPlaylistYoutubeApiAdapter(),
    writeContext,
    channelSelectionStore: {
      setSelectedChannelId,
    },
  });
}

export type PlaylistManagementCore = ReturnType<typeof createPlaylistManagementCore>;
