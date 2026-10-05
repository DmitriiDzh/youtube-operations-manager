import {
  DomainError,
  isDomainError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// Persistent, re-activatable channel connections (`docs/decisions/0010-persistent-channel-connections.md`,
// owner instruction, 2026-09-23). Reuses the existing `users`/`channels` tables -- every channel
// that has ever been connected already keeps its OAuth tokens in `users` indefinitely; this module
// only adds a way to list those connections and reactivate one without a fresh Google consent
// screen (via a new NextAuth Credentials provider, `src/lib/auth.ts`).
// ---------------------------------------------------------------------------

/** Public shape for the Settings "Channels" list -- NEVER includes a token or the internal
 * `users.id` behind the connection. `isActive` is computed server-side against the caller's own
 * live session id, never against `connectedEmail` -- two different channels (brand-account "sub"
 * identities) can legitimately share the same Google account email. */
export type ConnectedChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  connectedEmail: string;
  connectedAt: string; // ISO
  isActive: boolean;
};

/** What the new NextAuth Credentials provider needs to mint a session for a stored channel. */
export type ActivationIdentity = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
};

export type DisconnectResult = {
  /** False when the channel was already disconnected (or never connected) -- a safe no-op. */
  disconnected: boolean;
  /** The `users.id` that was disconnected, so the caller (the API route) can tell whether it just
   * disconnected the identity behind the live session and must signal the client to sign out. */
  disconnectedUserId: string | null;
};

// ---------------------------------------------------------------------------
// Connection health (BL-115, docs/roadmap/plans/CONNECTION_REAUTH_PLAN.md). While the OAuth app is in Testing
// status Google expires a refresh token 7 days after it was issued; this lets the dashboard ask for a new
// login before (or as soon as) a stored connection stops working.
// ---------------------------------------------------------------------------

/** Google's refresh-token lifetime for an OAuth app in Testing status (the owner confirmed: Testing). */
export const REFRESH_TOKEN_MAX_AGE_DAYS = 7;
/** A day of margin: from this age on the dashboard warns. */
export const REFRESH_TOKEN_WARN_AGE_DAYS = 6;
/** A real token check is reused for this long, so reloading the dashboard does not hammer Google. */
export const HEALTH_PROBE_CACHE_MINUTES = 10;

export type ConnectionHealthState = "ok" | "expiring_soon" | "reauth_required" | "unknown";

/** Outcome of the real refresh-token check, as the verdict function sees it. */
export type HealthProbe = "ok" | "invalid_grant" | "error" | "not_run";

/** Public shape: NEVER includes a token or the internal `users.id`. */
export type ConnectionHealth = {
  /** BL-126: `"cloud"` marks the single Google Cloud (quota statistics) grant listed beside the channel logins; absent = a channel. */
  kind?: "channel" | "cloud";
  channelId: string;
  title: string;
  connectedEmail: string;
  isActive: boolean;
  state: ConnectionHealthState;
  /** Whole days since Google issued the refresh token; `null` when that date was never recorded. */
  ageDays: number | null;
  /** Whole days left before the 7-day limit, when the age is known and the limit applies; else `null`. */
  daysLeft: number | null;
  /** ISO time of the real check this verdict used; `null` when none ran (or it could not complete). */
  checkedAt: string | null;
};
