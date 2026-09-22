# 0008. A single, device-persistent Google Cloud OAuth grant, entirely decoupled from per-channel YouTube login

Status: Accepted

Decided directly with the project owner over Telegram, 2026-09-22.

## Context

The gateway traffic counters shipped earlier the same day (`gateway_call_events`, rolling 24h
attempts/succeeded per category) answer "how much are we calling the gateways," but not "how close
are we to Google's own limits." The project owner asked for that second question to be answered
with real numbers: *"Можем ли мы собирать статистику? В каждом случае сколько запросов было
сделано / сколько прошло сквозь шлюз и сколько наши лимиты (например лимиты по API)."*

Research (this session, verified against Google's own REST reference pages) established that real
quota/usage numbers require two separate Google Cloud-level APIs, neither of which is a YouTube
API and neither of which fits under `youtube-read-gateway` (ADR 0007) or its per-channel OAuth
model:

- **Cloud Quotas API** (`cloudquotas.googleapis.com`, `quotaInfos.list`) — returns limits only,
  requires the full `https://www.googleapis.com/auth/cloud-platform` scope. Confirmed against the
  method's own "Authorization scopes" reference page: no narrower scope exists for this method.
- **Cloud Monitoring API** (`monitoring.googleapis.com`, `timeseries.list`) — returns actual usage,
  accepts the narrower `https://www.googleapis.com/auth/monitoring.read`.

Since both are needed for "how much have we used, and how close are we to the limit" together, and
`cloud-platform` is a superset of `monitoring.read`, one grant of `cloud-platform` covers both --
no reason to request two separate scopes.

The project owner then raised the identity question directly: *"Делаем полную интеграцию с
реальными квотами Google так же учитывай, что мы можем логиниться под разными каналами. Так что
право получать эту информацию не должно отзываться при смене аккаунта / логина. Нужно один раз
залогиниться под нужной учеткой и пока я сам не отзову это право - этот компьютер должен в любой
сессии иметь возможность получить эту информацию."* -- i.e. this grant must survive a channel
re-login/switch, which the existing `users` table (one row per Google account that has ever logged
in for channel access, refreshed/replaced on every sign-in) does not model.

This ADR covers only the connection itself (slice 1 of 3: connect/disconnect status in Settings,
automatic token refresh). No Cloud Quotas/Monitoring API call exists yet -- that is a separately
scoped follow-up slice that will call this module's `resolveCloudCredentials`.

## Problem

Three things needed deciding:

1. **Where does this credential live, given it must be independent of `users` (per-channel login)
   and independent of `ai_connection_credentials` (a different feature's own secret)?** Storing it
   in either existing table would make this grant's lifecycle accidentally coupled to something
   unrelated (a channel re-login, or the AI-localization module's own encryption key).
2. **Plaintext or encrypted?** `users`' OAuth tokens are plaintext, an accepted tradeoff for a
   YouTube-scoped token (RISK-07). This grant requests the full `cloud-platform` scope -- a
   materially larger blast radius if the database file were ever read by someone else.
3. **Does this belong under `youtube-read-gateway`'s umbrella, or is it its own module?**

## Alternatives

- **A: Store the grant as an extra column on `users`.** Rejected -- `users` rows are
  channel-login-scoped and get replaced on re-login; the owner's own requirement is that this
  grant survive exactly that event.
- **B: Reuse `ai_connection_credentials`' encryption key (`AI_CONNECTIONS_ENCRYPTION_KEY`).**
  Rejected per `AGENTS.md` §M (feature-module independence): the Cloud-quota feature would fail
  closed whenever the unrelated AI-localization module's key is absent, or vice versa -- two
  features sharing a single point of failure for no benefit.
- **C: Fold this into `youtube-read-gateway`.** Rejected -- that gateway's own ADR (0007) scopes it
  explicitly to "a real YouTube-family read client" with per-channel identity; Cloud Quotas/
  Monitoring are a different Google product family with a device-level (not channel-level)
  identity model. Forcing them under the same umbrella would blur exactly the distinction ADR 0007
  drew between "distinct Google API products get their own child," except one level further --
  here the products aren't even in the same domain (YouTube vs. Cloud infrastructure).
- **D (chosen): A new, independent `src/lib/cloud-connection/` module** with its own singleton
  table (`cloud_connection`), its own encryption key (`CLOUD_CONNECTION_ENCRYPTION_KEY`), and its
  own OAuth entry points (`/api/cloud-connection/{start,callback,status,disconnect}`), following
  the same contracts/schemas/services/adapters shape `docs/DEVELOPMENT_PLAYBOOK.md` §6.2 already
  uses for every other domain module, and the same AES-256-GCM approach `ai-connections/crypto.ts`
  established -- reusing the *pattern*, not the key.

## Decision

- **`src/lib/cloud-connection/`** is the one module for this grant: `contracts.ts`, `schemas.ts`,
  `crypto.ts`, `services.ts` (`getStatus`, `beginConnect`, `completeConnect`, `disconnect`,
  `resolveCloudCredentials`), `adapters/store.ts`, `index.ts`.
- **`cloud_connection`** (`src/lib/db.ts`, SCHEMA_MIGRATIONS version 11) is a true singleton table
  (exactly zero or one row, fixed id). `accessToken`/`refreshToken`/`tokenExpiry` are stored as one
  AES-256-GCM-encrypted JSON blob; `connectedEmail`/`scope`/`connectedAt` are plaintext (not
  secrets, shown as-is in Settings). **Never added to `SNAPSHOT_TRANSFERRED_TABLES`** -- device-local,
  same reasoning as `users`/`ai_connection_credentials`, re-established per device via its own
  Connect flow.
- **Encryption key is `CLOUD_CONNECTION_ENCRYPTION_KEY`**, a separate base64-encoded 32-byte env
  var from `AI_CONNECTIONS_ENCRYPTION_KEY` -- same AES-256-GCM approach, deliberately different key
  (`AGENTS.md` §M). Fails closed (`encryption_key_not_configured`) if unset, never a plaintext
  fallback -- unlike `users`' RISK-07 tradeoff, plaintext was judged not acceptable here given the
  broader scope requested (tracked as RISK-48, mirroring RISK-15's shape).
- **Requested scope is `https://www.googleapis.com/auth/cloud-platform` plus `openid`/`email`** --
  the former is a superset of `monitoring.read` (one grant covers both the future Quotas and
  Monitoring calls); the latter two are needed only so `fetchGoogleIdentity` (`src/lib/auth.ts`)
  can resolve *which* account connected (`connectedEmail`), via an `id_token` or the userinfo
  endpoint -- a `cloud-platform`-only access token cannot read either. **Found live, 2026-09-22:**
  the first real connection attempt threw "Unable to fetch user identity from Google" before
  `openid`/`email` were added; the callback route also unconditionally rethrew any non-`DomainError`
  at the time, so this surfaced as a raw framework 500 page instead of a clean redirect -- fixed
  alongside the scope fix (the route now catches and logs every error, since a full-page OAuth
  redirect has no JS error handling available either way).
- **New routes, entirely separate from the NextAuth channel-login flow**: `GET
  /api/cloud-connection/start` (redirects to Google's consent screen, `state` in a short-lived
  httpOnly cookie), `GET /api/cloud-connection/callback` (exchanges the code, persists the
  encrypted grant, redirects back to the dashboard), `GET /api/cloud-connection/status` (public
  shape, never the token), `POST /api/cloud-connection/disconnect` (revokes with Google, clears the
  row). All four require an active channel-login session (`getServerSession`) -- this grant is
  independent of *which* channel is active, not of whether *someone* is authenticated to this app
  at all.
- **Settings-tab card** (`src/components/cloud-connection-settings.tsx`), mounted alongside
  `ReadGatewaySettings`/`LiveWritesSettings`: shows connected email/date or a Connect button;
  Disconnect clears it. No Cloud Quotas/Monitoring numbers are shown yet.

## Rationale

A new, independent module is the direct implementation of `AGENTS.md` §M (feature-module
independence: a large feature vertical, and shared logic it needs, gets its own separate module,
never grafted onto an unrelated one) applied to a credential store rather than to
`youtube-read-gateway`/`youtube-write-gateway`'s original read/write-call shape -- the same
principle, a different kind of "shared logic." Choosing encryption over RISK-07's plaintext
precedent follows directly from the scope's own larger blast radius, not from an arbitrary
preference for one existing pattern over the other; the `ai-connections/crypto.ts` approach is
reused because it is already proven correct in this codebase, under a key of its own to keep the
two features' failure modes independent.

## Consequences

**Easier:** the future Quotas/Monitoring slice has one function to call
(`resolveCloudCredentials`) and no OAuth/credential-storage decisions left to make. Switching or
re-authenticating a YouTube channel never touches this grant, and vice versa -- exactly the
independence the owner asked for.

**New operational requirement:** connecting requires `CLOUD_CONNECTION_ENCRYPTION_KEY` to be set
(fails closed otherwise) and requires `http://localhost:3000/api/cloud-connection/callback` (or the
deployed `NEXTAUTH_URL`'s equivalent) to be added to the OAuth client's own "Authorized redirect
URIs" in Google Cloud Console -- a separate redirect URI from the one NextAuth's channel-login flow
already uses.

**New risk tracked:** RISK-48 (`docs/TECHNICAL_DEBT.md`) -- no key-rotation/backup procedure for
`CLOUD_CONNECTION_ENCRYPTION_KEY`, mirroring RISK-15's already-accepted shape for the AI-connections
key.

**No Quotas/Monitoring data exists yet:** this ADR and the code it describes cover only the
connection itself. A future ADR or plan document will cover the actual API calls once that slice is
assigned.

## Compatibility / migration impact

Purely additive: one new table (`cloud_connection`, SCHEMA_MIGRATIONS version 11), no existing
table or column changed. No existing route, contract, or UI behavior changed -- the new Settings
card and API routes are new surface area only.

## Update (2026-09-22, later the same day): scope narrowed after the Cloud Quotas API was dropped

Slice 3 (`docs/ARCHITECTURE.md` §16) shipped a live spike that found the Cloud Quotas API's
`quotaInfos.list` -- this ADR's own stated reason for requesting the full `cloud-platform` scope
above -- unnecessary: the Cloud Monitoring API alone supplies both the limit and usage numbers.
The project owner asked directly, once told this (Telegram, verbatim): *"Если он нам действительно
не нужен, то зачем нам его оставлять? Давай удалим из проекта"* -- and, once the choice was
explained (no Cloud Quotas API code exists to delete, but the broad scope it had justified could be
narrowed), confirmed: *"ок, давай сузим."*

**`CLOUD_CONNECTION_SCOPE` changed from `cloud-platform` to `https://www.googleapis.com/auth/
monitoring.read`** (`src/lib/cloud-connection/contracts.ts`) -- the actual, narrower requirement
Cloud Monitoring's `timeSeries.list` needs (confirmed against Google's own REST reference,
per this ADR's own §Context). `openid`/`email` are unaffected -- still requested for
`fetchGoogleIdentity`, unrelated to which Cloud API scope is used.

**This narrows an already-granted scope, which Google does not downgrade automatically** -- a
previously-connected account (granted under the old, broader `cloud-platform`) must be
disconnected and reconnected for the new, narrower consent to actually take effect. Encryption
(`src/lib/cloud-connection/crypto.ts`) is unaffected -- `monitoring.read` is still a real Google
Cloud grant, not a YouTube-scoped one, so plaintext remains not an acceptable default here.
