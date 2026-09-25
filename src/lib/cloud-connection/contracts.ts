import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

// ---------------------------------------------------------------------------
// Cloud connection: a single, device-persistent Google Cloud OAuth grant, decoupled from the
// per-channel YouTube login (`docs/decisions/0008-cloud-connection.md`, owner instruction,
// 2026-09-22). Feeds `src/lib/cloud-quotas/`'s real Cloud Monitoring API calls (limit/usage
// numbers surfaced in Settings) -- no Cloud Quotas API call is made anywhere in this codebase.
//
// **Scope narrowed 2026-09-22** (owner instruction, Telegram: "Если он нам действительно не
// нужен, то зачем нам его оставлять?"): a live spike found the Cloud Quotas API's `quotaInfos.list`
// unnecessary entirely -- Cloud Monitoring API alone supplies both the limit and usage numbers
// (`docs/ARCHITECTURE.md` §16). The original scope, the full `cloud-platform`, was requested only
// because `quotaInfos.list` has no narrower option; with that API dropped, the actual requirement
// is just `https://www.googleapis.com/auth/monitoring.read` (confirmed sufficient for
// `timeSeries.list` against Google's own REST reference), a materially narrower grant (least
// privilege) than the broad, whole-project `cloud-platform` scope this connection requested
// before. Narrowing an already-granted scope requires the operator to disconnect and reconnect --
// the previously-granted `cloud-platform` token is not automatically downgraded.
//
// `openid`/`email` are ALSO requested alongside it -- not for any Monitoring purpose, but because
// `completeConnect` needs to show *which* Google account is connected (`connectedEmail`) and
// `fetchGoogleIdentity` (`src/lib/auth.ts`) can only resolve that either from an `id_token` (needs
// `openid`) or from the userinfo endpoint (needs `email`/`profile`) -- an access token scoped to
// `monitoring.read` alone cannot read either. Found live (before this scope was added at all): the
// first real connection attempt failed with "Unable to fetch user identity from Google".
// ---------------------------------------------------------------------------

export const CLOUD_CONNECTION_SCOPE = "https://www.googleapis.com/auth/monitoring.read";
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
