> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 15. Cloud connection (`src/lib/cloud-connection/`) — slice 1 of 3, not yet in `dev`

### 15.1 Status and scope

Owner instruction, 2026-09-22 (Telegram): a real Google Cloud Quotas/Monitoring integration was
requested to give the gateway traffic counters (§2.9k of `docs/SYSTEM_MAP.md`) actual limit/usage
numbers, not just local attempt counts. Research this session established the requirement splits
into two separate Google Cloud APIs (`docs/decisions/0008-cloud-connection.md` has the full trail):
Cloud Quotas API (`quotaInfos.list`, limits only, requires the full `cloud-platform` scope — no
narrower option per Google's own REST reference) and Cloud Monitoring API (`timeseries.list`,
actual usage, `monitoring.read` suffices but `cloud-platform` is a superset). The owner then added
an identity constraint: this grant must survive a channel re-login/switch (`users` does not).

This section covers **only slice 1**: the connection itself. No Cloud Quotas/Monitoring API call
exists in this codebase yet — `resolveCloudCredentials()` (below) is built for a future slice to
call, not called from anywhere in production code today.

### 15.2 Why a new, independent module

`AGENTS.md` §M (feature-module independence) requires shared logic used by more than one large
feature vertical to live in its own module, never grafted onto an unrelated one. This credential
does not fit either existing OAuth surface:

- Not `users` (`src/lib/db.ts`) — that table is channel-login-scoped, replaced on every re-login;
  the owner's own requirement is that this grant survive exactly that event.
- Not `ai_connection_credentials` — a different feature's own secret, encrypted under
  `AI_CONNECTIONS_ENCRYPTION_KEY`. Reusing that key would make the Cloud-quota feature fail closed
  whenever the unrelated AI-localization module's key is absent, and vice versa.
- Not `youtube-read-gateway` (`docs/decisions/0007-youtube-read-gateway.md`) — that gateway is
  explicitly scoped to "a real YouTube-family read client" with per-channel identity; Cloud Quotas
  and Monitoring are a different Google product family entirely, with a device-level, not
  channel-level, identity model.

`src/lib/cloud-connection/` therefore follows the same contracts/schemas/services/adapters shape
every other domain module uses (`docs/DEVELOPMENT_PLAYBOOK.md` §6.2), with its own singleton table,
its own encryption key, and its own OAuth entry points.

### 15.3 Storage

`cloud_connection` (`src/lib/db.ts`, SCHEMA_MIGRATIONS version 11) is a true singleton — exactly
zero or one row, always keyed on a fixed internal id never exposed to callers. `accessToken`/
`refreshToken`/`tokenExpiry` are serialized as one JSON blob and encrypted as a single unit
(AES-256-GCM, `src/lib/cloud-connection/crypto.ts`, the same approach `ai-connections/crypto.ts`
already uses, under its own `CLOUD_CONNECTION_ENCRYPTION_KEY` env var — deliberately not
`AI_CONNECTIONS_ENCRYPTION_KEY`). `connectedEmail`/`scope`/`connectedAt` are plaintext columns,
never secrets, shown as-is in the Settings tab.

**Plaintext was considered and rejected**, unlike `users`' own accepted RISK-07 tradeoff: this is a
real Google Cloud grant (`monitoring.read`, narrowed 2026-09-22 from the originally-requested full
`cloud-platform` once §16.2 found the Cloud Quotas API unnecessary — a materially narrower scope
than before, but still not a YouTube-scoped token), so plaintext storage was judged not an
acceptable default here — not a blanket "encrypt everything" policy this codebase otherwise
follows (`users` remains plaintext, tracked and accepted as RISK-07).

**Deliberately NOT added to `SNAPSHOT_TRANSFERRED_TABLES`** (`src/lib/snapshot/contracts.ts`) — same
reasoning as `users`/`ai_connection_credentials`: device-local, re-established per device via its
own Connect flow, never handed off with a snapshot/device-handoff import.

### 15.4 OAuth flow

Entirely separate from the NextAuth channel-login flow (`src/lib/auth.ts`'s `authOptions`/
`GoogleProvider`) — a full-page browser redirect, not a NextAuth provider:

1. `GET /api/cloud-connection/start` — requires an active channel-login session (any authenticated
   user of this app, independent of which channel is currently active). Builds Google's consent
   URL via `createGoogleOAuthClient(redirectUri).generateAuthUrl(...)` requesting
   `https://www.googleapis.com/auth/monitoring.read` (narrowed 2026-09-22 from the originally
   broader `cloud-platform` once §16.2 found the Cloud Quotas API unnecessary) **plus
   `openid`/`email`** (needed only so the callback can resolve *which* account connected — see
   the correction note below), with a random `state` stored in a short-lived (600s) httpOnly
   cookie scoped to `/api/cloud-connection`, and
   redirects the browser there.
