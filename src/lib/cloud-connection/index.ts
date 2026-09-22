import { createGoogleOAuthClient, fetchGoogleIdentity, generateOAuthState, revokeGoogleToken } from "@/lib/auth";
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
    clock: { now: () => new Date() },
  });
}

export type CloudConnectionCore = ReturnType<typeof createCloudConnectionCore>;

export { CLOUD_CONNECTION_SCOPE, type CloudConnectionStatus } from "./contracts";
