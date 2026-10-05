import { randomBytes, randomUUID } from "node:crypto";
import { appDataPaths } from "@/lib/db";
import { comfyUiProxyBaseUrl, createComfyUiClient, createRunpodApiClient, createRunpodS3Client } from "@/lib/media-gateway";
import { createFsKeyFile } from "./adapters/key-file-fs";
import { createMediaSessionStore } from "./adapters/session-store";
import { createMediaGenerationStore } from "./adapters/store";
import { createMediaGenerationServices } from "./services";
import { createMediaSessionServices } from "./sessions";

/**
 * Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- see `./contracts.ts`. One core: the slice-1
 * foundation (credentials, settings, catalog, pods/S3 passthrough) plus the slice-2 sessions.
 */
export function createMediaGenerationCore() {
  const base = createMediaGenerationServices({
    store: createMediaGenerationStore(),
    keyFile: createFsKeyFile(appDataPaths.appDataDir),
    gateway: {
      createRunpodClient: (apiKey) => createRunpodApiClient({ apiKey }),
      createS3Client: (config) => createRunpodS3Client(config),
    },
    clock: { now: () => new Date() },
  });
  const sessions = createMediaSessionServices({
    store: createMediaSessionStore(),
    base,
    createComfyClient: ({ baseUrl, token }) => createComfyUiClient({ baseUrl, token }),
    comfyUiProxyBaseUrl,
    generateId: () => randomUUID(),
    generateToken: () => randomBytes(24).toString("base64url"),
    clock: { now: () => new Date() },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.warn(line),
  });
  return { ...base, ...sessions };
}

export type MediaGenerationCore = ReturnType<typeof createMediaGenerationCore>;
export { isDomainError, DomainError } from "./contracts";
export type { MediaCredentialsStatus, MediaCredentialsTestResult, MediaGenerationOverview, MediaSession, MediaSessionLimits, MediaSettings } from "./contracts";
export { DEFAULT_MEDIA_SETTINGS, NETWORK_VOLUME_USD_PER_GB_MONTH } from "./contracts";