2. `GET /api/cloud-connection/callback` — reads `code`/`state` from the query string and the
   expected state from the cookie; a mismatch (or a missing code/state, or an `error` param from
   Google) is refused before any token exchange. On success, exchanges the code
   (`oauthClient.getToken`), fetches the connected account's email via the existing
   `fetchGoogleIdentity` helper (shown in Settings only, never used for anything else — this grant
   is entirely independent of channel identity), encrypts the token set, and upserts the one
   `cloud_connection` row. Always redirects back to `/dashboard` with a `?cloudConnection=
   connected|error` query param the Settings card reads client-side (via
   `window.location.search`, not `useSearchParams()` — `/dashboard` is statically prerendered, and
   (BL-149: the callback now redirects to `/settings/api`; the section pages live under `src/app/(app)/`, see
   `docs/roadmap/plans/APP_ROUTES_PLAN.md` — the `dashboard/page.tsx` references in this document predate that)
   `useSearchParams()` would force a Suspense boundary just for this one-time banner). **Catches
   every error from `completeConnect`, not only `DomainError`** — a full-page OAuth redirect has
   no JS error handling available to the browser either way, so an unexpected error is logged
   server-side and still redirects cleanly rather than surfacing a raw framework 500 page.
   **Correction, found live, 2026-09-22:** the first real connection attempt requested only
   `cloud-platform` and this route only caught `DomainError` — `fetchGoogleIdentity` threw
   "Unable to fetch user identity from Google" (a `cloud-platform`-only token cannot read an
   `id_token` or the userinfo endpoint, both of which need `openid`/`email`), and the uncaught
   error surfaced as a raw "localhost is currently unable to handle this request" page. Both
   fixed together: the requested scope now includes `openid`/`email`, and this route catches
   everything.
3. `GET /api/cloud-connection/status` — the public shape only (`{ connected, connectedEmail,
   scope, connectedAt }` or `{ connected: false }`), never the token.
4. `POST /api/cloud-connection/disconnect` — revokes the refresh (or access, if no refresh) token
   with Google via the existing `revokeGoogleToken` helper, then clears the stored row regardless
   of whether the revoke call itself succeeded (a token Google no longer recognizes must not be
   left stored as if it were still usable).

### 15.5 Refresh

`resolveCloudCredentials()` mirrors the refresh pattern already established in
`src/lib/video-metadata/adapters/google-auth.ts`'s `resolveGoogleCredentials`: check the stored
`tokenExpiry` against the current time; if not expired, return the stored access token unchanged;
if expired, call `oauthClient.refreshAccessToken()` with the stored refresh token, re-encrypt and
persist the refreshed token set, and return the new access token. Throws (fails closed) if no
connection is stored, or if the token is expired with no refresh token available. Not called from
any production code path yet — reserved for the future Cloud Quotas/Monitoring slice.

### 15.6 What remains deliberately unimplemented

No Cloud Quotas API (`quotaInfos.list`) or Cloud Monitoring API (`timeseries.list`) call exists
anywhere in this codebase. No Settings UI shows a quota number or usage percentage — only
connect/disconnect status. Encryption-key rotation/backup tooling does not exist (RISK-48,
`docs/TECHNICAL_DEBT.md`, the same accepted shape as RISK-15's AI-connections equivalent).

## 16. Cloud Quotas (`src/lib/cloud-quotas/`) — real limit/usage numbers, slice 3 of `docs/decisions/0008-cloud-connection.md`'s plan

### 16.1 What this replaces

Section 15 established the Cloud connection (a device-persistent OAuth grant). This section covers
the actual real numbers that connection was for: the gateway traffic counters (§2.9k of
`docs/SYSTEM_MAP.md`) show local attempt counts, not how close the project actually is to Google's
own limits — this module closes that gap.

### 16.2 The Cloud Quotas API turned out to be unnecessary

The original plan (`docs/decisions/0008-cloud-connection.md`) assumed the Cloud Quotas API
(`quotaInfos.list`) would supply the limit half and Cloud Monitoring API (`timeSeries.list`) the
usage half. A live spike (2026-09-22, using a temporary diagnostic route reusing the app's own
session-based credential resolution, removed immediately after use — same pattern as the earlier
Phase 8 bulk-query probe) found:

- Cloud Quotas API is disabled for this project (`403 SERVICE_DISABLED`) and was never enabled.
- Cloud Monitoring API, already usable via the existing Cloud connection, exposes BOTH numbers on
  its own: `serviceruntime.googleapis.com/quota/limit` (a GAUGE, filtered to
  `limit_name="defaultPerDayPerProject"`) for the limit, and
  `serviceruntime.googleapis.com/quota/rate/net_usage` (a DELTA, summed over the query window) for
  usage. The BETA `quota/ratev2/*` metrics returned no data for this project and are not used.

This means Cloud Quotas API integration was dropped entirely — `src/lib/cloud-quotas/` only ever
calls Cloud Monitoring API's REST endpoints, via plain `fetch` (never the `googleapis` npm client,
mirroring `src/lib/auth.ts`'s own existing convention for simple REST calls like
`revokeGoogleToken`/`fetchGoogleIdentity`). Because no file in this module imports from
`"googleapis"`, `read-gateway-inventory.test.ts`'s project-wide check does not need to be amended
for this module at all — there is nothing for it to catch.

