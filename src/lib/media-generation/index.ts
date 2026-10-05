import { appDataPaths } from "@/lib/db";
import { createRunpodApiClient, createRunpodS3Client } from "@/lib/media-gateway";
import { createFsKeyFile } from "./adapters/key-file-fs";
import { createMediaGenerationStore } from "./adapters/store";
import { createMediaGenerationServices } from "./services";

/** Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- see `./contracts.ts`. */
export function createMediaGenerationCore() {
  return createMediaGenerationServices({
    store: createMediaGenerationStore(),
    keyFile: createFsKeyFile(appDataPaths.appDataDir),
    gateway: {
      createRunpodClient: (apiKey) => createRunpodApiClient({ apiKey }),
      createS3Client: (config) => createRunpodS3Client(config),
    },
    clock: { now: () => new Date() },
  });
}

export type MediaGenerationCore = ReturnType<typeof createMediaGenerationCore>;
export { isDomainError, DomainError } from "./contracts";
export type { MediaCredentialsStatus, MediaCredentialsTestResult, MediaGenerationOverview, MediaSettings } from "./contracts";
export { DEFAULT_MEDIA_SETTINGS, NETWORK_VOLUME_USD_PER_GB_MONTH } from "./contracts";
