import { setSelectedChannelId } from "@/lib/db";
import { createWriteContextCore } from "@/lib/write-context";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createPlaylistYoutubeApiAdapter } from "./adapters/youtube-api";
import { withPlaylistListMemo } from "./playlist-list-memo";
import { createPlaylistManagementServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createPlaylistManagementCore() {
  const writeContext = createWriteContextCore();

  const services = createPlaylistManagementServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createPlaylistYoutubeApiAdapter(),
    writeContext,
    channelSelectionStore: {
      setSelectedChannelId,
    },
  });

  return withPlaylistListMemo(services);
}

export type PlaylistManagementCore = ReturnType<typeof createPlaylistManagementCore>;
export { forgetPlaylists } from "./playlist-list-memo";