### 16.3 Project number

Cloud Monitoring's REST endpoints are scoped to `projects/{project}`. Rather than adding a new
configuration value, the project owner pointed out directly that Google's own OAuth client ID
format already encodes it: `{project_number}-{random}.apps.googleusercontent.com`. Confirmed real
and correct against the live spike. `deriveGoogleCloudProjectNumber()` (`src/lib/cloud-quotas/
index.ts`) extracts it from the existing `GOOGLE_CLIENT_ID` via a simple regex; returns `null`
(never throws) if unset or malformed, and the whole quota-status pipeline degrades to "unknown"
rather than crashing in that case.

### 16.4 Two independent pools, one shared UI number

`youtube.googleapis.com` covers both Data API v3 reads and Live writes (the same underlying Google
service — confirmed live: identical numbers appeared under both toggles' progress bars at the same
moment); `youtubeanalytics.googleapis.com` is a separate service with its own pool (confirmed:
10,000/day vs 100,000/day respectively at spike time). Per the owner's own instruction ("Можем пока
что отображать на Live write и на Data reads один и тот же счетчик"), `getQuotaStatus()`'s
`dataApi` field is deliberately reused by both `LiveWritesSettings` and `ReadGatewaySettings` in
the UI, rather than computing or displaying two separate numbers for what is actually one pool.

### 16.5 A real bug found and fixed before this shipped

The first live check after wiring the UI showed `analytics: null` despite the spike having
confirmed real Analytics quota data minutes earlier. Root cause: `quota/limit` is not a constant
heartbeat metric — Google only emits a fresh sample when the service actually receives traffic.
Data API v3 (near-constant traffic from ordinary use) always had a sample in a 1-hour lookback
window; the much less frequently called Analytics API often did not, making its card silently show
"unknown" even though the connection and the real limit were both fine. Fixed by widening
`fetchDailyQuotaLimit`'s window to 25 hours (a day plus buffer, the same margin
`gateway_call_events`' 7-day retention already uses around its own 24h window) — verified live
afterward: `analytics: { limit: 100000, usedLast24h: 176 }` came back correctly.

### 16.6 Failure handling

`getQuotaStatus()` never throws over an external Monitoring API problem. Each service's real fetch
is wrapped independently: a failure (rate limit, transient network error, the API becoming
disabled) degrades that one service to `null` ("unknown," never a fabricated `0`) without affecting
the other service or crashing the `/api/settings` response the Settings tab depends on. Not
connected at all, or `GOOGLE_CLIENT_ID` missing/malformed, degrades both services to `null` up
front without making any real network call.

### 16.7 What remains deliberately unimplemented

No caching or throttling — every `/api/settings` GET while the Settings tab is open makes 4 real
Cloud Monitoring API calls (limit + usage × 2 services). Acceptable for a personal, low-traffic
project (Monitoring reads are not the kind of API this project is trying to conserve quota on) but
not optimized; revisit if this becomes a real cost or latency concern. No dedicated
`/api/cloud-quotas` route exists — the numbers ride along inside the existing `/api/settings`
snapshot both consuming components already fetch.

### 16.8 Cloud Monitoring reads get the same traffic counter as the other gateways

Owner instruction, 2026-09-22, once told checking Google Cloud's own quota numbers is itself a
real API call: *"в таком случае на него нам нужно повесить такие же счетчики, как на другие API.
Он сделан по такой же схеме модуля / шлюза? чтобы все такие запросы шли только через него и
никак иначе?"* -- confirming the same single-gateway-per-API-category principle
(`docs/decisions/0007-youtube-read-gateway.md`) should apply here too.

