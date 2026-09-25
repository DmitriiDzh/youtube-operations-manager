import { setSelectedChannelId } from "@/lib/db";
import { createWriteContextCore } from "@/lib/write-context";
import { createMetadataGenerator } from "./adapters/metadata-generator";
import { createDefaultLogger } from "./adapters/logger";
import { createTranscriptProvider } from "./adapters/transcript-provider";
import { createYoutubeApiAdapter } from "./adapters/youtube-api";
import { resolveGoogleCredentials } from "./adapters/google-auth";
import { createVideoMetadataServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createVideoMetadataCore() {
  const writeContext = createWriteContextCore();

  const services = createVideoMetadataServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createYoutubeApiAdapter(),
    transcriptProvider: createTranscriptProvider(),
    metadataGenerator: createMetadataGenerator(),
    logger: createDefaultLogger(),
    writeContext,
    channelSelectionStore: {
      setSelectedChannelId,
    },
  });

  return services;
}

export type VideoMetadataCore = ReturnType<typeof createVideoMetadataCore>;
