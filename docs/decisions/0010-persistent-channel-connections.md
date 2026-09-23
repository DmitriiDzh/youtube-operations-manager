# 0010. Persistent, re-activatable channel connections without re-consenting to Google each switch

Status: Accepted

Decided directly with the project owner over Telegram, 2026-09-23.

## Context

Following ADR 0008 (a single, device-persistent Google Cloud grant that survives channel
re-login), the project owner asked whether the same "log in once, stays connected until I revoke
it" property could extend to actual channel logins: *"Заводим отдельный раздел в настройках где
можно подключать сколько угодно каналов, логинясь 1 раз."* A prior research pass (this session)
established the current model: `users` is one row per Google OAuth identity ("sub") that has ever
signed in, keyed by `token.sub`; `channels.connectedUserId` links a locally-known channel to the
`users` row that last authenticated as it. "Switch channel" (`src/app/dashboard/page.tsx`) calls
`signIn("google")`, and the Google provider's own `authorization.params` (`src/lib/auth.ts`)
always carry `prompt: "select_account consent"`, forcing Google's account picker and consent
screen on **every** switch, even to a channel already known to this app with a perfectly valid,
never-revoked refresh token still sitting in `users`.

The owner also gave a standing instruction to apply while building this: extract logic needed by
more than one feature module into its own module (`AGENTS.md` §M), rather than duplicating it —
naming this feature module itself as an example of the same discipline.

## Problem

Two things needed establishing before design, not assumed from the request's surface shape:

1. **Is credential persistence actually missing, or only the "switch without re-consenting"
   mechanism?** Investigation found `users`' plaintext token columns are already *never deleted*
   between sessions (`upsertUserOAuthOnSignIn` only overwrites the identity that just signed in;
   every other previously-seen identity's row, tokens included, sits untouched), and
   `getAuthenticatedYoutube` already silently refreshes an expired access token via the stored
   refresh token whenever a session is active. The actual gap is narrower than "persist tokens
   somewhere new": there is no way to make an existing NextAuth session become a **different,
   already-known** identity without physically going through Google's OAuth redirect and consent
   screen again — NextAuth has no built-in "resume as an already-authorized identity" primitive.
2. **How wide is credential resolution's blast radius?** Grepped every consumer of
   `users.accessToken`/`refreshToken`: dozens of API routes call `getServerSession(authOptions)`
   directly and thread `session.user.id` into `getAuthenticatedYoutube(userId)` themselves — there
   is no single existing choke point through which a redesign could be threaded narrowly. Any
   design that requires changing how those call sites resolve identity would be a sprawling,
   high-risk change for what the owner actually asked for.

## Decision

**Do not introduce a new encrypted multi-row credential store.** `users` already persists every
connected identity's tokens indefinitely; the missing piece is purely a way to make a **new**
NextAuth session point at an **already-stored** identity, bypassing Google's consent screen.

- **A new NextAuth Credentials provider, `channel-connections`** (`src/lib/auth.ts`), whose
  `authorize()`:
  1. Requires an **already-valid existing session** (`getToken({ req })` from `next-auth/jwt` must
     resolve to a real token) before doing anything else — activating a stored channel is a
     privileged action gated on already being signed into this app somehow, mirroring ADR 0008's
     "all four routes require an active channel-login session" precedent, and never independently
     exposed as an unauthenticated way to assume any local identity.
  2. Resolves the target channel's stored identity via the new
     `src/lib/channel-connections/services.ts`'s `resolveChannelIdentityForActivation(channelId)`
     (reads `channels.connectedUserId` -> the `users` row's `id`/`email`/`name`/`image`, failing
     closed if the channel is unknown, not connected, or has no stored access token).
  3. Returns a NextAuth `user` object shaped exactly like the Google provider's, so the existing
     `jwt`/`session` callbacks (already generic — `session.user.id = token.sub`) populate the new
     session identically to a fresh Google sign-in, with zero changes needed anywhere else.
- **`callbacks.signIn` gains one branch**: for `account.provider === "channel-connections"`, skip
  `upsertUserOAuthOnSignIn` entirely (that provider's synthetic `account` carries no real OAuth
  tokens; calling the existing upsert unconditionally would silently null out the target identity's
  perfectly good, already-stored tokens — the exact bug this branch exists to prevent).
- **`src/lib/channel-connections/`** (new domain module, `contracts.ts`/`services.ts`/`index.ts` —
  no `adapters/` layer needed, since it reads/writes the existing `channels`/`users` tables via
  `db.ts` functions directly, the same way `channel-access`/`write-context` already do, rather than
  introducing a redundant storage abstraction for tables that already have one):
  - `listConnectedChannels()` — `channels` rows with a non-null `connectedUserId`, joined to their
    `users` row's `email`, for the new Settings section.
  - `resolveChannelIdentityForActivation(channelId)` — described above.
  - `disconnectChannel(channelId)` — revokes the stored token with Google (best-effort, same
    finally-clear pattern as `cloud-connection`'s `disconnect()`), **clears** (does not delete) the
    `users` row's token columns via the existing `clearUserOAuthTokens`, and sets
    `channels.connectedUserId = NULL`. Returns which `userId` was disconnected so the calling route
    can compare it to the live session and signal the client to sign out if it just disconnected
    itself. Clearing tokens rather than deleting the `users` row avoids the legacy (removed-from-UI
    but still schema-present) `rules.user_id REFERENCES users(id)` foreign key ever blocking a
    disconnect, and is simpler to reason about than a conditional delete.
- **New Settings sub-tab, "Channels"** (`src/components/channel-connections-settings.tsx`): lists
  every connected channel (title, thumbnail, connected email, an "Active now" badge for whichever
  one matches the live session), an "Activate" button per non-active row (calls
  `signIn("channel-connections", { channelId, redirect: false })` — no Google round-trip), a
  "Disconnect" button per row behind the existing `ConfirmDialog` convention (irreversible,
  BL-043), and a "Connect a new channel" action that reuses the existing `signIn("google")` call
  unchanged (first-time connection is not a new mechanism — it is exactly today's login).
  **Found live by the project owner testing this exact flow (2026-09-23):** `signIn("google")`
  alone does not link the newly-authenticated identity into `channels.connectedUserId` — that link
  is set only by `channel-sync`'s "mine" resolution (`src/lib/channel-sync/services.ts`), a
  separate action the existing app only ever triggers from the Content/Languages tabs.
  `GET /api/youtube/channel-info` (fetched automatically on every dashboard load) only updates
  `users.selectedChannelId` (ADR 0004), never that link. Without a fix, a channel connected via
  "Connect a new channel" silently never appeared in this list until the operator separately
  visited Content/Languages. Fixed by having this card's own mount effect call
  `POST /api/channels/sync` (mine-path, no explicit `channelId`) before fetching the connections
  list — self-contained, runs once per dashboard session like every other Settings card, and
  reuses the exact same, already-tested sync path `content-manager.tsx` already relies on.
- **No schema change.** `channels`/`users` already carry every field this needs.
- **Shared-logic extraction, per the owner's explicit instruction this session:** `ai-connections/crypto.ts`
  and `cloud-connection/crypto.ts` were byte-for-byte identical AES-256-GCM implementations
  (confirmed by direct comparison), differing only in which env var they read and which
  `DomainError` they throw. Extracted the actual duplicated logic (`encryptSecret`/`decryptSecret`/
  a parameterized `resolveEncryptionKeyFromEnv(envVarName)`) into a new shared
  `src/lib/shared-crypto/` module; both existing modules now import from it and keep only their own
  thin `requireEncryptionKey` wrapper (own env var name, own error type) — preserving each
  feature's independent failure mode (`AGENTS.md` §M) while removing the copy-pasted
  implementation itself. `channel-connections` needs no encryption (it has no new secret store),
  so it is not a third consumer of `shared-crypto` — the extraction here is purely a dedup of two
  already-shipped modules, done under this session's explicit instruction rather than as an
  unprompted retrofit.

## Alternatives considered

- **A: A new encrypted `channel_connections` table, mirroring `cloud_connection`'s shape exactly.**
  Rejected once investigation showed `users` already persists these tokens indefinitely — building
  a second, N-row store for data that already exists in `users` would be a real duplicate credential
  store, the opposite of the modularity the owner asked for, and would still need a migration
  question ("does the existing active channel's connection appear automatically, or require
  reconnecting?") that the chosen design avoids entirely (it does appear automatically — see
  Consequences).
- **B: Rework `assertActiveChannel`/`assertWriteChannel`/every read-gateway caller to resolve
  credentials from a new store instead of the live NextAuth session.** Rejected — grep confirmed
  dozens of independent `getServerSession()` call sites, not one choke point; this would be a
  sprawling, high-risk rewrite of already-working, safety-adjacent code for no behavioral gain over
  Decision's approach, which achieves the same user-visible outcome (switch without re-consenting)
  by making the *session itself* re-resolvable to a stored identity, leaving every downstream
  consumer untouched.

## Consequences

**Easier:** switching to a previously-connected channel is one click, no Google round-trip, no
re-consent. The channel the owner is using right now already has a `connectedUserId` (set by the
existing channel-info/channel-sync flow, ADR 0004) with valid tokens in `users` — it appears in the
new "Channels" list automatically, marked active, with no reconnect step required.

**Unaffected, deliberately:** `assertWriteChannel`'s live OAuth cross-check (`docs/PROJECT_SPEC.md`
§27) runs exactly as before against whichever session is active, regardless of whether that session
was established via Google or via this new provider — write-safety's guarantee is unchanged because
it was never based on *how* the session came to exist, only on what it resolves to *right now*.
RISK-39 (`syncChannel`'s explicit-`channelId` path has no ownership check) is neither fixed nor
widened by this change — this feature never calls `syncChannel`.

**New, deliberate exception to RISK-02's read-scoping precedent, tracked as RISK-49
(`docs/TECHNICAL_DEBT.md`):** unlike every other channel-scoped surface in this app, `GET
/api/channel-connections` and `POST /api/channel-connections/disconnect` are intentionally NOT
scoped to the caller's own active channel — the whole point of this feature is to see and manage
connections other than the one currently active. This is a real, larger blast radius than RISK-02's
fix established elsewhere (a valid session can list/revoke every connected channel, not just its
own), accepted here because narrowing it would defeat the feature, and recorded per `AGENTS.md` §F
rather than left as a silent, undocumented gap (found and flagged by this branch's own independent
review, round 2).

**New operational note:** disconnecting the channel matching the live session ends that session
(the client calls `signOut()` once the disconnect route reports it disconnected the active
identity) — an explicit, owner-visible action, not a silent background effect.

**Not built in this slice:** the topbar's existing "Switch channel" button still always calls
`signIn("google")` unchanged — the owner asked for a new Settings section, not a change to that
button's existing behavior. Wiring it to prefer the new stored-channel path is a natural, low-risk
follow-up but is out of scope here unless separately assigned.
