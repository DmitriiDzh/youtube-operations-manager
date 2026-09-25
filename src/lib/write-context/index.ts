import { getSelectedChannelId, setSelectedChannelId } from "@/lib/db";
import { createWriteContextYoutubeApiAdapter } from "./adapters/youtube-api";
import { createWriteContextService } from "./services";

export function createWriteContextCore() {
  return createWriteContextService({
    youtubeApi: createWriteContextYoutubeApiAdapter(),
    channelSelectionStore: {
      getSelectedChannelId,
      setSelectedChannelId,
    },
  });
}

export type { WriteContextService } from "./services";
export type {
  WriteChannelContext,
  WriteChannelInfo,
  WriteChannelSource,
  WriteChannelAlignment,
  WriteChannelAlignmentStatus,
  KnownWriteChannel,
  WriteChannelGuardrailCode,
  WriteChannelGuardrailDetails,
  AssertWriteChannelInput,
  AssertWriteChannelOutput,
  ExtendedDomainErrorCode,
} from "./contracts";