`monitoring-client.ts`'s `callMonitoring` function is already the one choke point both
`fetchDailyQuotaLimit` and `fetchDailyQuotaUsage` (including its pagination loop) go through --
extended to call `recordGatewayCallOutcome("cloud_monitoring_reads", "allowed")` on every real
attempt, mirroring `assertDataApiReadsAuthorized`'s own pattern
(`src/lib/youtube-read-gateway/data-api.ts`). A fifth `GatewayTrafficCategory` value
(`src/lib/db.ts`) means it renders through the exact same `GatewayTrafficStats` component the
other three gateways already use -- shown in the "Google Cloud connection" Settings card. It never
records a `blocked` outcome: there is no enable/disable toggle for this category, so every
attempt is allowed by definition (unlike `mcp_tool_calls`, which records `blocked` for a call
rejected because its agent token is no longer valid -- Phase 12; BL-091's zone rejections were
retired with the zones -- see `src/lib/db.ts`'s own doc comment on `gatewayCallEvents`).

**Mechanical enforcement is a literal-string check, not an import check**, unlike
`read-gateway-inventory.test.ts`: this module never imports `googleapis` at all (§16.2), so there
is nothing for that kind of check to catch. `cloud-quotas-inventory.test.ts` instead fails the
build if any production file outside `adapters/monitoring-client.ts` contains the URL literal
`https://monitoring.googleapis.com` -- catching a future accidental second call site that would
silently bypass both this counter and the single-funnel property it exists to protect. The check
is scoped to the full URL, not the bare host name, because `QuotaService`
(`src/lib/cloud-quotas/contracts.ts`) and `services.ts` legitimately reference the bare
`"monitoring.googleapis.com"` string as a parameter value (identifying which service's quota to
ask about) without themselves ever constructing a request URL.

### 16.9 A third quota card: Cloud Monitoring's own limit/usage, per-minute not per-day

Same day, once told checking the other two services' quota is itself a real (separately quota'd)
API call, the owner noticed an inconsistency: *"Не вижу прогресс бара у Google Cloud connection"*
-- the other three gateway cards each show both a traffic count and a real quota progress bar, but
the Cloud connection card only had the former.

A first attempt reused `dataApi`/`analytics`'s own `defaultPerDayPerProject`-based fetch for
`monitoring.googleapis.com` and got `null` back. A follow-up live probe (same temporary-route
pattern, removed after use) found why: Cloud Monitoring API's own quota in this project is modeled
entirely per-MINUTE, not per-day -- `DefaultRequestsPerMinutePerUser` (effectively unlimited,
`9223372036854775807`) and `QueryRequestsPerMinutePerProject` (a real 6000/min cap) -- there is no
`defaultPerDayPerProject` entry to match against at all, unlike the other two services.
`fetchDailyQuotaLimit` correctly returned `null` (no fabricated number) rather than inventing a
daily figure from a per-minute one.

**Fixed by adding a genuinely separate per-minute code path, not by reusing the daily one:**
`fetchPerMinuteQuotaLimit` (filters `limit_name="QueryRequestsPerMinutePerProject"` instead of
`defaultPerDayPerProject`) and `fetchLatestMinuteUsage` (the single most recent 1-minute DELTA
point, scoped to the matching `quota_metric` -- usage has no `limit_name` label of its own, only
`quota_metric`, confirmed against real data -- and summed only across points sharing that one
most-recent `endTime`, since more than one series, e.g. per `method`, can report into the same
quota pool). Deliberately never sums across a 24h window the way `fetchDailyQuotaUsage` does: each
point already represents one minute's usage, so summing several minutes would compare multiple
minutes' worth of usage against a single-minute limit, always reading as "over."

`CloudQuotaStatus.monitoring` is typed `PerMinuteQuotaStatus` (`{ limit, usedLastMinute }`), a
distinct shape from `ServiceQuotaStatus`'s `usedLast24h` -- the two are not interchangeable, and
mixing them up would silently misrepresent the window a number describes. Rendered via a
dedicated `CloudQuotaProgressPerMinute` component (not the shared `CloudQuotaProgress`), with its
own label ("per minute," not "24h") and its own accent color -- indigo, matching the "Connect
Google Cloud"/"Save / Apply" buttons (owner instruction: "можем и цвет ему дать фиолетовый, так же
как у кнопки соединения с Cloud"), so it reads as structurally different from the other three red
24h bars at a glance, not a fourth copy of the same thing. `ProgressBar` itself gained an optional
`color` prop (`"red" | "indigo"`, default `"red"`) to support this without forking the component.

