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
// ---------------------------------------------------------------------------

export const CLOUD_CONNECTION_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

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
