import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// Cloud connection: a single, device-persistent Google Cloud OAuth grant, decoupled from the
// per-channel YouTube login (`docs/decisions/0008-cloud-connection.md`, owner instruction,
// 2026-09-22). This slice only establishes the connection itself (connect/disconnect status,
// automatic refresh) -- no Cloud Quotas/Monitoring API call is made from this module. A future
// slice will call `resolveCloudCredentials` to actually query those APIs.
//
// The scope requested is the full `https://www.googleapis.com/auth/cloud-platform` -- confirmed
// against Google's own REST reference that the Cloud Quotas API's `quotaInfos.list` has no
// narrower scope option (the Cloud Monitoring API's usage query would accept the narrower
// `monitoring.read`, but `cloud-platform` is a superset and only one grant is requested).
//
// `openid`/`email` are ALSO requested alongside it -- not for any Cloud Quotas/Monitoring
// purpose, but because `completeConnect` needs to show *which* Google account is connected
// (`connectedEmail`) and `fetchGoogleIdentity` (`src/lib/auth.ts`) can only resolve that either
// from an `id_token` (needs `openid`) or from the userinfo endpoint (needs `email`/`profile`) --
// an access token scoped to `cloud-platform` alone cannot read either. Found live: the first real
// connection attempt failed with "Unable to fetch user identity from Google" for exactly this
// reason, before this scope was added.
// ---------------------------------------------------------------------------

export const CLOUD_CONNECTION_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const CLOUD_CONNECTION_REQUESTED_SCOPES = ["openid", "email", CLOUD_CONNECTION_SCOPE] as const;

/** Public shape -- NEVER includes the access/refresh token. */
export type CloudConnectionStatus =
  | { connected: false }
  | {
      connected: true;
      connectedEmail: string;
      scope: string;
      connectedAt: string;
    };

export type CloudConnectionCredentials = {
  accessToken: string;
};
