# ARCHITECTURE.md

Living architecture reference for this repository. For the historical TubeMaster-derived baseline and Phase 0/1 verification, see `docs/UPSTREAM_ANALYSIS.md` and `docs/UPSTREAM_BASELINE.md`. For the product roadmap and safety rules, see `docs/PROJECT_SPEC.md`.

This document is updated whenever a phase changes the architecture. Current as of **Phase 3 (Localization Manager read-only UI + XLSX export)**.

---

## 1. Stack

Next.js 16 (App Router, Turbopack) + TypeScript + NextAuth (Google OAuth) + googleapis + Drizzle ORM over libSQL/SQLite + Zod + MCP SDK. Test runner is Node's built-in `node:test` via `tsx`.

## 2. Interfaces over one shared core

```text
Human Operator          AI Agent / Claude / Codex
      │                          │
   Web UI                       MCP
      │                          │
      └──────────┬───────────────┘
                 CLI ─────────────┘
                  │
         Domain core services
   (video-metadata, playlist-management,
    write-context, channel-sync, ...)
                  │
        googleapis (YouTube Data API v3)
                  │
          libSQL / SQLite (data/playlist-manager.db)
```

Every interface (Web UI route handlers, CLI, MCP) calls the same domain-module core factory functions (`createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createChannelSyncCore()`); none of them re-implements YouTube API logic or write-safety checks independently. See `docs/PROJECT_SPEC.md` §66: "one safe operational core, many interfaces."

## 3. Domain module layering (`src/lib/*`)

Every domain module under `src/lib/` follows the same four-file layering, introduced with the original TubeMaster codebase and preserved for every module added since:

```text
contracts.ts   — plain TS types + the shared DomainError class (stable error codes)
schemas.ts     — Zod schemas validating every input/output boundary
services.ts    — orchestration logic, dependency-injected, unit-testable without network/DB
adapters/      — concrete implementations (YouTube API calls, persistence, logging)
index.ts       — core factory wiring real adapters into the services
```

| Module | Purpose | Write capability |
|---|---|---|
| `video-metadata/` | Transcript, AI-assisted draft preview, single-video metadata apply | Yes — guarded, dry-run capable |
| `playlist-management/` | Playlist CRUD + video membership | Yes — guarded, ownership-checked |
| `write-context/` | `expectedChannelId` fail-closed identity guardrail, shared by every write path | N/A (guardrail only) |
| `channel-sync/` (Phase 2) | Full-channel video enumeration + local persistence | **No — read-only** |
| `localization/` **(new, Phase 3)** | Read model over synced videos' existing localizations, missing-language computation, XLSX export | **No — read-only** |
| `cli-auth/` | Local credential resolution for CLI/MCP (active-user pointer, storage) | Local state only |

## 4. Phase 2: Channel/Video Synchronization (`src/lib/channel-sync/`)

### 4.1 Purpose and scope

Adds a reliable, quota-conscious full-channel sync workflow and local persistence for videos, laying the groundwork for the future Localization Manager (`docs/PROJECT_SPEC.md` §9–10). **This phase is read-only with respect to YouTube**: it only ever calls `channels.list`, `playlistItems.list`, and `videos.list` (all read endpoints, `YOUTUBE_READ_SCOPE` only). No `videos.update` or any other mutating call exists in this module.

### 4.2 Sync data flow

```text
Web UI / API → core.syncChannel({ credentialRef, channelId? })
  1. authResolver.resolve(credentialRef, [YOUTUBE_READ_SCOPE])      — identity/credential check (read-only scope)
  2. youtubeApi.getChannelForSync({ credentials, channelId })       — channels.list(mine|id) → { channelId, title,
                                                                       thumbnailUrl, uploadsPlaylistId }
  3. channelStore.upsertChannel(...)                                — persist/update channel row immediately
  4. youtubeApi.listUploadsPlaylistVideoIds({ uploadsPlaylistId })  — playlistItems.list, paginated 50/page,
                                                                       contentDetails.videoId only (cheap enumeration)
  5. youtubeApi.getVideosMetadataBatch({ videoIds })                — videos.list in chunks of ≤50 ids
                                                                       (part: snippet, status, localizations)
  6. channelStore.upsertVideos(entries, syncedAt)                   — upsert every video row for this channel
  7. channelStore.markChannelSynced(channelId, syncedAt)
  8. return { channel, videoCount, syncedAt }
```

