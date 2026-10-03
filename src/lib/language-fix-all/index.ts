import { createChannelLanguageDefaultsCore } from "@/lib/channel-language-defaults";
import { getOperationRegistry } from "@/lib/operation-progress";
import { createVideoDetailsCore } from "@/lib/video-details";
import { createLanguageFixAllServices } from "./services";

export function createLanguageFixAllCore() {
  const languageDefaults = createChannelLanguageDefaultsCore();
  const videoDetails = createVideoDetailsCore();

  return createLanguageFixAllServices({
    getDeviations: (input) => languageDefaults.getDeviations(input),
    // The only write call in this module -- video-details' own gated, audited, verified apply.
    applyFieldsUpdate: (input) => videoDetails.applyFieldsUpdate(input),
    registry: getOperationRegistry(),
  });
}

export type LanguageFixAllCore = ReturnType<typeof createLanguageFixAllCore>;
export { FIX_ALL_OPERATION_KIND } from "./services";
export { DomainError } from "./contracts";
