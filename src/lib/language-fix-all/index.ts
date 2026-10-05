import { createChannelLanguageDefaultsCore } from "@/lib/channel-language-defaults";
import { rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { getOperationRegistry } from "@/lib/operation-progress";
import { createQuotaGuardCore } from "@/lib/quota-guard";
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
    assertMutationAllowed: () => assertDeviceAvailableForMutation(rawSqlClient),
    // BL-117 slice 2: a bulk run that certainly needs more quota than is left is refused before it starts.
    quotaGuard: createQuotaGuardCore(),
  });
}

export type LanguageFixAllCore = ReturnType<typeof createLanguageFixAllCore>;
export { FIX_ALL_OPERATION_KIND } from "./services";
export { DomainError } from "./contracts";