Steps 4–5 are the two YouTube-quota-relevant calls. Step 4 uses the **uploads-playlist enumeration strategy** (never `search.list`), matching `docs/PROJECT_SPEC.md` §9. Step 5 batches up to 50 video IDs per `videos.list` call — for a channel with, say, 420 videos, this is **9 API calls total for full metadata**, not 420. See `src/lib/youtube.ts`:

- `listUploadsPlaylistVideoIds(youtube, uploadsPlaylistId)` — paginated enumeration, dedupes video IDs.
- `getVideosMetadataContextBatch(youtube, videoIds)` — chunks `videoIds` into groups of ≤50 and issues one `videos.list` call per chunk.

Both are unit-tested directly against a mocked `youtube_v3.Youtube`-shaped client in `src/lib/youtube.test.ts` (not just indirectly through the service layer), specifically to verify the chunking math (120 ids → 3 calls of 50/50/20) independent of any service-level mocking.

### 4.3 Why this phase has no write-context guardrail check

`write-context`'s `assertWriteChannel` exists to fail-close **write** operations against the wrong channel. `syncChannel` never writes to YouTube — it only reads whatever channel the resolved credentials can see (`mine`) or an explicitly-requested `channelId` the credentials have read access to. Adding a write-channel guardrail to a read path would be scope creep with no safety benefit; the guardrail will be reused as-is (not re-implemented) once Phase 4+ introduces the first localization **write** path, per `docs/PROJECT_SPEC.md` §27 ("generalize, don't remove").

### 4.4 Persisted fields per video

Matches `docs/PROJECT_SPEC.md` §9 minimum field list:

```text
videoId, channelId, title, description, publishedAt, privacyStatus,
defaultLanguage, defaultAudioLanguage, thumbnails, existingLocalizations,
lastSyncedAt, etag
```

