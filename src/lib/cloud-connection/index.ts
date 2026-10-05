import { createGoogleOAuthClient, fetchGoogleIdentity, generateOAuthState, probeGoogleRefreshToken, revokeGoogleToken } from "@/lib/auth";
import { createCloudConnectionStoreAdapter } from "./adapters/store";
import { resolveEncryptionKeyFromEnv } from "./crypto";
import { createCloudConnectionServices } from "./services";

export function createCloudConnectionCore() {
  return createCloudConnectionServices({
    store: createCloudConnectionStoreAdapter(),
    oauth: {
      createOAuthClient: createGoogleOAuthClient,
      fetchIdentity: fetchGoogleIdentity,
      revokeToken: revokeGoogleToken,
      generateState: generateOAuthState,
    },
    resolveEncryptionKey: resolveEncryptionKeyFromEnv,
    probeRefreshToken: probeGoogleRefreshToken,
    clock: { now: () => new Date() },
  });
}

export type CloudConnectionCore = ReturnType<typeof createCloudConnectionCore>;

export { CLOUD_CONNECTION_SCOPE, type CloudConnectionHealth, type CloudConnectionStatus } from "./contracts";
