# UPSTREAM_ANALYSIS.md

Phase 0 analysis of the TubeMaster-derived codebase that this independent repository was initialized from.

This document is descriptive, not prescriptive: it records what already exists so that Phase 2+ work can extend it rather than duplicate or replace it, per `AGENTS.md` and `docs/PROJECT_SPEC.md`.

---

## 1. Repository Architecture

Stack: **Next.js 16 (App Router, Turbopack) + TypeScript + NextAuth + googleapis + Drizzle ORM over libSQL/SQLite + Zod + MCP SDK**.

```text
src/
  app/                     Next.js App Router (Web UI + API route handlers)
    page.tsx               Sign-in landing page
    dashboard/page.tsx     Manual/Rules tabs (playlist ops UI)
    api/
      auth/[...nextauth]/  NextAuth route (Google OAuth, session)
      video-metadata/      preview / apply / transcript route handlers
      youtube/             videos / playlists / channel-info route handlers
      rules/, run/         Rule-based auto-playlisting engine
  cli/
    video-metadata.ts      Single CLI entry point (metadata, auth, playlist namespaces)
  mcp/
    server.ts              Single MCP stdio server (metadata + playlist tools)
  lib/
    auth.ts                Google OAuth (NextAuth + PKCE loopback + device flow)
    db.ts                  Drizzle/libSQL schema + user/token persistence
    youtube.ts              Low-level googleapis wrapper functions (channels/videos/playlists)
    video-metadata/         Domain module: contracts, schemas, services, adapters (core "apply metadata" logic)
    write-context/          Domain module: expectedChannelId guardrail service
    playlist-management/    Domain module: playlist CRUD + membership, contracts/schemas/services/adapters
    cli-auth/                CLI/MCP credential resolution, local active-user storage, errors
  components/               React client components for the dashboard (manual mode, rules)
  types/                    next-auth type augmentation
```

Domain modules under `src/lib/*` consistently follow a **contracts → schemas → services → adapters** layering:

- `contracts.ts` — plain TypeScript types and the shared `DomainError` class (stable error codes).
- `schemas.ts` — Zod schemas used to validate inputs/outputs at every boundary (CLI, MCP, API, tests all import the same schemas).
- `services.ts` — pure(ish) orchestration logic, dependency-injected (`ServiceDependencies`), fully unit-testable without hitting the network.
- `adapters/` — concrete implementations (`youtube-api.ts`, `google-auth.ts`, `logger.ts`, `metadata-generator.ts`, `transcript-provider.ts`) wired in via `index.ts` factory functions (`createVideoMetadataCore()`, `createPlaylistManagementCore()`).

This is the existing extension pattern and should be reused for new domains (`localization/`, `changesets/`, `batches/`, `audit/`, `backup/` per spec §47).

**Four interfaces share the same core services** (spec §2, §66 principle "one safe operational core, many interfaces"):

| Interface | Entry point | Wraps |
|---|---|---|
| Web UI | `src/app/**` route handlers + React components | `createVideoMetadataCore()`, direct `src/lib/youtube.ts` calls |
| CLI | `src/cli/video-metadata.ts` | `createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createCliAuthService()` |
| MCP | `src/mcp/server.ts` | same cores as CLI, via `createMcpToolHandlers()` |
| API | `src/app/api/**` | same `core.applyMetadata` / `core.previewMetadata` etc. |

Only the Web UI route handlers currently use NextAuth session-based credentials (`getServerSession`); CLI/MCP use a separate local credential-resolution path (`cli-auth`). Both converge on the same `authResolver.resolve()` → `ResolvedCredentials` shape consumed by the core services.

---

## 2. Important Modules and File Paths