`existingLocalizations` stores the full `{ [locale]: { title, description } }` map fetched via `videos.list(part: localizations)` — not just language codes — because the Localization Manager (Phase 3, `src/lib/localization/`) needs the actual remote title/description per locale, not only which locales exist. `existingLocalizationLanguages` (a derived, sorted array of the map's keys) is exposed alongside it purely for cheap UI rendering (badges) without every consumer having to re-derive it.

### 4.5 Re-sync semantics (no draft/remote distinction yet)

A re-sync **replaces** each video's persisted remote-mirror fields (title, description, localizations, etc.) with the freshly fetched values — there is currently no draft or change-set concept for this phase to protect (per `docs/PROJECT_SPEC.md` §58, the localization draft/apply workflow is an explicit non-goal until Phase 4+). Once drafts exist, sync must be revisited to detect and flag conflicts (`docs/PROJECT_SPEC.md` §30) rather than silently overwriting — **this is a known, intentional limitation of Phase 2, still true after Phase 3** (which adds no draft state either), not an oversight; see `docs/UPSTREAM_ANALYSIS.md` §7 item 4 and §10 (Extension points) below.

---

## 5. Phase 3: Localization Manager (read-only) + XLSX export (`src/lib/localization/`)

### 5.1 Purpose and scope

Adds a read-only view over the localization data already captured by Phase 2 sync (`videos.existingLocalizations`), plus an XLSX export. **No new YouTube API calls, no new database tables, and no write path exist in this module** — it is a pure read model over data `channel-sync` already persisted, plus a local file-generation adapter (`exceljs`). Matches `docs/PROJECT_SPEC.md` §62 (Third Agent Assignment): "Implement the Localization Manager read-only UI and XLSX export. Do not implement live localization writes yet."

### 5.2 Data flow

```text
Web UI / API → core.getLocalizationOverview({ credentialRef, channelId })
  1. channelStore.getChannel(channelId)              — from src/lib/db.ts, fails not_found if never synced
  2. channelStore.listVideosByChannel(channelId)      — from src/lib/db.ts (same table channel-sync writes)
  3. collectChannelLanguages(videos)                  — union of every existingLocalizations key across all
                                                          videos in this channel (never a hard-coded language list,
                                                          per docs/PROJECT_SPEC.md §13)
  4. per video: present/missing languages vs. that union → status "complete" | "missing"
  5. return { channelId, channelTitle, languages, totalVideos, videos[] }

Web UI / API → core.getVideoLocalizationDetail({ credentialRef, channelId, videoId })
  → original title/description (from synced snippet) + every existing remote locale's title/description

Web UI / API → core.exportLocalizations({ credentialRef, channelId, videoIds? })
  1. same read as above, optionally scoped to a videoIds subset (validated to belong to the channel)
  2. xlsxBuilder.buildWorkbook({ channel, videos })    — exceljs, two sheets, see §5.3
  3. return { filename, buffer, videoCount, rowCount }
```

No `authResolver`/OAuth scope check occurs inside this module (there is no YouTube call to authorize) — the API routes still require a valid NextAuth session before reaching the service, consistent with every other route handler.

### 5.3 XLSX workbook shape (`src/lib/localization/adapters/xlsx.ts`)

Two sheets, per `docs/PROJECT_SPEC.md` §15, built with `exceljs` (bold frozen header row, `autoFilter`, sensible column widths, wrapped description cells):

```text
Videos          — channel_id, channel_name, video_id, youtube_url, published_at,
                  default_language, original_title, original_description
                  (one row per exported video; video_id is canonical, never title)

Localizations   — video_id, language, language_name, title, description,
                  remote_title, remote_description, status ("Existing" | "Missing")
                  (one row per exported video × every language that exists anywhere
                  in the channel's synced data; title/description are left blank —
                  they are the future XLSX-import input columns, not populated here)
```

Export scope (`videoIds?`) covers all three cases from `docs/PROJECT_SPEC.md` §15 ("selected videos / all filtered videos / entire channel"): the Web UI computes the relevant id list client-side (selection checkboxes, or the currently-filtered table rows) and passes it as a query param; omitting it exports the entire synced channel.

### 5.4 Known limitation: no target-language configuration yet

The Localizations sheet only emits rows for languages that **already exist** somewhere in the channel's synced localizations — there is no concept yet of a channel's "configured target languages" (spec §11's language-chip picker). A channel with zero existing localizations exports an empty Localizations sheet. Introducing a target-language configuration step (so operators can generate blank rows inviting *new* translations, not just review existing ones) is deferred to the XLSX-import phase (`docs/PROJECT_SPEC.md` §63), where "language to add" becomes a meaningful input rather than a display-only computation.

---

## 6. Persistence

### 6.1 Schema (additive to the existing TubeMaster-derived tables)

```text
users     (unchanged)   — id, email, name, image, accessToken, refreshToken, tokenExpiry, oauthScope, selectedChannelId
rules     (unchanged)   — auto-playlisting match rules, unrelated to sync

channels  (new)         — id (channelId, PK), title, thumbnailUrl, uploadsPlaylistId,
                           connectedUserId, connectedAt, lastSyncedAt
videos    (new)         — id (videoId, PK), channelId (FK → channels.id), title, description,
                           publishedAt, privacyStatus, defaultLanguage, defaultAudioLanguage,
                           thumbnailsJson, localizationsJson, etag, lastSyncedAt
                           + index on channelId
```

`thumbnails` and `existingLocalizations` are stored as JSON text columns (`thumbnailsJson`/`localizationsJson`), parsed/serialized at the persistence boundary in `src/lib/db.ts` (`mapStoredVideo`/`upsertVideos`). This mirrors the existing codebase's preference for plain SQLite columns over a JSON-mode ORM feature, and keeps the schema readable directly in a SQLite browser.

`channels.id` is the canonical YouTube `channelId` (never a title) and is the primary key — a channel is a single global entity; `connectedUserId` records which local OAuth user last connected/synced it, for traceability only (not an ownership boundary, since this is a single-operator local-first tool per `docs/PROJECT_SPEC.md` §37).

### 5.2 Migration strategy decision (documented per this phase's explicit requirement)

**Decision: keep the existing boot-time idempotent schema pattern (`CREATE TABLE IF NOT EXISTS` / try-catch `ALTER TABLE ADD COLUMN` inside `initializeDatabase()` in `src/lib/db.ts`) for Phase 2. Do not introduce Drizzle Kit migrations yet.**

Reasoning:

1. **The Phase 2 schema change is purely additive** — two brand-new tables (`channels`, `videos`), zero changes to existing table shapes, zero data migrations, zero destructive operations. The existing pattern already handles this exact case correctly (it was used to add `selected_channel_id` and `oauth_scope` to `users` previously) and was re-verified working in this phase (`channels`/`videos` tables confirmed created on boot against a real SQLite file).
2. **`AGENTS.md`/`docs/PROJECT_SPEC.md` both require avoiding broad rewrites and explaining *why* before changing database architecture** (§3, Rule 5). Switching to Drizzle Kit migrations now — while `drizzle-kit` is an installed-but-unused devDependency — would be exactly the kind of architectural change the spec asks to justify in writing before doing, and there is no concrete need yet: no destructive schema change, no multi-environment migration ordering problem, no team-coordination requirement (single local SQLite file per operator).
3. **This is not a permanent decision.** `docs/UPSTREAM_ANALYSIS.md` §9 (risk #2) already flagged that the idempotent-ALTER pattern will become error-prone as more tables accumulate (`localizations`, `changesets`, `batches`, `audit`, `backups` are all still to come per the roadmap). The threshold for revisiting this is: **the first schema change that is not purely additive** (a column type change, a `NOT NULL` backfill, a data transformation, or a multi-step migration ordering requirement) — at that point, introduce Drizzle Kit migrations via a dedicated ADR (`docs/decisions/00X-database-migrations.md`, per `docs/PROJECT_SPEC.md` §45), not silently.

### 5.3 Persistence access (`src/lib/db.ts`)

New exported functions, following the existing file's flat function-per-operation style (not a repository class):

```text
upsertChannel(...)             — insert or update-on-conflict a channel row
markChannelSynced(id, at)      — update lastSyncedAt only
listStoredChannels()           — all connected/synced channels
getStoredChannel(id)           — single channel lookup
upsertVideos(entries, at)      — insert or update-on-conflict each video row
listStoredVideosByChannel(id)  — all videos for a channel, newest first
```

`src/lib/channel-sync/adapters/store.ts` wraps these as the `channelStore` dependency injected into `services.ts`, exactly mirroring how `write-context`'s `channelSelectionStore` wraps `getSelectedChannelId`/`setSelectedChannelId`.

---

## 7. API Routes (additive)

Following the existing `src/app/api/video-metadata/*` route-handler + shared `error-status.ts` + `parse-json-body.ts` pattern — no parallel API surface was introduced.

```text
GET  /api/channels                                       — list locally synced channels
POST /api/channels/sync                                  — trigger a sync ({ channelId? } body; omitted = the
                                                             authenticated account's own channel)
GET  /api/channels/[channelId]/videos                     — list synced videos + existing localization languages

GET  /api/channels/[channelId]/localizations              — localization overview table (Phase 3)
GET  /api/channels/[channelId]/localizations/[videoId]    — per-video localization detail (Phase 3)
GET  /api/channels/[channelId]/localizations/export       — XLSX download, optional ?videoIds=a,b,c (Phase 3)
```

All routes require an authenticated NextAuth session (`getServerSession`), matching every existing route handler, and reuse `getVideoMetadataErrorStatus` for `DomainError` → HTTP status mapping (the error codes are shared across domain modules via the common `DomainErrorCode` type). The export route returns raw XLSX bytes with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and a `Content-Disposition: attachment` header instead of JSON.

## 8. Web UI (additive)

Two tabs were added to the existing dashboard (`src/app/dashboard/page.tsx`), alongside **Manual** and **Rules**:

- **Sync** (Phase 2) — `src/components/channel-sync.tsx`: select a previously-synced channel or trigger a first sync, browse the resulting video list with thumbnail/title/publish date/privacy/default language, see existing localization languages as badges.
- **Localizations** (Phase 3) — `src/components/localization-manager.tsx`: channel picker, search + status filter (All/Missing/Complete), a table with one column per language that exists anywhere in the channel (✓/— per video), click-to-expand per-video detail (original metadata + every existing remote locale's title/description), and three export actions (selected rows / currently filtered rows / entire channel) that download the XLSX file client-side.

Both follow the existing component conventions (Tailwind dark theme, same button/card styling as `ManualMode`). No existing tab, route, or component was modified beyond adding the new tab entries and their conditional render branches.

## 9. What Phase 2 and Phase 3 deliberately do not add

Per each phase's explicit scope boundaries (also see `docs/PROJECT_SPEC.md` §58 non-goals):

- No localization **writes** anywhere in the codebase (no `videos.update` call in `channel-sync/` or `localization/`).
- No XLSX **import** (export only) — see `docs/PROJECT_SPEC.md` §63 for the deferred import/validate/change-set workflow.
- No AI generation.
- No change-set, backup, audit, or batch-execution infrastructure — none of Phase 2/3's operations are destructive or irreversible (they only read YouTube/the local cache and, for export, generate a local file), so none of that infrastructure is "strictly required" yet.
- No CLI or MCP sync/localization tools yet — only the Web UI and the underlying API routes exist so far; CLI/MCP parity for both `channel-sync` and `localization` is additive future work (see §10).
- No conflict detection between local video cache and remote state — not needed yet since there is no draft to protect (§4.5 above); still true after Phase 3, since Phase 3 introduces no draft/change-set state either.
- No configured target-language list for a channel (§5.4 above) — the Localizations sheet only reflects what already exists remotely.

## 10. Extension points confirmed by these phases

- **Localization writes (Phase 4+)**: will reuse `write-context.assertWriteChannel` (unchanged) and the `videos` table's `existingLocalizations`/`defaultLanguage` columns as the "before" state for `mergeLocalizations`/`buildSafeVideoUpdatePayload` (`docs/PROJECT_SPEC.md` §21). `localization/services.ts`'s `getVideoLocalizationDetail` already shapes the exact "before" view a diff/approval UI would need.
- **XLSX import (Phase 4+)**: the export workbook's column names (`video_id`, `language`, `title`, `description`) were chosen to be the exact columns a future import parser reads back — `video_id` is the only join key, per `docs/PROJECT_SPEC.md` §15/§16.
- **Change sets / drafts (Phase 4+)**: a new `changesets` table can reference `videos.id` directly; no change to `videos`' shape is anticipated.
- **CLI/MCP sync + localization parity (Phase 4+)**: `createChannelSyncCore()` and `createLocalizationCore()` are already interface-agnostic; adding `sync`/`localization` CLI namespaces and `channel_sync`/`channel_list`/`video_list`/`localization_list`/`localization_export` MCP tools is additive, following the exact registration pattern already used for `metadata`/`playlist` tools in `src/cli/video-metadata.ts` and `src/mcp/server.ts`.