## 50. Cloud APIs together: one Settings tab, a Gemini card in Servers, spend and limits per account, one keys file (BL-193, ADR 0039)

Owner, Telegram 2026-10-16, msgs 2864/2867.

- **Settings.** One sub-tab, `cloud-apis`: the RunPod card (keys, S3, test), the Gemini key, the Gemini switch and limits, and the
  keys-file card. `/settings/runpod` and `/settings/gemini` are redirect pages (static segments win over `[sub]`). Each card has its
  own `FeatureErrorBoundary`; after an import the RunPod and Gemini cards reload on a window event.
- **Servers.** `gemini-servers-card.tsx` (Servers → Sessions, its own `FeatureErrorBoundary`) reads only `/api/gemini-media` every
  30 s: this computer's 20 newest jobs with cost or `≈` estimate, the key's spend today and this month against the limits with the
  other computers' part, the peers' lines (stale after 5 min). A failed read is a line in the card; RunPod's cards never depend on
  it. The header adds "Gemini today" (via `onToday`) and shows RunPod's account-wide figure with this computer's part.
- **RunPod spend.** `sessions.getLimits` adds `accountSpentTodayUsd` / `otherDevicesSpentTodayUsd` through `accountWide(..., { spendOnly:
  true })`: the peers' `media-sessions` reports only, no RunPod pod list on a polled read. `spentTodayUsd` stays this computer's
  because `publishSessionsShare` publishes it (an account figure there would double-count on every cycle).
- **Gemini spend.** `sync-gateway/gemini-spend` is a per-device report family (`per-device-report`): `ytm-gemini-spend` v1, strict,
  bounded (`spentTodayUsd` ≤ 100 000, `spentMonthUsd` ≤ 1 000 000, fingerprint `^[0-9a-f]{32}$` or null). `gemini-media/index.ts`
  `publishSpendShare` writes it from the Gemini share loop in `instrumentation.ts` (30 s; written on change, at least every 5
  min). `gemini-media/account.ts`: `geminiKeyFingerprint` = HMAC-SHA256 under the fixed label `ytm/gemini-key-fingerprint/v1`,
  first 32 hex (cached per stored ciphertext); `accountWideSpend` adds same-fingerprint peers (today: written since local
  midnight; month: since the 1st; not this device; not more than 5 min ahead). `services.spend()` returns `account`; `createJob`
  checks per-day and per-month against it (`otherComputersUsd` in a refusal when others spent). Unreadable reports count 0 and
  are logged (`deps.peerSpendReports` absent in unit tests).
- **Gemini limits.** `sync-gateway/media-settings` takes a `SettingsMapKind` (format + genesis actor); `sync-gateway/gemini-settings`
  is the same engine on `ytm-gemini-settings` with its own dirs and runner. `gemini-media/settings-sync.ts` owns the four shared
  fields and ADR 0030's rules (seed, publish changed, apply via `updateSettings` validation, hold conflicts and invalid values);
  `index.ts` wraps `updateSettings` to publish and exposes `syncSharedSettings` / `peekSettingsSync` / `resolveSettingConflict`;
  the share loop ticks it behind the device-mutation gate. The conflict screen fetches `/api/gemini-media/settings-sync` and resolves
  through `/api/gemini-media/settings-sync/resolve`, labelling fields `gemini.<field>`.
- **Keys file.** `src/lib/cloud-credentials-transfer/`: `contracts.ts` (formats, schemas), `services.ts` (no provider; per-section
  ports: `exportSecret`, `check`, `store`), `index.ts` (`cloudCredentialSections` wires `media-generation`'s
  `exportCredentialsForTransfer` / `checkCredentialsForImport` / `storeImportedCredentials` and `gemini-media`'s
  `exportKeyForTransfer` / `checkKeyForImport` / `storeImportedKey`, through their barrels, lazily). Export skips a section whose
  stored key cannot be read (`skipped`), refuses with `cloud_credentials_not_configured` when nothing is exportable. Import: decrypt
  (wrong password or damage changes nothing), the legacy file's ciphertext is the RunPod set, then every present section is checked
  before any is stored, then RunPod then Gemini are stored. Routes `/api/cloud-credentials/export|import` (Web session only).
- **Versions.** Agent API 3.19.0, Factory API 1.19.0; sync families `gemini_spend`, `gemini_settings` (15 in all).
