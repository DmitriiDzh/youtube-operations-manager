import { getStoredVideo, setSelectedChannelId } from "@/lib/db";
import { assertAgentScopeChannel, assertAgentScopeVideo, readStringField } from "@/lib/channel-access";
import { createWriteContextCore } from "@/lib/write-context";
import { createMetadataGenerator } from "./adapters/metadata-generator";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createTranscriptProvider } from "./adapters/transcript-provider";
import { createYoutubeApiAdapter } from "./adapters/youtube-api";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
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

  // Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md 12.3): these three live reads take an arbitrary
  // channelId/videoId and never pass through assertActiveChannel, so a channel-bound agent is
  // confined here, at the one wiring point every MCP/CLI caller uses. No-ops outside a session.
  // (applyMetadata needs nothing extra: write-context's live identity check already pins it to the
  // bound identity's own channel.)
  return {
    ...services,
    async listVideos(input: unknown) {
      assertAgentScopeChannel(readStringField(input, "channelId"));
      return services.listVideos(input);
    },
    async getTranscript(input: unknown) {
      await assertAgentScopeVideo(readStringField(input, "videoId") ?? "", getStoredVideo);
      return services.getTranscript(input);
    },
    async previewMetadata(input: unknown) {
      await assertAgentScopeVideo(readStringField(input, "videoId") ?? "", getStoredVideo);
      return services.previewMetadata(input);
    },
  };
}

export type VideoMetadataCore = ReturnType<typeof createVideoMetadataCore>;