| Concern | File(s) |
|---|---|
| OAuth (Web) | `src/lib/auth.ts` (`authOptions`, `YOUTUBE_SCOPES`) |
| OAuth (CLI loopback + device flow) | `src/lib/auth.ts` (`buildGoogleLoopbackAuthUrl`, `startGoogleDeviceAuthorization`, `pollGoogleDeviceAuthorizationToken`) |
| CLI/MCP local credential store | `src/lib/cli-auth/storage.ts`, `src/lib/cli-auth/service.ts`, `src/lib/cli-auth/errors.ts` |
| Persistence (users, tokens, rules, selected channel) | `src/lib/db.ts` (Drizzle schema + queries) |
| Low-level YouTube API wrapper | `src/lib/youtube.ts` |
| Video metadata domain (draft → apply) | `src/lib/video-metadata/*` |
| Channel identity guardrail ("expectedChannelId") | `src/lib/write-context/*` |
| Playlist domain (CRUD + membership) | `src/lib/playlist-management/*` |
| CLI entry | `src/cli/video-metadata.ts` |
| MCP entry | `src/mcp/server.ts` |
| API route handlers | `src/app/api/**/route.ts` |
| Web UI dashboard | `src/app/dashboard/page.tsx`, `src/components/manual-mode.tsx`, `src/components/rule-form.tsx`, `src/components/rule-list.tsx`, `src/components/run-button.tsx` |
| Error → HTTP status mapping | `src/app/api/video-metadata/error-status.ts` |
| Tests | co-located `*.test.ts` next to the module under test (Node's built-in `node:test` runner via `tsx`) |

---

## 3. Data Flow

### 3.1 Read path (e.g. list videos)

```text
Web UI / CLI / MCP
  → core.listVideos(input)                         [video-metadata/services.ts]
    → authResolver.resolve(credentialRef, scopes)   [cli-auth or NextAuth session]
    → youtubeApi.listVideos(credentials, channelId) [adapters/youtube-api.ts]
      → src/lib/youtube.ts: getMyChannelId → channels.list (contentDetails.relatedPlaylists.uploads)
      → src/lib/youtube.ts: listVideosByChannel → playlistItems.list (paginated, 50/page)
    ← VideoMetadataItem[] (videoId, title, description, publishedAt)
```

Channel video enumeration **already uses the uploads-playlist strategy** the spec requires (§9) — it does not use `search.list`. It is not yet batched with `videos.list` for full metadata (title/description come from `playlistItems.snippet`, not `videos.snippet`), and it does not currently fetch `localizations`, `defaultLanguage`, `privacyStatus`, or `thumbnails` in the list path — only in the single-video `getVideoMetadataContext` path.

### 3.2 Write path (apply metadata — the existing safety reference implementation)

```text
Web UI / CLI / MCP → POST /api/video-metadata/apply (or core.applyMetadata directly)
  1. authResolver.resolve(credentialRef, [YOUTUBE_WRITE_SCOPE])        — identity/credential check
  2. writeContext.assertWriteChannel(credentialRef, credentials,
       expectedChannelId)                                              — CHANNEL GUARDRAIL (fail-closed)
  3. youtubeApi.getVideoMetadataContext(credentials, videoId)          — fetch current remote snippet+localizations
  4. buildMetadataSyncProposal(context, draft)                         — compute before/after diff, merge localizations
  5. if dryRun: return proposal without calling YouTube                — DRY-RUN
  6. else: youtubeApi.applyMetadataProposal(credentials, proposal)      — videos.update(part: snippet+localizations)
  7. persist selected channel if guardrail says so
  8. logger.info(...)                                                  — structured log (not a durable audit trail)
```

This is the closest existing analogue to spec §21 (`buildSafeVideoUpdatePayload`) and §19–25 (backup/dry-run/audit/verify), but it is **partial**: it has identity check, a form of diff, and dry-run; it does **not** have an immutable backup artifact, a durable audit log, or post-write verification (see §5, Limitations).

Playlist writes (`playlist-management/services.ts`) follow the same `assertWriteChannel` guardrail pattern plus an additional **ownership preflight** (fetching the playlist and confirming its `channelId` matches the active write channel before mutating), which is stricter than the metadata path.

---

## 4. Authentication / Session Flow

Two independent but converging authentication paths, both ultimately producing `ResolvedCredentials` (`accessToken`, `refreshToken?`, `tokenExpiry?`, `scopeSet`):

**Web (NextAuth / browser session)**
1. `GoogleProvider` OAuth (`src/lib/auth.ts`) requests `YOUTUBE_SCOPES` (`openid email profile youtube.readonly youtube youtube.force-ssl`) with `access_type=offline`, `prompt=select_account consent`.
2. `signIn` callback (`authOptions.callbacks.signIn`) persists tokens into SQLite via `upsertUserOAuthOnSignIn` (`src/lib/db.ts`).
3. `session.user.id` = Google `sub`; API routes call `getServerSession(authOptions)` and build `credentialRef = { userId: session.user.id }`.
4. Token refresh is handled inside `src/lib/youtube.ts` (`getAuthenticatedYoutube`) via the `oauth2.on("tokens", ...)` listener, re-persisting rotated tokens.

**CLI / MCP (local, headless)**
1. PKCE loopback flow (`auth login`, default) — spins up a local HTTP server on `CLI_OAUTH_CALLBACK_PORT` (default 8787), opens the browser, exchanges the code via `exchangeGoogleAuthCode`.
2. Device flow alternative (`auth login --device`) — `startGoogleDeviceAuthorization` / `pollGoogleDeviceAuthorizationToken`, no local server needed (useful for remote/headless machines).
3. Resulting tokens are upserted into the same `users` table (`upsertOAuthUserFromCli`) and the resolved `userId` is written to `data/auth-context.json` (0600-permission-guarded on POSIX; best-effort on Windows) via `src/lib/cli-auth/storage.ts`.
4. `resolveEffectiveCredentialRef` (`src/lib/cli-auth/service.ts`) picks: explicit `credentialRef` arg > active local user > error (`AUTH_USER_NOT_FOUND`). This lets MCP tool calls omit `credentialRef` and still resolve to "whoever is locally logged in."
5. Scope sufficiency is enforced centrally by the credential resolver (`AUTH_SCOPE_INSUFFICIENT` if the stored/granted scope set is missing a required scope) — see `src/lib/video-metadata/adapters/google-auth.ts` and its tests.

Both paths converge on the **same SQLite `users` table** and the **same channel-guardrail service** (`write-context`), so a Web-authenticated user and a CLI-authenticated user are modeled identically once resolved to `ResolvedCredentials`.

---

## 5. Persistence Strategy

- Engine: **libSQL (local file, SQLite-compatible)** via `@libsql/client` + `drizzle-orm/libsql`, file at `data/playlist-manager.db` (filename is a legacy holdover from the original playlist-manager scope; the spec's naming rules — never identify by title, canonical IDs — should extend to renaming this file only with a documented reason, not implicitly).
- Schema (`src/lib/db.ts`), two tables today:
  - `users`: `id` (Google `sub`), `email`, `name`, `image`, `accessToken`, `refreshToken`, `tokenExpiry`, `oauthScope`, `selectedChannelId`.
  - `rules`: auto-playlisting match rules (`matchField`/`matchType`/`matchValue` → `playlistId`), tied to `userId`.
- Schema evolution is done via **idempotent `ALTER TABLE ... ADD COLUMN` in a try/catch** at boot (`initializeDatabase`), not a migration tool (Drizzle Kit is a devDependency but no migration files exist under version control yet — `drizzle-kit` is present but unused for now).
- **OAuth tokens are stored in plaintext** in this SQLite file (no field-level encryption). `data/` is `.gitignore`d entirely except a `.gitkeep`, and `data/oauth/`, `data/tokens/`, `credentials/` are separately ignored, but the DB file itself living at `data/playlist-manager.db` is the actual token store today. This is an acceptable local-first tradeoff per spec §37/§38 but should be called out explicitly in `docs/getting-started.md` (it partially is) and preserved as out-of-scope for Phase 0/1.
- No existing tables for: channels (as first-class entities), video sync cache, localizations, drafts, change sets, batches, audit events, or backups (spec §36 — all still to be added).
- `data/auth-context.json` (JSON file, not DB) holds the CLI/MCP "active local user" pointer — deliberately separate from the DB so CLI/MCP can resolve identity without importing the full Next.js/DB stack in every code path... in practice `cli-auth` does still import `db.ts` for token lookup, so this is more about explicit active-user selection than isolation.

---

## 6. MCP Contracts

Single stdio server (`src/mcp/server.ts`, `createMcpServer()`), tool names and current read/write posture:

| Tool | Type | Notes |
|---|---|---|
| `write_context` | read | active local user context |
| `write_channel_list` | read | known write channels (active OAuth + persisted selection), with alignment status |
| `write_channel_select` | **write (local only)** | persists `expectedChannelId` selection; explicitly does **not** switch OAuth identity |
| `whoami` | read | active local auth user |
| `auth_user_select` | **write (local only)** | switches local active user pointer only |
| `list` | read | list channel videos |
| `transcript` | read | transcript text/status |
| `preview` | read (generation) | produces a `MetadataDraft`, never writes |
| `apply` | **write (YouTube)** | supports `dryRun`; enforces `expectedChannelId` (required, not optional, in the MCP schema) |
| `playlist_list` | read | |
| `playlist_create` | **write (YouTube)** | guardrail-enforced |
| `playlist_update` | **write (YouTube)** | guardrail + ownership preflight |
| `playlist_delete` | **write (YouTube)** | guardrail + ownership preflight |
| `playlist_add_videos` | **write (YouTube)** | partial-success contract (`attempted/added/failures`) |
| `playlist_remove_videos` | **write (YouTube)** | partial-success contract (`requested/removed/failures`) |

All tool inputs are Zod schemas with `.strict()` (reject unknown fields). All tool outputs are JSON (`structuredContent` + stringified `content[0].text` mirror each other) — i.e. "stable machine-readable schemas," matching spec §49. Errors are always `DomainError`-shaped JSON (`{ ok: false, error: { code, message, details } }`), never bare prose, matching spec §49's "avoid returning only prose."

This already maps cleanly onto the spec's future **READ / PROPOSE / APPLY** MCP tool separation (§26, §49): `list`/`transcript`/`preview`/`playlist_list`/`write_context`/`whoami` are READ or PROPOSE-adjacent; `apply`/`playlist_*` mutation tools are APPLY. There is currently no distinct "propose only, human must separately approve" tool for metadata (`apply` with `dryRun: true` is the closest analogue but is still a single tool, not a separate change-set object) — this is the gap the future `changeset_*` tools (spec §49) are meant to fill.

---

## 7. Current Limitations Relevant to Future Localization Support

1. **No channel/video sync cache.** `listVideos` hits the API live every call; there is no local `videos` table, so building a "sync all videos, browse offline" localization table (spec §9–10) requires a new persistence layer, not a rewrite of the read path.
2. **List path doesn't carry localization/defaultLanguage/privacyStatus/thumbnails.** Only the single-video `getVideoMetadataContext` fetch returns `localizations`. Bulk localization UI (spec §11–12) needs either N+1 `videos.list` calls (acceptable at moderate scale via batching `id` as a comma list, which the current `getVideoById`/`getVideoMetadataContext` do **not** do — they fetch one ID at a time) or a new batched adapter function.
3. **Metadata apply only targets a single locale per call.** `buildMetadataSyncProposal` resolves exactly one `targetLanguage` and writes exactly one localization entry (while correctly preserving all others via object spread — this is the existing "safe merge" behavior spec §21 asks to formalize and test further for multi-locale batch imports).
4. **No draft/remote state separation model.** There is no `status` (`Missing/Draft/Changed/Ready/Error/Conflict`) or persisted draft object — `apply`'s dry-run response is ephemeral (returned to the caller, not stored), so nothing currently prevents a sync from silently discarding an unpersisted draft, because no draft is persisted yet at all. This is a clean, additive gap, not a regression to fix.
5. **No change-set model.** Spec §17's `ChangeSet`/`changes[]` shape (with `source: XLSX_IMPORT | MANUAL_EDIT | AI_GENERATION | API | MCP_AGENT`) has no analogue yet; `rules` (auto-playlisting) is a different, unrelated persisted concept and should not be conflated with it.
6. **No immutable backup, audit log, or per-item ledger.** `logger.info`/`logger.error` (`src/lib/video-metadata/adapters/logger.ts`) is structured but ephemeral (stdout), not a durable, queryable audit trail (spec §25) — this is the single biggest gap before safe bulk localization writes can be built (spec §19, §22, §24).
7. **No conflict detection.** Nothing compares an exported/imported baseline against current remote state before writing (spec §30); `applyMetadata` always re-fetches current remote state right before writing rather than trusting a stale local copy, which is *safe* for single-item apply but does not by itself solve the "exported Monday, imported Friday" batch scenario, since a batch needs to know intent captured at export time.
8. **No XLSX/import-export tooling** (no `xlsx`-family dependency in `package.json` yet).
9. **Retry/backoff logic is not centralized.** No visible bounded-exponential-backoff wrapper around `googleapis` calls today; each adapter call either succeeds or throws directly. Spec §29 retry classification (transient vs. permanent) will need a new shared wrapper, ideally in `src/lib/youtube.ts` or a new `src/lib/http/retry.ts`, used by all adapters uniformly.
10. **Quota estimation is not implemented.** No cost table or quota tracker exists (spec §28) — acceptable gap, flagged for later, not a Phase 0/1 blocker.

---

## 8. Safest Extension Points

Ranked by "least invasive, most reusable":

1. **New domain modules under `src/lib/`** (`localization/`, `changesets/`, `batches/`, `audit/`, `backup/`), each following the existing `contracts.ts` / `schemas.ts` / `services.ts` / `adapters/` pattern and each with its own `index.ts` core factory (mirroring `createVideoMetadataCore()` / `createPlaylistManagementCore()`). This requires zero changes to existing modules.
2. **A new `channels`/`videos` cache table** in `src/lib/db.ts` (additive `sqliteTable` definitions + idempotent `ALTER`/`CREATE TABLE IF NOT EXISTS` in `initializeDatabase()`), following the exact pattern already used for `selected_channel_id` and `oauth_scope` migrations. No existing table needs to change shape.
3. **A batched multi-video metadata adapter function** in `src/lib/youtube.ts` (e.g. `getVideosMetadataContextBatch(youtube, videoIds[])` using `videos.list({ id: videoIds })`, YouTube allows up to 50 IDs per call) — additive, does not touch `getVideoMetadataContext` (single-video) callers.
4. **Reusing `write-context`'s `assertWriteChannel` as the shared guardrail** for every new bulk write path (localization apply, default-language batch set, future publishing) instead of writing a parallel identity check — this directly satisfies spec §27's "generalize, don't remove" instruction.
5. **New API routes under `src/app/api/localizations/`, `src/app/api/changesets/`, `src/app/api/batches/`** mirroring the existing `src/app/api/video-metadata/*` route-handler + `error-status.ts` + `parse-json-body.ts` pattern, rather than a parallel API surface.
6. **New MCP tools registered in the existing `src/mcp/server.ts`** (`localization_list`, `localization_propose`, `changeset_get`, `changeset_validate`, deferring `changeset_apply` until the write pipeline is safe) — additive `server.registerTool(...)` calls, no changes to existing tool registrations.
7. **New CLI namespace** (`localization`) following the existing `parseArgs`/namespace-dispatch pattern in `src/cli/video-metadata.ts`, alongside `metadata`/`auth`/`playlist`.
8. **XLSX export/import as a pure, dependency-isolated module** (e.g. `src/lib/localization/xlsx.ts`), introducing one new npm dependency (a maintained `xlsx`/`exceljs`-class library) without touching any existing adapter.

---

## 9. Architectural Risks

1. **Plaintext OAuth tokens in a file-based SQLite DB.** Acceptable for a single-operator local-first tool (spec §37) but must never be relaxed to a shared/networked deployment without adding encryption at rest — flag before any "run this on a shared machine/server" future decision.
2. **Legacy DB filename (`playlist-manager.db`) and table shape drift.** As `users`/`rules` accumulate more idempotent `ALTER TABLE` patches, the lack of a real migration tool (despite `drizzle-kit` being installed) will eventually become error-prone; adopting Drizzle migrations before the schema grows much further (new `channels`/`videos`/`localizations`/`changesets`/`batches`/`audit`/`backups` tables incoming) is a reasonable near-term ADR candidate — not required for Phase 0/1, but worth flagging for Phase 2 planning.
3. **N+1 / per-video API call pattern.** Current `getVideo`/`getVideoMetadataContext` fetch one video at a time; a naive localization sync over "hundreds of videos" (spec §5, §52) built directly on top of these functions without batching would burn quota fast. The batching extension point (§8.3 above) must land before/with Phase 2 sync, not after.
4. **No durable audit trail today.** Every future write-safety acceptance test in the spec (§53–57) implicitly depends on an audit log existing; building batch execution before the audit/backup modules exist would create write paths that are hard to retrofit safely. Recommend building `audit/` and `backup/` domain modules early in Phase 2/3, even in minimal form, before batch execution logic.
5. **`rules` auto-playlisting engine is unrelated to localization but shares the same DB/user identity.** Low risk, but future schema changes to `users` (e.g. adding more selection state) must keep `rules`' foreign key (`userId`) intact — no observed coupling risk today, just a note for reviewers.
6. **Two parallel low-level YouTube wrappers exist:** `src/lib/youtube.ts` (used directly by Web UI API routes like `/api/youtube/videos`) and `src/lib/video-metadata/adapters/youtube-api.ts` / `src/lib/playlist-management/adapters/youtube-api.ts` (used by the core services, which internally call into `src/lib/youtube.ts` functions too). They are not duplicated logic — the adapters are thin wrappers around the same underlying `src/lib/youtube.ts` functions — but new code should be careful to extend `src/lib/youtube.ts` (the single low-level client) rather than adding a third parallel wrapper, per spec §3 ("do not create a second YouTube client abstraction in parallel").
7. **`upstream` remote (`Gentleman-Programming/tubemaster`) default branch is `feature-2`, and it is currently *behind* this repository's `main`** (diff shows upstream missing `AGENTS.md`, `docs/PROJECT_SPEC.md`, and having a different `README.md`/`.gitignore`/`CONTRIBUTING.md`) — i.e. no unmerged upstream drift exists today. This should be re-checked before any future `git fetch upstream` review, since upstream could move ahead independently at any time.

---

## 10. Summary

The existing codebase already implements a working, tested reference implementation of most of the *safety pattern* the spec asks for (identity check → validation → diff → dry-run, per §21, applied to single-video metadata updates and playlist mutations), across four converging interfaces (Web/CLI/MCP/API) built on a consistent contracts/schemas/services/adapters layering. It does **not** yet implement immutable backups, durable audit logs, change sets, batch execution/ledgers, conflict detection, or XLSX import/export — these are genuinely new, additive domains, not replacements for anything upstream. The safest path forward is to build each new capability as its own `src/lib/<domain>/` module reusing `write-context`'s guardrail and the existing interface-dispatch patterns, exactly as spec §47/§48/§49 suggest.
