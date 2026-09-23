import {
  DomainError,
  isDomainError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";

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
