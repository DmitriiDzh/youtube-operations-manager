# ARCHITECTURE.md

Living architecture reference for this repository. For the product roadmap and safety rules, see `docs/PROJECT_SPEC.md`. For how to extend this architecture, see `docs/DEVELOPMENT_PLAYBOOK.md`. For the current risk register and release gates, see `docs/TECHNICAL_DEBT.md`. For significant architectural decisions and their rationale, see `docs/decisions/`.

This document is updated whenever a phase changes the architecture. Current as of **Phase 4 (XLSX import, draft state, change sets, diff/approval UI)**; Phase 4.5 added no new architecture, only this documentation-consistency pass and §12 below.

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

Every domain module under `src/lib/` follows the same four-file layering, introduced early in this project and preserved for every module added since:

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
| `localization/` (Phase 3) | Read model over synced videos' existing localizations, missing-language computation, XLSX export | **No — read-only** |
| `changesets/` **(new, Phase 4)** | XLSX import parsing/validation, field-level diff, persistent change sets, local approve/reject | **No YouTube write — local DB only** |
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

Steps 4–5 are the two YouTube-quota-relevant calls. Step 4 uses the **uploads-playlist enumeration strategy** (never `search.list`), matching `docs/PROJECT_SPEC.md` §9. Step 5 batches up to 50 video IDs per `videos.list` call — for a channel with, say, 420 videos, this is **9 API calls total for full metadata**, not 420. See `src/lib/youtube-read-gateway/data-api.ts` (the single read-side child module for the YouTube Data API v3, reached only through the `@/lib/youtube-read-gateway` barrel — `docs/decisions/0007-youtube-read-gateway.md`; this file was `src/lib/youtube.ts` before that refactor):

- `listUploadsPlaylistVideoIds(youtube, uploadsPlaylistId)` — paginated enumeration, dedupes video IDs.
- `getVideosMetadataContextBatch(youtube, videoIds)` — chunks `videoIds` into groups of ≤50 and issues one `videos.list` call per chunk.

Both are unit-tested directly against a mocked `youtube_v3.Youtube`-shaped client in `src/lib/youtube-read-gateway/data-api.test.ts` (not just indirectly through the service layer), specifically to verify the chunking math (120 ids → 3 calls of 50/50/20) independent of any service-level mocking.

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

A re-sync **replaces** each video's persisted remote-mirror fields (title, description, localizations, etc.) with the freshly fetched values — there is currently no draft or change-set concept for this phase to protect (per `docs/PROJECT_SPEC.md` §58, the localization draft/apply workflow is an explicit non-goal until Phase 4+). Once drafts exist, sync must be revisited to detect and flag conflicts (`docs/PROJECT_SPEC.md` §30) rather than silently overwriting — **this is a known, intentional limitation of Phase 2, still true after Phase 3** (which adds no draft state either), not an oversight; see §10 (Extension points) below.

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

## 6. Phase 4: XLSX Import, Draft State, Change Sets & Diff/Approval (`src/lib/changesets/`)

### 6.1 Purpose and scope

Turns the read-only Phase 3 localization view into a local preparation/approval workflow: import an edited XLSX export, validate it, persist it as a **Change Set** of field-level **Changes**, review a diff against the currently synchronized remote value, and locally approve/reject. **No YouTube write call exists anywhere in this module** — approval is purely a local database state transition. Matches `docs/PROJECT_SPEC.md` §61–64 (Fourth Agent Assignment) with the write pipeline itself explicitly deferred to Phase 5.

### 6.2 Why a new domain module instead of extending `localization/`

`localization/` is a pure read model (§5 above) with no persistence beyond what `channel-sync` already owns. Import/validation/diff/approval is a materially different bounded context — it owns its own persisted entities, its own lifecycle, and (per `docs/PROJECT_SPEC.md` §47) was explicitly suggested as a separate `changesets/` module. `changesets/` depends on `localization`'s sibling `channel-sync` persistence (`getStoredChannel`/`listStoredVideosByChannel`) for the "current remote" side of every comparison, and on `localization/adapters/xlsx.ts`'s workbook shape as its import format — but introduces no reverse dependency (channel-sync and localization remain unaware `changesets/` exists, preserving §4.5/§9's "no draft concept" statement as still true for those two modules specifically).

### 6.3 Data flow

```text
Web UI → POST .../localizations/import/preview  (multipart file, not persisted)
  1. requireChannel(channelId)                        — must already be synced (channel-sync)
  2. channelStore.listVideosByChannel(channelId)        — current remote snapshot
  3. parseAndValidateWorkbook({ buffer, channelId, syncedVideos })
       - structural checks: valid XLSX, required "Localizations" sheet + columns,
         file-size/row-count limits, Meta-sheet channel_id match (blocks entire import)
       - per row: video_id exists in this channel's synced data, language format,
         duplicate video_id+language, blank cell = no proposed change (§8 below)
       - per non-blank field: classifyFieldChange (ADD/MODIFY/UNCHANGED vs. *current*
         remote) + computeConflictStatus (workbook's remote_title/remote_description
         baseline vs. *current* remote — §6.6 below) + length validation
  4. summarizeParsedWorkbook(parsed) → { videosFound, localizationRows, validChanges,
     unchangedValues, invalidRows, conflicts }
  5. return summary + bounded row-error list (nothing written to the database)

Web UI → POST .../localizations/import  (multipart, same file re-submitted after preview)
  1. same parse+validate as above
  2. persist only rows that are an actual proposed edit (ADD/MODIFY) or invalid
     (unchanged-and-valid rows are counted in the summary but never stored — §6.5)
  3. changeSetStore.createChangeSetWithChanges(...)     — one SQLite transaction
  4. return the created ChangeSet + the same summary/errors

Web UI → GET .../change-sets/[changeSetId]  (also runs before every approve/reject/bulk action)
  1. loadRevalidated(): re-fetch current synced videos, recompute each change's
     conflictStatus against its baseline, persist any that changed, and invalidate
     approval if a change newly became conflicted (§6.7) — never a static/stale flag
  2. recompute + persist the change set's aggregate status (diff.ts:computeChangeSetStatus)
  3. apply status/language/videoId filters + pagination, return the page
```

There is deliberately no separate "confirm creation" endpoint that consumes a server-side cached parse result: the browser already holds the uploaded `File` after selection, so the UI simply re-submits the same file to `.../import` after the user reviews the `.../import/preview` summary — satisfying `docs/PROJECT_SPEC.md` §18's "preview before persist" flow without inventing an upload-token cache (no queues/temp storage introduced, per §25/§31).

### 6.4 Workbook compatibility (no schema-incompatible change)

Inspecting the actual Phase 3 export (`src/lib/localization/adapters/xlsx.ts`) found that the `Localizations` sheet **already contains `remote_title`/`remote_description` columns** (the live remote value at export time) alongside the blank `title`/`description` input columns — since the very first Phase 3 export, not something Phase 4 had to add. This means the "baseline for conflict detection" `docs/PROJECT_SPEC.md` §6 worried might be missing was already present. Phase 4 adds exactly one small, additive, backward-compatible piece: a third **`Meta`** worksheet (`schema_version`, `exported_at`, `channel_id`) written by `buildWorkbook()`. An older (pre-`Meta`-sheet) Phase 3 export is still importable — `readMetaSheet()` tolerates a missing sheet and returns `null`s — it only loses the channel-mismatch guard and the informational "exported at" timestamp, never conflict detection itself (that still works off `remote_title`/`remote_description`, present since day one).

### 6.5 What gets persisted as a `Change`

Only rows that represent an actual proposed edit are stored as `Change` rows — a field whose proposed value equals the current remote value (`changeType: "unchanged"`) is counted in the import summary but **not persisted**, keeping the table free of no-op rows. Invalid fields (e.g. a title over 100 characters) *are* persisted (with `validationStatus: "invalid"` and a `validationError` message) so they remain visible/actionable in the review UI rather than silently disappearing. A row that fails identity checks entirely (unknown `video_id`, malformed `language`, duplicate row) never becomes a `Change` — it is reported only in the row-error list.

### 6.6 Conflict detection and its documented limitation

A `Change`'s `baselineValue` is the workbook's `remote_title`/`remote_description` cell — the remote value **as it was when the workbook was exported**. Conflict detection compares that baseline against the **currently synchronized** remote value (`channel-sync`'s local mirror, refreshed by re-sync) — never a live YouTube call. This means: **Phase 4 conflict detection is only as fresh as the last channel sync.** If YouTube Studio changed a value *after* the last sync but the local mirror hasn't caught up, Phase 4 cannot see it and will not flag a conflict. `docs/PROJECT_SPEC.md` §14 requires this limitation to be documented rather than silently assumed away — a fresh remote-state check immediately before any actual write is explicitly deferred to Phase 5.

### 6.7 Draft preservation across re-sync + approval invalidation

`channel-sync`'s re-sync (`upsertVideos`) only ever touches the `videos` table — it has no awareness of `change_sets`/`changes` and never deletes or overwrites them, so a draft is preserved across re-sync by construction, not by special-case logic. What *does* need to happen after a re-sync is **revalidation**: `loadRevalidated()` (services.ts) runs on every change-set read and before every approve/reject/bulk action, recomputing each change's `conflictStatus` against the freshly synced remote value via `diff.ts:revalidateChangeAgainstCurrentRemote`. Critically, if a change was already `approved` and the remote value has since drifted (new conflict), that function resets it to `pending` and clears `approvedValue` — the concrete mechanism behind `docs/PROJECT_SPEC.md` §16's "an old approval must not authorize a different payload." Covered by `src/lib/changesets/services.test.ts`'s "re-sync draft preservation" test.

### 6.8 Change Set lifecycle

`ChangeSet.status` is derived (never hand-set) by `diff.ts:computeChangeSetStatus` from its changes' `validationStatus`/`conflictStatus`/`approvalStatus`, and persisted after every mutation:

```text
in_review          — default; also sticky whenever ANY change is invalid or conflicted,
                      even if every actionable change has been approved
approved           — every actionable (valid, non-conflicting) change is approved
partially_approved — a mix of approved and rejected actionable changes
rejected           — every actionable change is rejected
```

Deterministic and pure (`diff.test.ts`) — the same change list always yields the same status. Phase 5's future execution states (`APPLYING`/`SUCCESS`/`FAILED`/...) are a separate concern layered on top later, not conflated with this approval-lifecycle status.

### 6.9 Approval semantics

Approving a `Change` snapshots `approvedValue = proposedValue` and requires `validationStatus: "valid"` and `conflictStatus: "none"` (`DomainError("change_not_approvable")` otherwise — invalid/conflicted changes must be resolved, e.g. by re-syncing and re-importing, before they can be approved). Rejecting has no such guard — rejecting an invalid or conflicted change is always safe and always allowed. Bulk "approve all valid" only ever touches `pending` + valid + non-conflicting changes; it can never silently approve something broken. Approval is a **local database write only** — no code path in `changesets/` calls `googleapis`.

### 6.10 Schema (additive)

```text
change_sets (new)  — id (uuid, PK), channelId (FK → channels.id), source ("xlsx_import"),
                      status, importedFilename, schemaVersion, exportedAt, createdAt, updatedAt
changes     (new)  — id (uuid, PK), changeSetId (FK → change_sets.id), videoId, language,
                      field ("title"|"description"), baselineValue, proposedValue,
                      changeType, validationStatus, validationError, conflictStatus,
                      approvalStatus, approvedValue, createdAt, updatedAt
                      + index on changeSetId, index on videoId
```

Purely additive `CREATE TABLE IF NOT EXISTS` inside the same `initializeDatabase()` idempotent-boot pattern as Phase 2/3 (§6.13 below) — no changes to `users`/`channels`/`videos`. `createChangeSetWithChanges()` wraps the change-set insert plus all of its change rows in one `db.transaction(...)` so a change set is never left half-persisted. Verified booting cleanly against both an empty database file and the existing Phase 2/3 database file (`docs/PROJECT_SPEC.md` §23).

### 6.11 Persistence access (`src/lib/db.ts`, additive)

```text
createChangeSetWithChanges(input)                — transactional insert of a change set + its changes
listStoredChangeSetsByChannel(channelId)         — all change sets for a channel, newest first
getStoredChangeSet(changeSetId)
listStoredChangesByChangeSet(changeSetId)
updateStoredChangeSetStatus(changeSetId, status)
updateStoredChange(changeId, patch)              — conflictStatus/approvalStatus/approvedValue only
bulkUpdateStoredChanges(updates)                 — same patch shape, transactional
```

`src/lib/changesets/adapters/store.ts` wraps these, following the same store-adapter pattern as `channel-sync`/`localization`.

### 6.12 API Routes (additive)

```text
POST /api/channels/[channelId]/localizations/import/preview   — multipart file; parse+validate only, no persistence
POST /api/channels/[channelId]/localizations/import           — multipart file; creates a Change Set

GET  /api/channels/[channelId]/change-sets                                    — list change sets for a channel
GET  /api/channels/[channelId]/change-sets/[changeSetId]                      — detail (revalidates on every read);
                                                                                  ?status=&language=&videoId=&page=&pageSize=
POST /api/channels/[channelId]/change-sets/[changeSetId]/changes/[changeId]/approve
POST /api/channels/[channelId]/change-sets/[changeSetId]/changes/[changeId]/reject
POST /api/channels/[channelId]/change-sets/[changeSetId]/approve-all
POST /api/channels/[channelId]/change-sets/[changeSetId]/reject-all
```

Every route requires a NextAuth session and maps `DomainError` via the same shared `getVideoMetadataErrorStatus`, which gained one new code: `change_not_approvable` → 409 (§6.9). A `changeSetId` is always resolved together with its `channelId` (`requireChangeSet` in services.ts checks `changeSet.channelId === channelId`) so a change set cannot be read or mutated through a mismatched channel path — the channel-scoping equivalent of `docs/PROJECT_SPEC.md` §20's "must not create changes under the wrong channel," enforced here since there is no YouTube write to guard with `write-context` in this phase.

The two multipart import routes reject a request whose `Content-Length` header already exceeds `MAX_WORKBOOK_BYTES` (25MB) before calling `request.formData()`, in addition to `parseAndValidateWorkbook`'s own size/row-count checks that run after parsing. This is a **best-effort** guard, not a complete one: `request.formData()` in this runtime has no built-in body-size cap, so a request sent without a `Content-Length` header (e.g. chunked transfer) is still fully buffered into memory before the post-parse limit takes effect. A byte-counting streaming multipart reader would close this residually but was judged disproportionate for a local-first, single-operator tool where the only way to reach this endpoint at all is an authenticated NextAuth session on the operator's own machine; revisit if this application is ever exposed beyond localhost.

**Every channel-scoped read is now filtered to the caller's active channel** (`docs/decisions/0004-active-channel-read-scoping.md`, closing `docs/TECHNICAL_DEBT.md` RISK-02, 2026-09-20) — `channel-sync`'s `listChannels()`/`listSyncedVideos()`, and every changesets/batches/localization/ai-localization read endpoint across Web API, MCP, and CLI, reject or omit any `channelId` that isn't the session's currently active one (`users.selectedChannelId`, kept fresh from `GET /api/youtube/channel-info` and `channel-sync`'s implicit "sync my own channel" path — see `src/lib/channel-access`). This does **not** make the application multi-operator-safe in general (no per-user data separation, no auth roles) — it specifically closes "every locally-known channel is visible to any session," which was the concrete leak observed (a device that had synced several different Google accounts' channels over time showed all of them). `channels.connectedUserId` remains traceability-only, not an ownership boundary, per §7.1 below.

### 6.13 Web UI (additive)

`src/components/localization-manager.tsx` gained an "Import XLSX" panel (file picker → Preview → Create Change Set, with the returned summary/error report) and a change-set list; `src/components/change-set-review.tsx` (new) renders one change set's diff/approval UI — status/language/videoId filters, per-change Approve/Reject (disabled while invalid/conflicted), and bulk "Approve all valid"/"Reject all pending." Pagination (`pageSize=100` per request) keeps a large change set from rendering hundreds of descriptions at once (`docs/PROJECT_SPEC.md` §17/§25).

### 6.14 Deviations from a literal reading of `docs/PROJECT_SPEC.md` §11 (Fourth Agent Assignment)

- **No `credentialRef`/OAuth involvement in `changesets/`**: like `localization/`, this module makes no YouTube API calls, so there is nothing to authorize beyond the existing NextAuth session check every route already performs. `credentialRef` was deliberately not threaded through (it would be accepted-but-unused, as it effectively already is in `localization/`'s schemas).
- **Deletion remained fully deferred through Phase 4** (not just soft-deferred): no explicit "propose deletion of a localization" affordance existed at all, per `docs/PROJECT_SPEC.md` §16's original "deletion must be an explicit operation" language (this file previously mis-cited that guidance as "§8," corrected here — §8 is "Channel and Account Model," unrelated). **Superseded 2026-09-20:** the project owner explicitly authorized building a real deletion capability (Studio-parity Languages redesign, `docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md` §7.2), and `docs/PROJECT_SPEC.md` §16 was updated the same day with the permanent constraint that decision came with (multi-step confirmation, a local recovery window before any deletion is treated as final, restore-as-a-full-write). **Backend proposal path implemented 2026-09-21 — see §6.15.** UI and the restore mechanism remain planned.
- **A pure `applyProposedValueUpdate`-style function for manual edits was not added**: no Phase 4 interface lets a human edit a `proposedValue` directly (values only ever come from the imported XLSX). The one real in-scope trigger for "approval must be invalidated because what it approved is no longer valid" — a re-sync revealing the remote changed — **is** implemented and tested (§6.7/§6.9). A generic "edit an approved proposal directly" pathway is left for a future `MANUAL_EDIT` source, which the `ChangeSetSource` type already reserves space for.

### 6.15 Localization deletion — backend proposal path (2026-09-21, `docs/PROJECT_SPEC.md` §16)

`ChangeType` gained a fourth value, `"delete"`, and `ChangeSetSource` gained `"deletion"`. `changesets.proposeLocalizationDeletion({channelId, videoId, language})` is the only entrypoint that creates a `"delete"`-typed `Change`: it looks up the video's currently-synced state, refuses (`DomainError("deletion_targets_default_language")`) if `language` equals the video's own `defaultLanguage`, refuses (`not_found`) if there is no existing localization for that language, and otherwise persists a two-`Change` (title + description) Change Set through the exact same `persistChangeSet` path (and therefore the exact same review/approve/reject/conflict-revalidation machinery, §6.6-§6.9) every other Change Set already uses — a deletion proposal is reviewed and approved like any other change, never applied as a side effect of proposing it.

The `defaultLanguage` refusal is the safety-critical part: that language's title/description live on the video's `snippet`, never in a `localizations` map entry, so a `"delete"` change reaching `src/lib/batches/merge.ts:buildSafeLocalizationsPayload` for it would (absent a guard) fall into the existing default-language branch and overwrite the video's real title/description with an empty string — the exact opposite of "remove a localization." `proposeLocalizationDeletion` is the primary guard (refuses before any `Change` is even created); `buildSafeLocalizationsPayload` carries the identical check as defense-in-depth and throws (fails closed, converted to a `FAILED` ledger outcome by its one call site in `src/lib/batches/services.ts`) if a `"delete"` change for the default language ever reaches it regardless.

Merge semantics for an approved deletion: `buildSafeLocalizationsPayload` collects every `"delete"`-typed change's `language` into a `Set` while processing the batch's other changes normally, then deletes each collected language from the final `localizations` object **after** the main loop — so a `"delete"` always wins over a same-locale `"modify"` in the same approved set, independent of which one appears first in the change list (tested both orders, `src/lib/batches/merge.test.ts`).

**Deliberately out of scope for this slice** (advisor-reviewed before implementation): no UI triggers a deletion proposal yet (`change-set-review.tsx`/`languages-manager.tsx` only got a one-line source-label fix so a `"deletion"` Change Set doesn't mis-render as "XLSX import" if one is ever created some other way), and no restore mechanism exists — §16's 30-day local recovery window is a UI/data-retention feature that has no testable effect while `assertLiveWritesAuthorized()` (§2.9a) still blocks every real YouTube write unconditionally; building it now would be exercised only against a payload that can never actually leave this database. Both are planned for a later, separately-assigned slice.

---

## 7. Persistence (Phase 2/3)

### 7.1 Schema (additive to the pre-existing baseline tables)

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

`channels.id` is the canonical YouTube `channelId` (never a title) and is the primary key — a channel is a single global entity; `connectedUserId` records which local OAuth user last connected/synced it, for traceability only, not an ownership boundary (`docs/PROJECT_SPEC.md` §37 sets the local-first/desktop deployment target this reflects, though it does not itself use the phrase "single operator" — a citation this document previously stated more strongly than the source; the actual read-scoping enforcement is `selectedChannelId`/`docs/decisions/0004-active-channel-read-scoping.md`, not `connectedUserId`).

### 7.2 Migration strategy decision (documented per this phase's explicit requirement)

**Decision: keep the existing boot-time idempotent schema pattern (`CREATE TABLE IF NOT EXISTS` / try-catch `ALTER TABLE ADD COLUMN` inside `initializeDatabase()` in `src/lib/db.ts`) for Phase 2. Do not introduce Drizzle Kit migrations yet.**

Reasoning:

1. **The Phase 2 schema change is purely additive** — two brand-new tables (`channels`, `videos`), zero changes to existing table shapes, zero data migrations, zero destructive operations. The existing pattern already handles this exact case correctly (it was used to add `selected_channel_id` and `oauth_scope` to `users` previously) and was re-verified working in this phase (`channels`/`videos` tables confirmed created on boot against a real SQLite file).
2. **`AGENTS.md`/`docs/PROJECT_SPEC.md` both require avoiding broad rewrites and explaining *why* before changing database architecture** (§3, Rule 5). Switching to Drizzle Kit migrations now — while `drizzle-kit` is an installed-but-unused devDependency — would be exactly the kind of architectural change the spec asks to justify in writing before doing, and there is no concrete need yet: no destructive schema change, no multi-environment migration ordering problem, no team-coordination requirement (single local SQLite file per operator).
3. **This is not a permanent decision.** The project's original architecture review already flagged that the idempotent-ALTER pattern will become error-prone as more tables accumulate. Phase 4 added two more tables (`change_sets`, `changes`, §6.10) purely additively, confirming the decision still holds; `batches`/`audit`/`backups` remain future additions per the roadmap. The threshold for revisiting this is unchanged: **the first schema change that is not purely additive** (a column type change, a `NOT NULL` backfill, a data transformation, or a multi-step migration ordering requirement) — at that point, introduce Drizzle Kit migrations via a dedicated ADR (`docs/decisions/00X-database-migrations.md`, per `docs/PROJECT_SPEC.md` §45), not silently.

### 7.3 Persistence access (`src/lib/db.ts`)

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

## 8. API Routes (Phase 2/3, additive)

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

## 9. Web UI (Phase 2/3, additive)

Two tabs were added to the existing dashboard (`src/app/dashboard/page.tsx`), alongside **Manual** and **Rules** (both removed 2026-09-20, see note below):

- **Content** (Phase 2; restyled 2026-09-20, `docs/roadmap/plans/STUDIO_PARITY_PLAN.md` Slice S2, formerly named "Sync") — `src/components/content-manager.tsx`: a Studio-shaped video table (Video/Access/Date/Views/Comments columns, search + privacy filter, client-side column sorting via `src/components/content-sort.ts` — header click toggles asc/desc with a ▲/▼ indicator, default Publish date newest-first, missing values always last — pagination) for the single active channel (no channel picker — `docs/decisions/0004-active-channel-read-scoping.md`), with a staleness-gated (~20 min) automatic re-sync on tab activation and a manual "Sync now" for an explicit forced refresh (`docs/roadmap/plans/TAB_REFRESH_AND_CHANNEL_UI_PLAN.md` §4). Existing localization languages still shown as badges under each title — a capability this app has that Studio's own Content page doesn't, kept rather than dropped for parity's sake.
- **Languages** (Phase 3, extended in Phase 4; merged with AI Localization 2026-09-20, redesigned again 2026-09-21, `docs/roadmap/plans/LANGUAGES_TAB_MERGE_PLAN.md` and `LANGUAGES_UX_REDESIGN_PLAN.md`) — `src/components/languages-manager.tsx`: one table is the primary surface (Video/Published/one ✓-or-— column per language actually present in the channel/Last modified, sortable by any header). One shared row-selection set drives both bulk AI generation and XLSX export; checking ≥1 row opens a contextual bar ("Generate with AI ▾"/"Export to XLSX"). Clicking a video opens it in the shared `video-detail-modal.tsx` popup (§2.9e in `docs/SYSTEM_MAP.md` — not a row expansion, since 2026-09-21) showing the original title/description, every existing locale, and an inline "Generate with AI for this video" mini-form/review step feeding the same Change-Set-creation path as the bulk flow. A small "+N" button under each language header bulk-selects every video missing it. XLSX import/export remains a secondary, collapsed-by-default section. A change-set queue below the table is filtered by three sub-tabs ("Все"/"В процессе"/"Одобрено") mapped onto `ChangeSet.status`, not onto any per-video state Studio's own UI assumes but this app's approval model doesn't have. "Одобрено" never implies a real YouTube write happened (Phase 5's write barrier is unaffected). See `docs/SYSTEM_MAP.md` §2.9/§2.9b/§2.9e for the full, current detail — this paragraph is kept intentionally brief and should be treated as a pointer, not the source of truth, for exactly which UI slice shipped when.

Both follow the existing component conventions (Tailwind dark theme, same button/card styling used throughout the dashboard). No existing tab, route, or component was modified beyond adding the new tab entries, their conditional render branches, and (for the 2026-09-20 merge) the `LocalizationOverviewRow.lastSyncedAt` field and `ChangeSetReview`'s optional callback described above.

**Removed, 2026-09-20 (project owner: "давай удалим их, т.к. пока не вижу им применения"):** the **Manual** tab (`src/components/manual-mode.tsx`, deleted) and the **Rules** tab (auto-playlisting: `src/components/{rule-form,rule-list,run-button}.tsx`, `src/app/api/{rules,run}/route.ts`, all deleted) -- both inherited from the project's original pre-rewrite baseline (Phase 0/1), unrelated to this project's own localization/Change-Set/Batch feature set. `src/lib/playlist-management/` and its Web API routes (`/api/youtube/{videos,playlists,create-playlist,add-to-playlist,remove-from-playlist}`) were deliberately **kept** -- they are the same domain module the MCP `playlist_*` tools and CLI `playlist` namespace already depend on (`docs/SYSTEM_MAP.md` §2.12/§2.13), a programmatic surface independent of whether a Web UI tab exists for it (`AGENTS.md` §B's dev/ops split -- a future operations agent can still manage playlists via MCP/API with no Manual tab present). The `rules` database table's own `CREATE TABLE IF NOT EXISTS` statement was deliberately left in `src/lib/db.ts`'s frozen baseline rather than replaced with a `DROP TABLE` migration -- see the comment immediately above it for why (a subtractive schema change needs its own ADR per `docs/decisions/0001-additive-idempotent-schema-strategy.md`, not needed here since nothing reads/writes that table anymore).

## 10. What remains deliberately unimplemented after Phase 4

Per each phase's explicit scope boundaries (also see `docs/PROJECT_SPEC.md` §58 non-goals):

- **No YouTube localization writes anywhere in the codebase** — no `videos.update` call in `channel-sync/`, `localization/`, or `changesets/`. Approving a change is a local database state transition only (§6.9). This is the single most important invariant Phase 5 must preserve until its write pipeline is proven safe.
- No AI generation. **Update, Phase 6 Slice 1 (2026-09-19):** a first AI Localization vertical slice now exists (`src/lib/ai-localization/`, `docs/SYSTEM_MAP.md` §2.9b) — a deterministic mock `LocalizationProvider` only, generating proposals that flow into the exact same, unmodified Phase 4 Change Set/approval pipeline. No real, paid AI provider is implemented or selected; that remains a separate, explicit future decision (`docs/PROJECT_SPEC.md` §32). **Update, 2026-09-20:** the domain module and this scope boundary are unchanged; only its UI entry point moved, from a standalone "AI Localization" tab into the merged "Languages" tab as the primary action (§9 above).
- No backup/audit/batch-execution infrastructure for *remote writes* — Phase 4 introduced `change_sets`/`changes` (local, reversible, non-destructive persistence) but nothing that would back a YouTube write batch (immutable pre-write backup, per-item execution ledger, audit log) — those remain Phase 5 scope (`docs/PROJECT_SPEC.md` §64).
- No CLI or MCP tools for sync, localization, import, or change-set review yet — only the Web UI and the underlying API routes exist; CLI/MCP parity is additive future work (see §11). `docs/PROJECT_SPEC.md` §21 explicitly said not to implement this in Phase 4 unless essential, and it was not essential here.
- No configured target-language list for a channel (§5.4 above) — the Localizations sheet only reflects what already exists remotely; still true after Phase 4 (import validates against arbitrary language codes, it does not introduce a per-channel target-language configuration).
- No deletion proposal model (§6.14) — deferred per `docs/PROJECT_SPEC.md` §16's original stated preference through Phase 4; superseded 2026-09-20, see §6.14's updated note.
- **A fresh, immediately-pre-write remote-state check does not exist** — Phase 4's conflict detection is bounded by the last channel sync (§6.6); Phase 5 must add a live check right before any actual `videos.update` call.

## 11. Extension points confirmed by these phases

- **Localization writes (Phase 5)**: will reuse `write-context.assertWriteChannel` (unchanged) and a `changesets`-approved `Change`'s `approvedValue` as the payload source, merged against the *freshly re-fetched* remote localizations via `mergeLocalizations`/`buildSafeVideoUpdatePayload` (`docs/PROJECT_SPEC.md` §21) — Phase 4's `Change.approvalStatus === "approved"` rows are exactly the input Phase 5's batch executor should consume.
- **Batch execution / ledger / audit (Phase 5)**: `changesets/services.ts`'s `approveAllValid`/`getChangeSet` already return the "what should be applied" set; Phase 5 adds the write-time ledger (`PENDING`/`APPLYING`/`SUCCESS`/`FAILED`/`CONFLICT` per change) as a new concern layered on top of, not replacing, `Change.approvalStatus`.
- **CLI/MCP sync + localization + changesets parity (Phase 5+)**: `createChannelSyncCore()`, `createLocalizationCore()`, and now `createChangeSetCore()` are all interface-agnostic; adding CLI namespaces and MCP tools (`changeset_list`, `changeset_get`, `changeset_approve`, per `docs/PROJECT_SPEC.md` §49) is additive, following the exact registration pattern already used for `metadata`/`playlist` tools.
- **AI Localization real-provider integration (Phase 6+)**: `src/lib/ai-localization/provider-registry.ts`'s `resolveLocalizationProvider` is the single point where a real `LocalizationProvider` (OpenAI/Anthropic/DeepL/etc.) would be added, once selected and explicitly authorized — no other file in this module needs to change, since `services.ts` only depends on the `LocalizationProvider` interface, never on the mock's identity.
- **Channel Editorial Profiles (Phase 6, 2026-09-19)**: `src/lib/db.ts`'s `channelEditorialProfiles` (one row per channel, versioned) and `aiLocalizationGenerationProvenance` (immutable, one row per Change Set created from a generation that echoed back its provenance) are purely additive tables owned entirely by `src/lib/ai-localization/` — no other domain module reads them. `mergeEditorialContext` (`services.ts`) is the single place the per-field profile/per-request combination rule is implemented; a future real provider or a future richer profile shape both extend from this one seam.
- **Provider-Agnostic AI Connections (Phase 6, 2026-09-19)**: `src/lib/ai-connections/` sits between `src/lib/ai-localization/` and any real model endpoint. `src/lib/ai-localization/services.ts` only gained one optional dependency (`resolveConnectionProvider(connectionId): Promise<LocalizationProvider>`) and one optional input field (`connectionId`) — it still only ever depends on the `LocalizationProvider` interface it always depended on, never on connections/adapters/credentials directly, which is what lets a future second real protocol adapter (e.g. an Anthropic-native one) be added by adding one file to `src/lib/ai-connections/adapters/` and one entry to `adapters/registry.ts`, with zero changes to `ai-localization`. Credential encryption (`crypto.ts`, AES-256-GCM) and endpoint SSRF validation (`endpoint-security.ts`) are self-contained, dependency-free (Node's built-in `crypto`/`dns`/`net` only) utilities with no coupling to any other domain module. See `docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md` §2 for the credential-storage architectural decision (encrypted-at-rest chosen over OS-keychain) and `docs/TECHNICAL_DEBT.md` RISK-14/15 for the two residual, documented limitations (DNS-rebinding TOCTOU; no key-rotation tooling).
- **MCP/CLI tools for AI Localization generate + create-Change-Set (BL-075/BL-078, 2026-09-23)**: research done ahead of this slice (owner request, "заменить Excel на JSON/MCP-систему для локализации, т.к. перевод делать должен агент, а не человек") found that XLSX was never actually the agent's authoring interface -- it is a separate, optional path for a human editing a spreadsheet by hand. The "Generate with AI" workflow (`generateProposals` -> human review -> `createChangeSetFromGeneration`) already bypassed XLSX entirely, reusing the exact same Change Set persistence/approval/write pipeline XLSX-imported changes go through. The actual, narrower gap: no MCP/CLI tool could reach either of those two service functions -- an external agent could only create a Change Set via the existing `changeset_create_from_import` tool, which requires uploading XLSX bytes. `ai_localization_generate`/`ai_localization_create_change_set` (MCP) and `ai-localization generate`/`ai-localization create-change-set` (CLI) close exactly that gap: both call the identical, already-tested `generateProposals`/`createChangeSetFromGeneration` functions the Web UI's own `POST .../ai-localization/{generate,change-sets}` routes already call, with **zero new validation, persistence, or approval logic**. `generateProposals` persists nothing (ungated, like `localization_import_preview`); `createChangeSetFromGeneration` persists a new Change Set (gated by the same device-availability check as `changeset_create_from_import`) but the resulting Change Set and every Change on it always start `pending` -- there is no code path anywhere, old or new, that can mark an AI-authored proposal already-approved (AGENTS.md §G, "AI may propose, human approves" is untouched). `getEditorialProfile`/`saveEditorialProfile`/`getGenerationProvenance` and any approve/reject/apply path were explicitly left out of this slice's scope. XLSX import/export were not touched, deprecated, or hidden -- they remain exactly as they were, as a human-editing option alongside AI generation, per this backlog item's own recorded open question (not yet resolved, and not blocking this slice).

---

## 12. Known limitations — explicit checkpoint (Phase 4.5)

Consolidated here so no reader has to infer these from scattered footnotes. Full detail and remediation gates for each live in `docs/TECHNICAL_DEBT.md`.

1. **Approval does not mean applied to YouTube.** `Change.approvalStatus === "approved"` is a local SQLite state only (§6.9 above). No code path in `src/lib/changesets/` calls `googleapis`.
2. **Phase 4 detects conflicts against the last synchronized SQLite snapshot, not live YouTube state** (§6.6 above; this remains true for the Phase 4 `changesets/` module specifically). A fresh remote-state check immediately before any write is mandatory for Phase 5 (`docs/TECHNICAL_DEBT.md` RISK-03) — **update, 2026-09-17/18:** implemented for the Phase 5 batch pipeline's preparation and send-time re-check (Slices 2-4, `docs/SYSTEM_MAP.md` §2.9a); RISK-03 stays `OPEN` in `docs/TECHNICAL_DEBT.md` because no real write can be issued yet to prove the end-to-end path.
3. **The application currently follows a single-operator model; RISK-02 was narrowed, not removed, by the 2026-09-20 fix.** Every channel-scoped read is now filtered to the caller's active channel (§6.12 above, `docs/decisions/0004-active-channel-read-scoping.md`), closing the specific leak of "any session sees every locally-known channel." There is still no per-user authentication/role model, no data separation between two people sharing one active-channel identity, and no CSRF protection — this remains a single-trusted-operator tool, not a general multi-tenant one (`docs/TECHNICAL_DEBT.md` RISK-02's Gate D items beyond the closed one).
4. **Change Set CLI/MCP interfaces are not yet implemented.** Phase 4's full workflow (import, diff, approve/reject) exists only through the Web UI and its API routes (`docs/TECHNICAL_DEBT.md` RISK-04). The future operations agent cannot use this workflow until MCP tools exist for it.
5. **Browser verification with a real authenticated session remains incomplete unless independently verified.** Phase 4's acceptance review ran the full domain-service pipeline against a real local database and a real XLSX export/import round trip, and 226 automated tests pass — but no session has performed a real Google OAuth sign-in through an actual browser and exercised the dashboard UI end to end (`docs/TECHNICAL_DEBT.md` RISK-05). Do not treat automated test coverage as equivalent to that verification.
6. **Two critical npm audit findings — update, 2026-09-18: patched** (`next`→16.3.5, `next-auth`→4.24.15; see `docs/TECHNICAL_DEBT.md` RISK-06, which still tracks 20 remaining, non-critical, mostly dev-only/unused-code-path advisories).

None of these are Phase 4.5 defects — they are pre-existing, now-consolidated facts about the current state of the system, gated for resolution per `docs/TECHNICAL_DEBT.md`'s gate classifications and the release-readiness checkpoints (Gates A–D) referenced there.

---

## 13. Pre-Release: Cross-Platform Persistence & Device Handoff (Variant A)

**Not a numbered product phase** — an explicit, separately-assigned pre-release task ("Pre-Release
— Cross-Platform Persistence & Syncthing Handoff"), distinct from and not authorizing Phase 7.
Full acceptance contract: `docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md`. Architectural
decision: `docs/decisions/0002-additive-schema-versioning.md`.

### 13.1 Purpose and scope

Makes the application safe to run alternately on Windows and macOS, with Syncthing as an
external file-transport only (never a database), under a strict single-active-device model
(Variant A — no simultaneous multi-device editing, no automatic database merging). Since
2026-10-01 the handoff itself is scheduled automatically (§23, ADR 0012), but it is still one writer
at a time and Syncthing is still the only transport. Four new leaf/near-leaf modules plus one small domain-adjacent module:

```text
src/lib/platform-paths/    — pure resolveAppPaths(platform, env, homedir); zero I/O
src/lib/bootstrap-config/  — device-local bootstrap-config.json (deviceId, syncthingRootPath)
src/lib/schema-versioning/ — schema_meta + reject-newer-before-mutation + ordered migrations
src/lib/db-backup/         — copyDatabaseConsistently() over VACUUM INTO (shared utility)
src/lib/operation-lock/    — app_operation_locks: real SQLite-level device-local exclusivity
src/lib/snapshot/          — scrub-then-checksum export/import pipeline, explicit table allowlist
src/lib/device-handoff/    — orchestration: exportHandoff/importHandoff/recovery-mode gate
```

`src/lib/db.ts` itself changed in three ways: its client now opens at
`getProductionAppPaths().dbPath` instead of `<cwd>/data/playlist-manager.db`; a one-time,
non-destructive migration copies a legacy database into the new location on first boot only;
`initializeDatabaseSchema` gained the version-check-first ordering described in §13.2.

### 13.2 Schema versioning ordering (docs/decisions/0002-*.md)

```text
initializeDatabaseSchema(client):
  1. PRAGMA busy_timeout / journal_mode = WAL           (non-schema-mutating)
  2. assertSupportedSchemaVersion(client, CURRENT)      (read-only; throws before any mutation
                                                          if the DB reports a newer version)
  3. existing additive baseline block, unchanged         (schema version 1, retroactively)
  4. runSchemaMigrations(...)                            (ordered, each stamps schema_meta only
                                                          on its own success)
```

A database reporting a version newer than `SCHEMA_CURRENT_VERSION` is rejected before step 3
ever runs — proven, not merely asserted, by a test that snapshots `sqlite_master` before and
after a rejected attempt and asserts byte-for-byte identity (`src/lib/db.test.ts`,
`src/lib/schema-versioning/services.test.ts`).

### 13.3 Snapshot format and the transfer allowlist

A published snapshot is a directory (`<snapshotId>/manifest.json` + `data.db` + implicit
per-file checksum inside the manifest) written first to a `.staging-<uuid>` directory and only
made visible under its final name via an atomic rename, after `manifest.json`'s `complete: true`
is the last thing written. `data.db` is produced by `VACUUM INTO` (a transactionally-consistent
snapshot, sidestepping the WAL/SHM-file problem entirely) and then scrubbed via an **explicit
transfer allowlist** (`SNAPSHOT_TRANSFERRED_TABLES`, `src/lib/snapshot/contracts.ts`) — any table
not on that list is dropped and the file `VACUUM`d again, fail-safe by construction: a future new
table is excluded by default unless a reviewer deliberately adds it to the allowlist. `users` and
`ai_connection_credentials` are never on it.

### 13.4 Import: per-table merge, not a whole-file swap

Import never replaces the live database file. It ATTACHes a migrated, verified, private working
copy of the snapshot's `data.db` to the live connection and, in one transaction, fully replaces
every table on `SNAPSHOT_REPLACE_ON_IMPORT_TABLES` — as of M6 (2026-09-23,
`docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`), the four Category D
write-pipeline tables (`batches`, `batch_ledger_rows`, `batch_attempts`, `audit_events`), **plus, as
of Phase 9 slice 9H part A (2026-09-27), all 12 Phase 9 market-intelligence tables** (`research_
channels`, `research_evidence`, `market_channel_snapshots`, `market_video_snapshots`, `market_
intelligence_collection_runs`, `market_discovery_candidates`, `market_discovery_runs`, `market_
topics`, `market_topic_assignments`, `market_trend_candidates`, `market_trend_evidence`, `market_
research_requests`) — closing RISK-52's market-intelligence portion per the owner's own 2026-09-26
decision (`docs/roadmap/plans/PHASE_9_PLAN.md` §12 point 5), which had been recorded as resolved
but never actually implemented until this fix. `SNAPSHOT_TRANSFERRED_TABLES` (the snapshot *file's*
own contents, §13.3) additionally includes
`schema_meta` — never touched by this replace loop, only read by `migrateStagedCopy` to migrate
the *staged* copy before merging. Everything this mechanism used to also carry, beyond today's
four, has since moved away by one of three routes: `channels`/`videos` to an independent
per-device resync from the real YouTube API (§2 Category A of the migration plan — there is no
local-only write path for either, so nothing to transfer); `rules` dropped outright, not resynced
anywhere, since its own feature (UI/API/Drizzle definition) was already removed 2026-09-20 and
there is nothing left to carry; and `change_sets`/`changes`/`channel_editorial_profiles`/
`ai_localization_generation_provenance`/`ai_connections` now propagate continuously via
`src/lib/sync-gateway/` instead — see §13.5 below. `ai_connections`'
own upsert-by-id special case (`INSERT OR REPLACE ... SELECT`, kept because `INSERT ... SELECT ...
ON CONFLICT DO UPDATE` was found unsupported by this `@libsql/client` build's SQLite) was removed
along with it; every remaining transferred table now goes through the same plain replace path.
`users` and `ai_connection_credentials` are never referenced by this code path at all — there is
no "exclude" branch to bypass, because no code path here can reach them structurally. `users.id`
was confirmed, by reading `src/lib/auth.ts`'s `session()` callback and `src/lib/db.ts`'s
`upsertUserOAuthOnSignIn`, to be the Google OAuth `sub` claim — a stable, provider-issued
identity, not a locally-generated artifact — which is why no identifier remapping is ever needed
for `channels.connectedUserId`/`rules.userId` across devices.

### 13.5 Why this mechanism still exists after `sync-gateway`: a narrow, explicit ownership handoff

Every table this mechanism used to carry that COULD move to `sync-gateway`'s continuous CRDT
propagation has (`docs/SYSTEM_MAP.md` §2.9h/§2.9m); this mechanism's remaining four tables physically cannot
(`docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`: no CRDT equivalent for SQL
compare-and-set/UNIQUE-constraint concurrency guards or for `AUTOINCREMENT`-derived audit
ordering). Rather than deleting cross-device continuity for them outright, the owner chose (after
a web-research pass on 2026-09-23 confirming this shape is the industry-standard answer, not an
ad-hoc compromise — SQLite single-writer replication tools like LiteFS/Litestream use exactly this
"explicit, atomic primary handoff, never a live merge" pattern for primary failover, as do
distributed job schedulers for lease-based worker handoff) to keep this mechanism alive, scoped
down to exactly these four tables: an explicit, human-triggered, atomic whole-copy transfer of
write-pipeline ownership between devices, never a background/automatic sync.

### 13.6 Restricted recovery mode is computed, never cached

If the imported (migrated, merged) data contains any `batch_ledger_rows` row whose status is
`APPLYING` or `UNKNOWN` (a real YouTube write may have been sent with an uncertain outcome), the
device activates the import but every subsequent mutating action — local-state or
YouTube-write — is refused. This is implemented as a **live, uncached recomputation** on every
check (`isDeviceInRecoveryMode`/`assertDeviceAvailableForMutation`, re-querying
`batch_ledger_rows` each time), specifically so that no stored flag exists anywhere that an
operator action could accidentally or deliberately flip. The one operator action available
(`acknowledgeRecoveryDiagnostics`) writes only to a separate, append-only
`recovery_acknowledgements` table and never touches `batch_ledger_rows` — proven by a dedicated
test (`docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md` AC-HANDOFF-05) that asserts the
row is byte-identical before/after and the gate is still engaged immediately after. This task
builds no new recovery/reconciliation algorithm — the gate only lifts when Phase 5's existing,
unmodified mechanism (RISK-09 §0.F) resolves the underlying rows to a terminal state, which
currently has no in-app trigger (`docs/TECHNICAL_DEBT.md` RISK-16, tracked, not fixed here).

### 13.7 One gate, three call sites

`src/lib/device-handoff/services.ts`'s `assertDeviceAvailableForMutation` (operation-lock check,
then recovery-mode check) is the single implementation; it is called from three independent
choke points, not reimplemented at each: `src/proxy.ts` (Next.js 16's renamed `middleware.ts` —
confirmed via `node_modules/next/dist/docs/` to default to the Node.js runtime, which is what
makes querying the local libSQL database directly from it possible) for every mutating `/api/**`
request; `src/cli/video-metadata.ts`'s `runCliCommand`, for every CLI command outside an explicit
read-only allowlist; `src/mcp/server.ts`'s `createMcpToolHandlers`, wrapping every tool classified
as a local- or remote-mutation per `docs/DEVELOPMENT_PLAYBOOK.md` §6.7. `app_operation_locks`
itself is a real SQLite-level exclusivity mechanism (the `INSERT` against a fixed row id is what
actually enforces it, across any connection/process to the same file) — the three choke points
give the broader "no new work starts" product behavior for the whole export/import window, not
just the instant of the file copy.

### 13.8 Known limitations

- No macOS runtime validation — path-resolution logic is unit-tested for both platforms via
  injection; only Windows has actually been run (`docs/TECHNICAL_DEBT.md` RISK-17).
- No in-app way to leave restricted recovery mode yet — depends on RISK-04's CLI/MCP Batch
  tooling, which does not exist (RISK-16).
- No installer/auto-updater for a standalone `published/<version>/` release copy (no `.git`);
  release layout is documented (`docs/RELEASE_LAYOUT.md`) but not automated there, per that
  task's own explicit scope boundary. `scripts/{macos,windows}/start.{sh,bat}` never touch git,
  the network, or the working tree at all (an earlier version did run `git pull --ff-only`
  itself; removed 2026-09-21 at the project owner's explicit request — keeping a git checkout
  current is the operator's own responsibility now). They do detect a stale `.next` build when
  run from a git checkout, by comparing the checked-out commit against a marker file recording
  which commit was last built, and rebuild automatically — this is what makes the operator's own
  `git pull` actually take effect on the next launch, rather than silently continuing to serve a
  build from before that pull (`docs/FIRST_LOCAL_TEST_BUILD.md` §3/§4).

## 14. Phase 8 (Intelligence Foundation) — foundation + 4 follow-up slices, all merged

### 14.1 Status

Assigned 2026-09-22 (Telegram, project owner: "Приступить к полной реализации фазы 8"). The
original foundation work landed on `feature/phase-8-intelligence-foundation`, merged into `dev` in
`6f75ccf` (owner approval per `AGENTS.md` §K.2) — see `docs/ROADMAP_STATUS.md`'s BL-055..BL-059
rows for the full merge history; this subsection's own wording below predates that merge and is
kept for its historical detail, not as a claim about current branch state. `docs/roadmap/plans/PHASE_8_PLAN.md`
§6 slice 2
(the additive `video_metrics_daily` table + tests) is implemented and reviewed. The owner answered
§8's two required decisions on 2026-09-22 (Telegram msg 356, recorded verbatim in the plan's §10):
OAuth scope approved, and metric scope widened to every metric `yt-analytics.readonly` covers (not
`views` alone) — see §14.2 below for the schema consequence.

**All four slices are now implemented:** slice 1 (OAuth scope, BL-056) — `YOUTUBE_ANALYTICS_READ_SCOPE`
added to `src/lib/auth.ts`'s `YOUTUBE_SCOPES`, no separate re-consent mechanism needed (every
sign-in path already forces full consent, `docs/SYSTEM_MAP.md` §2.1); slice 2 (table, BL-055);
slice 3 (Analytics adapter + domain module, BL-057) — `collectMetrics`/`listMetrics`, tested
against mocked HTTP, but the per-video query shape (one call per video vs. a hypothetical bulk
query) remains unconfirmed against a real API response, since that needs the owner's own
re-consent to test; slice 4 (manual "collect now" trigger + Web UI, BL-058). A fifth item, BL-059
(daily staleness-based auto-collection + a configurable local sync-time/timezone setting,
superseding the plan's original "no scheduling" boundary, plan §10 items 3-4), is also done —
see §14.6.

**Live-verified against the real "Tropico Jazz" channel** (`claude-in-chrome`, 2026-09-22, twice):
the manual trigger correctly reaches and fails at `AUTH_SCOPE_INSUFFICIENT` (the real stored token
predates BL-056's scope); the dashboard-mount auto-collect effect (BL-059) correctly fires once,
reaches the same point, and — per its own documented mark-then-run tradeoff — marks
`analyticsLastAutoCollectedAt` even though the underlying collection failed. That real timestamp
was reset back to `NULL` on the real channel after verification (a throwaway script, not
committed) specifically so the owner's own first post-re-consent dashboard load is not skipped
until the next day's boundary. Zero console errors across both verification passes.

### 14.2 Schema (additive, `SCHEMA_MIGRATIONS` versions 8-9)

```text
video_metrics_daily (new, v8) — channelId, videoId, metricDate (ISO date), metricName (e.g. "views"),
                                 metricValue (REAL), collectedAt
                                 PRIMARY KEY (videoId, metricDate, metricName)
                                 + index on channelId
channels.analytics_last_auto_collected_at (new column, v9) — nullable timestamp, BL-059's
                                 per-channel "when did the daily auto-collection last actually
                                 run" marker
```

`channels.analyticsLastAutoCollectedAt` mirrors the existing `lastSyncedAt` column's own shape
exactly (same table, same nullable-timestamp pattern) — deliberately NOT derived from
`MAX(video_metrics_daily.collected_at)`, since that column is a per-row last-*write* time: a
manual re-collection of an old date range would bump it without today's actual auto-collection
run ever having happened, silently defeating the staleness check's own purpose. See
`src/lib/analytics/staleness.ts`'s own doc comment and §14.6 below.

No `videos`/`channels` schema change — this is a purely additive new table alongside the existing
"current snapshot" `videos` table, storing a time-series `videos` was never meant to hold.
`channelId` is stored directly on the row (per `docs/PROJECT_SPEC.md` §33's canonical
`channelId`/`videoId`/`date` linkage) rather than requiring a join through `videos` to scope a
query to a channel, and stays a plain, non-FK column (denormalized convenience only, never an
identity/authorization boundary — `write-context.assertWriteChannel` remains that).

**`videoId` has a foreign key on `videos.id`**, matching `PHASE_8_PLAN.md` §5's own DDL exactly.
An earlier draft of this section claimed "deliberately no foreign key," following the
`video_edit_audit_events` precedent (§13; this database defaults to `foreign_keys=ON`,
`docs/TECHNICAL_DEBT.md` RISK-33) and reasoning that an FK here would add a new table-ordering
constraint to `applySnapshotToDatabase`/`scrubDatabaseCopy` (`src/lib/snapshot/`). An independent
review caught that this doesn't survive reading those two functions: both already wrap their
*entire* drop/replace sequence in `PRAGMA foreign_keys = OFF` ... `ON` regardless of any
relationship, so an FK here adds no new ordering constraint to either. Unlike
`video_edit_audit_events` (an audit trail that must genuinely outlive the row it describes), this
table has no such requirement, so there was no remaining reason to deviate from the plan's own
explicit schema — corrected in `src/lib/db.ts` and here.

### 14.3 Persistence access (`src/lib/db.ts`, additive)

```text
upsertVideoMetric(input)          — insert-or-update by the table's own primary key; re-collecting
                                     an already-collected date overwrites metricValue/collectedAt,
                                     never creates a duplicate row (tested against real SQLite)
listVideoMetricsByVideo(videoId)  — full metric history for one video
```

`src/lib/analytics/adapters/store.ts` now wraps both (§14.4) — no longer a bare `db.test.ts`-only
pair.

### 14.4 Analytics domain module (`src/lib/analytics/`)

Follows the standard `contracts/schemas/services/adapters/index` layering (§6.2). One operation,
`collectMetrics({credentialRef, channelId, startDate, endDate, metricNames?})`: for every video
`videoStore.listVideosByChannel(channelId)` returns, calls the low-level
`queryVideoAnalyticsReport` (§14 area / `src/lib/youtube-read-gateway/analytics-api.ts`) once and upserts every
returned `(date, metric)` pair via `upsertVideoMetric`. `metricNames` defaults to
`ANALYTICS_METRIC_NAMES` (the full non-monetary list, `PHASE_8_PLAN.md` §10 item 2) when omitted.

Channel-context validation mirrors `channel-sync/services.ts`'s `listSyncedVideos` exactly: since
this service already receives `credentialRef`, it calls `channelAccess.assertActiveChannel`
itself (once, here) rather than deferring to a future route — a future BL-058 route must not add
a second check. A video genuinely belonging to a different channel can never be reached through a
given `channelId` by construction (`listVideosByChannel(channelId)` only returns that channel's
own rows), proven by an explicit cross-channel test (`services.test.ts`) rather than left as an
inferred property.

One video's Analytics call throwing is isolated into `skippedVideoIds` (logged), never failing the
whole channel's run — mirrors `change-drafts-sync`'s per-peer isolation. `upsertsIssued` counts
upsert *attempts*, not distinct new rows — re-collecting an already-collected range reports a
nonzero count even though the underlying rows were only overwritten, not created (see the field's
own doc comment in `contracts.ts`). A metric absent/non-finite in a given API response row is
silently omitted from that row's upserts, never defaulted to `0` (matches `videos.viewCount`'s
existing nullable-never-zeroed convention, §2.7).

An automated `write-path-inventory.test.ts` (mirroring `ai-localization`'s) proves no file in this
module references any `videos`/`channels`-mutating `db.ts` function or any
`youtube-write-gateway` symbol — the plan's §7 "never writes to videos/channels" acceptance
criterion as a structural, automated check, not an inference from the dependency-injection shape
alone.

`credentialRef` shapes with no `userId` (e.g. a hypothetical future CLI caller passing raw tokens)
can never pass `assertActiveChannel` and so can never use this service — documented as a known
constraint in the function's own doc comment, not a bug.

A second read-only operation, `listMetrics({credentialRef, channelId})`, returns every already-
collected `(videoId, metricDate, metricName, metricValue)` row for the channel (via a new
`listVideoMetricsByChannel` in `db.ts`, mirroring `listVideoMetricsByVideo`'s own shape) — pure
local read, no `authResolver`/YouTube call, same active-channel check as `collectMetrics`.

### 14.5 Manual "collect now" trigger + Web UI (BL-058) — **IMPLEMENTED**

`POST /api/channels/[channelId]/analytics/collect` (real local-state mutation — writes
`video_metrics_daily` rows — gated normally by `src/proxy.ts`'s blanket device-availability check,
deliberately NOT added to its read-only exemption list) and `GET /api/channels/[channelId]/analytics`
(pure read, ungated) call `collectMetrics`/`listMetrics` directly. Neither route calls
`channelAccess.assertActiveChannel` itself — both services already do, mirroring
`channel-sync`'s own `videos/route.ts`, not `ai-localization`'s routes (whose services don't
receive `credentialRef` the same way).

Web UI: `src/components/analytics-manager.tsx`, replacing the Studio-parity S6-stub "coming soon"
placeholder in the Analytics tab (`docs/roadmap/BACKLOG.md` BL-017). A date-range form (local-date
defaults, ending *yesterday* — the Analytics API's own documented behavior is that a `day`-dimension
query never returns the most recent day(s) yet, so defaulting to "today" would look like a silent
partial failure) plus a "Collect now" button, and a paginated read-only table of whatever
`GET .../analytics` returns (no video-title join — this component only knows about metrics, video
metadata display stays `content-manager.tsx`'s concern).

**Live-verified against the real "Tropico Jazz" channel (2026-09-22, `claude-in-chrome`):** the
tab resolves the active channel and loads its (empty) collected-metrics table correctly; clicking
"Collect now" exercises the real chain (session → active-channel check → credential resolution →
scope check) end to end and correctly fails with `AUTH_SCOPE_INSUFFICIENT` — the real stored
token predates BL-056's scope addition, so this is exactly the expected, correct outcome pending
the owner's own re-consent, not a bug. Zero console errors throughout.

### 14.6 Daily staleness-based auto-collection (BL-059) — **IMPLEMENTED**

The owner's own rule, verbatim (Telegram msg 356, items 3-6): a daily check "при входе в наш
дашборд" (on entering the dashboard), comparing "now" against a **wall-clock local boundary**
(e.g. 12:05), not an elapsed-duration window — a run at 11:59 local today is still stale, a run at
12:06 local today is fresh. This app has no background daemon/cron separate from the Next.js
server process, so the check runs once per dashboard mount
(`src/app/dashboard/page.tsx`'s `autoCollectTriggeredRef`-guarded effect, independent of which tab
is active), not on a repeating interval — reusing the same "check once per mount, not a
continuous poll" discipline `content-manager.tsx`'s own `AUTO_RESYNC_STALENESS_MS` pattern
already established, generalized from "20 minutes" to "once a day."

**`src/lib/analytics/staleness.ts`** (pure, no I/O): `isAnalyticsCollectionStale` formats both
"now" and the last-collected instant into the target IANA timezone's own local calendar
date + time strings (one `Intl.DateTimeFormat` each) and compares those strings — deliberately
NOT an offset-arithmetic instant conversion (`Date.UTC` + `formatToParts` + diff-correction),
which is unnecessary for a pure comparison and easy to get subtly wrong. `Intl` already applies
the zone's real DST rules to each instant independently, proven by a dedicated test that gets a
*different* result for the same wall-clock UTC hour in January (EST) vs. July (EDT) for
`America/New_York` — the owner's own "зимнее/летнее время" concern, verified, not assumed.
`computeDefaultAutoCollectionRange` (same file) picks the unattended run's date range — 7 days,
ending yesterday, matching the manual UI's own default (`AUTO_COLLECTION_RANGE_DAYS`,
`contracts.ts`) — via pure calendar-day arithmetic on the zone's own Y-M-D components, so it has
no DST edge case to reason about (a calendar day is a calendar day in every zone).

**Settings:** two new `app_settings` keys (reusing the existing key/value table, `docs/SYSTEM_MAP.md`
§2.9f, not a new table) — `analytics_sync_local_time` (default `"12:05"`) and
`analytics_sync_timezone` (default: this machine's own OS timezone, detected via
`Intl.DateTimeFormat().resolvedOptions().timeZone` the first time it's ever read, then persisted —
never re-detected on a later read, so an explicit owner override is never silently clobbered;
safe specifically because this app's server and the operator's browser are the same machine, the
established "local-first single-operator tool" model). Both are validated at the `/api/settings`
write boundary (`isValidLocalTimeOfDay`/`isValidIanaTimezone`) rather than letting a bad value
throw inside the staleness check on a later dashboard load. UI: `src/components/analytics-sync-settings.tsx`
(Settings tab) — plain text/time inputs, not `ToggleSwitch` (these aren't booleans).

**Concurrency (advisor review):** `runAutoCollectionIfStale` marks
`channels.analyticsLastAutoCollectedAt` **before** calling `collectMetrics`, not after. Two
browser tabs mounting the dashboard at the same moment would otherwise both see "stale" and both
run a full per-video collection, doubling real Analytics API quota for no benefit — marking first
means the second caller sees fresh and no-ops (proven by a dedicated test simulating two
sequential calls at the same instant). The accepted tradeoff: if the collection itself then fails
or crashes mid-run, today's window is still marked "collected" and won't retry until tomorrow's
boundary — judged the better failure mode than doubling quota on every multi-tab load.

**Every connected channel (BL-142, 2026-10-06, owner msgs 1867/1868/1874).** The dashboard no longer calls the
per-channel `auto-collect` and `weekly-reports/generate-if-due` routes; once per load (after the active channel is
resolved) it calls `POST /api/analytics/auto-collect-all` (`src/lib/analytics/auto-collect-all.ts`), then the Research
`collect-if-stale` as before. The session's active channel is collected with the session's credentials while the
dashboard waits; every other channel runs after the response, one after another, with its own `connected_user_id`,
through the quota-guarded `runAutoCollectionIfStale` (BL-117 reserve and quota attribution apply), and its
`assertActiveChannel` still fails closed for a user who has another channel selected. Per channel the weekly report runs
after the collection, also when it failed. Note that `collectMetrics` marks a channel collected only after a
**successful** run, so nothing in it throttles a failure: a failing background channel is held back for 6 hours by an
in-process backoff (`channel-fanout`), the active channel is retried at once as before. One all-channels run at a time
per process. The BL-118 catch-up of every channel with a gap runs after the background part; a channel whose collection
just failed is not planned. Reasons a background channel was not collected are logged (no persisted record). The
response shows only the active channel (ADR 0004). Shared rules with BL-141 live in `src/lib/channel-fanout/`
(credential choice, error code, backoff, channel list). Cross-account token use: RISK-112. The per-channel routes remain.

**`GET /api/settings` is not purely read-only**: `getAnalyticsSyncSettings`'s detect-and-persist
behavior means a plain `GET` can write the OS-detected timezone on first read (stated in that
route's own doc comment, not left as a surprise).

**Live-verified against the real "Tropico Jazz" channel (2026-09-22, `claude-in-chrome`):** the
dashboard-mount effect fires exactly once and reaches the real `runAutoCollectionIfStale` →
`collectMetrics` chain, correctly failing at `AUTH_SCOPE_INSUFFICIENT` for the same
not-yet-re-consented reason as §14.5's manual trigger. Confirmed directly against the real
database that this **did** mark `analyticsLastAutoCollectedAt` despite the underlying collection
failing — exactly the documented mark-then-run tradeoff, not a bug — and then reset that column
back to `NULL` on the real channel afterward (a throwaway, uncommitted script) so the owner's own
first post-re-consent dashboard load is not skipped until the next day's boundary. Separately
confirmed the real machine's OS timezone (`Europe/Helsinki`) was correctly auto-detected and
persisted to `app_settings` on the first `GET /api/settings` call. Zero console errors.

**Build-time note, observed not introduced:** `npm run build`'s "Collecting page data" step
occasionally logs a `SQLITE_BUSY: database is locked` (or, once, a stale-schema-version rejection
from a leftover local DB state during this session's own testing) from one of several parallel
build workers racing to initialize the same real local database file — confirmed present on a
clean pre-BL-059 tree too (`git stash -u` + rebuild), so this is a pre-existing characteristic of
this dev environment's multi-worker build touching a real, singleton-guarded database file, not a
regression from this slice. Build exit code is unaffected (0) both with and without BL-059.

### 14.7 Known limitations

No Analytics API client, no OAuth scope request, no route, no UI — this slice is the persistence
primitive only, exactly `PHASE_8_PLAN.md` §6 slice 2's scope, deliberately not a vertical slice
end-to-end. See `docs/roadmap/BACKLOG.md` BL-056/BL-057/BL-058/BL-059 for the current status of
the remaining slices.

`metricValue` is `REAL NOT NULL` (changed 2026-09-22, before this table ever merged to `dev` —
`docs/roadmap/plans/PHASE_8_PLAN.md` §10 item 2). The plan's original DDL had it as `INTEGER`,
correct for `views` alone; once the owner authorized collecting every metric
`yt-analytics.readonly` covers, several of those (e.g. `averageViewPercentage`,
`annotationClickThroughRate`) are inherently fractional, so the column was widened to `REAL`
(exact for both integer counts and fractional rates) rather than adding a second,
metric-type-dependent column. Because this happened before the table shipped anywhere, no ADR was
needed (`docs/decisions/0001-additive-idempotent-schema-strategy.md`'s "non-additive change" gate
applies to a change against an already-released schema, not an in-progress, unmerged one) — any
*future* change to this column's type would need one.

**BL-151 (2026-10-07, §31):** these rows (and the reach rows) now travel between devices through their own per-device day
files, `src/lib/analytics-data-sync/`, not through the snapshot. The paragraph below still holds for the snapshot itself.

`video_metrics_daily` is **deliberately not added to `SNAPSHOT_TRANSFERRED_TABLES`**
(`src/lib/snapshot/contracts.ts`) in this slice — collected metrics stay device-local and do not
travel with a device handoff/snapshot import. Accepted limitation, parallel in kind to RISK-33's
own `rules.user_id` orphan case: a snapshot-import replace of `videos` (`SNAPSHOT_REPLACE_ON_IMPORT_TABLES`
already includes `videos`) can leave a local `video_metrics_daily` row referencing a `videoId` no
longer present in the receiving device's `videos` table after import — this never crashes (FK
enforcement is disabled for that entire operation, same as every other table it processes), it
just leaves a stale row. `docs/PROJECT_SPEC.md` §33 frames this data as the future basis for real
recommendations, so unlike `video_edit_audit_events` (a local audit trail with no such framing),
losing collected history silently on every handoff is worth flagging explicitly rather than
letting it repeat as an unstated gap — revisit whether this table should join
`SNAPSHOT_TRANSFERRED_TABLES` once real collection (slice 3+) makes the data worth carrying
across devices.

### 14.8 Channel-level Analytics reads for Studio-Parity S6b (`getChannelOverview`) — **IMPLEMENTED**

Every read documented above (§14.1-§14.7) is per-video: one `reports.query` call per synced
video, `filters=video==<id>`. Studio's own Analytics "Overview" tab (BL-072,
`docs/roadmap/plans/STUDIO_PARITY_PLAN.md` §4 Slice S6b) needs channel-level totals instead —
summing per-video rows would silently miss any activity not attributable to a currently-synced
video (a deleted video, or subscribers gained from the channel page itself), the same class of
undercounting problem RISK-33-style orphan rows already illustrate elsewhere in this document.

A throwaway diagnostic route (never committed, same technique BL-057 used) confirmed live against
a real channel that dropping `filters=video==...` entirely — `ids=channel==<id>`,
`dimensions=day`, no filter — is accepted by the real API and returns genuine per-day channel
totals. This is a *different* report shape from the one BL-057 already ruled out (a bulk
`dimensions=video,day` query across every video with no filter, which the API rejects outright) —
dropping the dimension, not just the filter, is what makes the difference. `queryChannelAnalyticsReport`
(`youtube-read-gateway/analytics-api.ts`) is this second report shape; both it and the existing
per-video report now share one response parser (`parseDayDimensionReport`) rather than duplicating
the name-based column-lookup logic.

`getChannelOverview` (`src/lib/analytics/services.ts`) is deliberately a **live read, never
persisted** — unlike `collectMetrics`, it writes nothing to `video_metrics_daily` or any new
table, and so is not subject to `collectMetrics`'s own once-a-day freshness gate (§14.6); it is
already gated by the existing per-category "Analytics reads enabled" toggle every
`createYoutubeAnalyticsClient` call goes through. It issues exactly two calls — the requested
period and the immediately-preceding period of the same length (`analytics/period.ts`'s pure
`computePreviousPeriod`) — and sums each into totals itself, rather than a third "totals only, no
dimensions" call; one report shape, two date ranges. A day the API omits from its response
contributes `0` to that sum, which is a true fact about the sum (no rows means no reported
activity), not the same "silently defaulted a missing per-day-per-metric value to 0" case
`collectMetrics`'s own doc comment warns against for raw per-row display.

Also confirmed live and worth recording here since it corrects §7 of `contracts.ts`'s own
provenance note: `impressions`/`impressionClickThroughRate` (Studio's thumbnail-impressions/CTR
widgets, both on Home and on Analytics' Content sub-tab), under those exact names, are rejected by
the real API as unknown metric identifiers. These are not the same as the `annotation*`/`card*`
legacy metrics already in `ANALYTICS_METRIC_NAMES` (dead since 2019, always zero) — they are a
structurally different capability. **Corrected 2026-09-26 (§14.12 below, found during the deep-
parity plan's own research):** the real identifiers Google actually shipped
(`videoThumbnailImpressions`/`videoThumbnailImpressionsClickThroughRate`, added 2026-01-15) *are*
recognized by the API — the 2026-09-23 rejection above was the wrong names, not a capability gap —
but they belong to a structurally different YouTube Reporting API v1 "Reach report" (a bulk,
scheduled-job system), never this ad-hoc `reports.query` endpoint, so the practical conclusion is
unchanged: no code path in this repository requests them, and none can via this endpoint regardless
of naming.

**Totals will not exactly match Studio's own displayed numbers for the same nominal date range,
and this is expected, not a bug.** Cross-checked live 2026-09-23 against the real "Rural Japan
Music" channel for the identical "Aug 26 - Sep 22" window Studio itself showed earlier the same
session: Studio displayed 2,052 views / 379.7 watch-time hours / +18 net subscribers; this
endpoint returned 1,966 / 364.1 hours / +17 for the exact same request. Inspecting the raw
response showed why: the API's `daily` rows stopped at `2026-09-20` -- no row at all for
`2026-09-21`/`2026-09-22`, even though both were inside the requested range. This is the same
reporting lag `PHASE_8_PLAN.md` §10 item 4 already documents for the per-video report (the API
does not yet report the most recent day(s) of any range) -- Studio's own internal dashboard
evidently draws from a less-lagged data source than the public Analytics API `reports.query`
exposes. Nothing here should try to "fix" this by guessing or interpolating the missing days;
`getChannelOverview` correctly sums exactly what the API has processed as of query time, and the
chart's `zeroFillDailySeries` correctly stops at the last date actually present rather than
padding through `endDate` with fabricated zeros (see its own doc comment). A future slice
re-querying a completed period after the lag has cleared would show a different, larger total for
the same historical dates -- this is inherent to using the public API, not a caching bug to chase.

### 14.9 Data-quality diagnostics (`getDataQualityReport`) — Phase 8 follow-up, slice 2 of 4

`docs/roadmap/FUTURE_PHASES.md` §4's "data-quality/missing-data diagnostics" line item. New
additive table `analytics_collection_runs` (`SCHEMA_MIGRATIONS` version 13) -- one append-only row
per `collectMetrics` invocation, recording the requested date range, video count, upserts issued,
and which video IDs were skipped due to a per-video failure.

**Why a separate history table is needed, not just a scan of `video_metrics_daily`:** live-verified
2026-09-23 against a real low-traffic video that the Analytics API silently OMITS a day from its
`reports.query` response when that video had zero activity that day -- it is never returned as a
zero-value row. An absent `video_metrics_daily` row is therefore ambiguous between "never
collected" and "collected, zero activity" without an independent record of which ranges collection
actually attempted.

`computeDataQualityReport` (`src/lib/analytics/data-quality.ts`, pure, no I/O) classifies each date
in the requested range as covered (a recorded run's own range includes it, OR at least one real
`video_metrics_daily` row exists for that date -- the latter fallback exists specifically for data
collected *before* this table existed, which would otherwise show as "never collected" purely
because the tracking mechanism postdates it), uncovered (a genuine gap), or too-recent (within
`ANALYTICS_REPORTING_LAG_DAYS` = 2 days of "now" -- the same reporting lag §14.8 documents, which
means even a requested collection wouldn't have data yet, so this is never flagged as a real gap).
Skipped-video aggregation only counts runs whose own range overlaps the requested range.

Live-verified against the real "Tropico Jazz" channel: a 28-day report correctly found only 6 of
28 days actually covered (the channel's real collected history is a narrow 6-day band, `2026-09-15`
through `2026-09-20` -- confirmed directly against `video_metrics_daily`'s own distinct dates), a
genuine, previously-invisible data gap this feature exists to surface, not a bug in the check
itself.

Exposed via `GET .../analytics/data-quality`, the MCP tool `analytics_data_quality`, and the CLI's
`analytics data-quality` command -- all three read-only, ungated, following the same pattern as
`analytics_list`/`analytics_overview` (BL-073). `analytics_collection_runs` is deliberately kept
out of `SNAPSHOT_TRANSFERRED_TABLES`, the same as `video_metrics_daily` itself (§14.7) -- a
re-derivable, device-local history, not data that needs to survive a device handoff.

### 14.10 Comparable-age video comparison (`getComparableAgeComparison`) — Phase 8 follow-up, slice 3 of 4

`docs/roadmap/FUTURE_PHASES.md` §4's "comparing videos at comparable ages" line item. Given 2-10
`videoIds` on the same channel, aligns each video's already-collected `video_metrics_daily` rows by
**days since publish** rather than calendar date, so videos published on different dates can be
compared at the same point in their own lifecycle (mirroring YouTube Studio's own "Compare videos"
growth-curve feature).

**Pacific-Time day alignment (`src/lib/analytics/comparable-age.ts`, pure, no I/O):**
`video_metrics_daily.metricDate` is the Analytics API's own `day` dimension, a Pacific-Time
calendar day (§14.7/`youtube-read-gateway/analytics-api.ts`). `videos.publishedAt` is a UTC instant
from the Data API. Day 0 of a video's life is therefore its **Pacific-Time** calendar date of
`publishedAt` (`toPacificCalendarDate`, via `Intl.DateTimeFormat` with `timeZone:
"America/Los_Angeles"`), never the UTC calendar date -- a video published shortly after UTC
midnight can otherwise land a full day off relative to every other video it's compared against. Day
offsets are a pure calendar-day diff of two `YYYY-MM-DD` strings via `Date.UTC` (`diffCalendarDays`,
mirroring `period.ts`'s own DST-safe convention), never a raw millisecond subtraction. Day 0 is
necessarily a **partial day** (the hours before publication aren't part of the video's life, but
the Analytics API only reports whole-day totals) -- the same approximation Studio's own feature
makes.

**Only additive metrics are offered for comparison.** `CUMULATIVE_COMPARISON_METRIC_NAMES` is an
explicit allowlist (views, likes, estimatedMinutesWatched, subscribersGained, etc.) excluding every
ratio/average entry in `ANALYTICS_METRIC_NAMES` (`averageViewDuration`,
`annotationClickThroughRate`, etc.) -- summing a ratio across days produces a meaningless number.
Requesting a non-additive metric is rejected as `validation_failed`.

**A missing day is "unknown," never a fabricated zero, and this slice deliberately does NOT reuse
`analytics_collection_runs`'s channel-level coverage to infer "known zero."** §14.9 already
established that `analytics_collection_runs` records which channel-wide date *ranges* were
attempted, not which specific videos a given past run actually queried -- a video published after
an older run's own snapshot of `videos` was never attempted by it, and there is no historical record
of channel membership to check against. Given that unresolved ambiguity, a real `video_metrics_daily`
row is the only fact this module treats as "known"; every other day-offset is "unknown." This means:
raw `points` never include a fabricated zero, and the running `cumulativePoints` total stops dead at
the last contiguous known day from day 0 (never skips a gap and keeps summing past it). This is the
same "a materially larger data model than this diagnostic's actual purpose justifies as a first
slice" tradeoff §14.9 already accepted for its own, narrower scope -- a more precise model would need
an additive `analytics_collection_runs.queriedVideoIdsJson` column and is left as a future follow-up,
not attempted here.

**Real-data caveat, confirmed by directly querying two real channels' `video_metrics_daily` before
designing this feature's response shape:** the daily auto-collection window only covers the most
recent ~7 calendar days per run (§14.6), not "the video's first 7 days since publish." For a video
published more than about a week before regular collection started for its channel, `points` will
typically have no entries for low day-offsets (0-7) specifically, and `cumulativePoints` will
typically be empty entirely (it always starts from day 0, so a missing day 0 halts it before it
starts) -- not a bug, a genuine, expected data-coverage gap. `points` for that same video may still
be non-empty overall if the rolling collection window happened to cover some LATER day-offset --
an empty `cumulativePoints` does not imply an empty `points`. On the two real channels used to validate this feature ("Rural Japan
Music", "Tropico Jazz"), this happens to be a much smaller problem than it first appears, because
both channels upload frequently enough that the rolling 7-day window naturally overlaps most recent
videos' own early days -- but a video from more than ~1-2 weeks ago will still show sparse or empty
low-day-offset data until a manual historical backfill is run for it specifically. No backfill
mechanism was added by this slice -- widening `AUTO_COLLECTION_RANGE_DAYS` or adding a backfill path
was explicitly out of scope: the once-a-day freshness gate (§14.6) is the owner's own explicit rule
("ни человеку, ни агенту, ни каким-то скриптам") and is not something this slice may work around.

**No ranking, no "outperforming" language, no headline verdict** -- `docs/roadmap/FUTURE_PHASES.md`
§4's own constraint ("distinguish observed facts from interpretations... avoid unsupported
conclusions from small samples"). The response is the same raw per-video series for every caller,
human or agent, to draw its own conclusion from.

Every requested `videoId` is checked against `videoStore.listVideoDetailsByChannel(channelId)`
(`docs/DEVELOPMENT_PLAYBOOK.md` §6.6) -- an id that doesn't resolve to the given channel is reported
back as `validation_failed` with the offending id(s) in `details`, never silently dropped from the
comparison. Exposed via `GET .../analytics/comparable-age`, the MCP tool
`analytics_comparable_age`, and the CLI's `analytics comparable-age` command -- all three pure local
reads (never a live YouTube call), read-only, ungated, following the same pattern as
`analytics_list`/`analytics_data_quality` (unlike `analytics_overview`, which is a live, gated
Analytics API read -- see §14.8).

### 14.11 Weekly analytics reports (`runWeeklyReportIfDue`/`listWeeklyReports`/`getWeeklyReport`) — Phase 8 follow-up, slice 4 of 4

`docs/roadmap/FUTURE_PHASES.md` §4's "analytical reports and weekly channel reviews" line item --
the last of Phase 8's four follow-up slices. A frozen, reproducible snapshot per channel per
Monday-Sunday week, computed entirely from already-collected local `video_metrics_daily` rows --
**never a live YouTube API call**, matching the deliverable's own wording ("reproducible analytical
reports from stored historical data").

**Trigger (owner instruction, 2026-09-23): "Давай завяжемся на то же время что мы выбираем в
настройках -- 12-05 сейчас по понедельникам."** Reuses the exact `localTime`/`timezone` pair the
daily auto-collection boundary already reads from Settings (§14.6) -- no separate weekly-report
setting. `computeDueReportWeek` (`src/lib/analytics/weekly-report.ts`, pure, no I/O) determines the
single most recently completed week whose Monday-`localTime` boundary has passed, using the same
zoned-string-comparison technique `staleness.ts`'s `isAnalyticsCollectionStale` already uses (DST-
correct with no manual offset code). Missed weeks are never backfilled -- a long-dormant app only
ever gets the single most recently due week on its next dashboard load, the same "no backfill"
philosophy §14.10 already established for comparable-age comparisons.

**`status: "final"` vs `"provisional"` (advisor review, 2026-09-23):** the trigger boundary (Monday
12:05, the operator's own local clock) does not line up with the Analytics API's own reporting lag
(§14.8's 1-2 day lag) or with `video_metrics_daily`'s Pacific-Time day-numbering (§14.10) -- for an
operator outside Pacific Time, the just-completed week's own last day or two may genuinely not be
collected yet at the moment the trigger fires. Rather than freeze an undercounted snapshot forever,
a report is `"provisional"` whenever any date in ITS OWN week is still uncovered or too-recent
(`computeDataQualityReport`, §14.9, run against the report's own week); the next dashboard load's
trigger check regenerates (replaces) a provisional report for the same week once it clears, and
never touches an already-`"final"` row. `runWeeklyReportIfDue` (`services.ts`) does a cheap
read-before-write early exit, but the actual "never overwrite a final row" guarantee is enforced at
the DB layer, inside `db.ts`'s `upsertWeeklyReport` itself (a conditional `ON CONFLICT ... DO
UPDATE ... WHERE status != 'final'`) -- the service's own check-then-act is not atomic across two
concurrent callers (e.g. two open dashboard tabs both triggering the generate-if-due route near the
same moment), a real race an independent review found (2026-09-23) and this DB-level guard closes.

**Week-over-week `percentChange` is `null` (the whole object, not per-field) unless BOTH the
current and previous week are fully covered** -- comparing a real week against a mostly-uncollected
previous week (the exact situation the real "Tropico Jazz" channel is in today, per §14.9) would
measure collection coverage, not real change, which `FUTURE_PHASES.md` §4's own "avoid unsupported
conclusions from small samples" constraint forbids. Each week's own `currentWeekDataQuality`/
`previousWeekDataQuality` (the full `computeDataQualityReport` shape) is embedded in the stored
snapshot, so a reader can see exactly why a comparison is or isn't present.

**`syncedVideoTotals`, not "channel totals" (advisor review, 2026-09-23):** named and documented
(via `SYNCED_VIDEO_TOTALS_METRIC_DEFINITIONS`, embedded in every stored report) as a sum over
currently-synced videos' own `video_metrics_daily` rows -- the same undercounting caveat §14.8
already documents for any per-video-summed total (excludes deleted videos, and for subscriber
metrics, excludes activity not attributable to a specific video). Never presented as, or confused
with, YouTube Studio's own channel-wide subscriber count.

**Provenance, per `FUTURE_PHASES.md` §4's "clear provenance and documented metric definitions"
requirement:** every stored report embeds `reportFormatVersion`, `generatedAt`, `source` (a fixed
string stating the local-only origin), and `metricDefinitions` -- and is re-validated through
`weeklyReportContentSchema` (a strict zod schema mirroring `WeeklyReportContent` field-for-field) on
every READ, not just on write, so a corrupted or malformed stored row fails loudly
(`validation_failed`) rather than silently serving a partial report.

**Schema:** `analytics_weekly_reports` (`SCHEMA_MIGRATIONS` version 14) -- one row per
`(channel_id, week_start_date)` (`UNIQUE` index), `report_json` holding the full serialized
`WeeklyReportContent`. Deliberately kept out of `SNAPSHOT_TRANSFERRED_TABLES`, the same reasoning as
`video_metrics_daily`/`analytics_collection_runs` (§14.7/§14.9): derived, re-computable data that
never needs to travel with a device handoff.

**Trigger wiring:** `POST .../analytics/weekly-reports/generate-if-due`, called once per dashboard
mount (`src/app/dashboard/page.tsx`) chained via `.finally()` AFTER the existing auto-collect
trigger resolves -- so a Monday dashboard load's weekly snapshot sees whatever that same load's own
auto-collect just refreshed, not last week's data. Gated by `src/proxy.ts` like any other mutating
POST (a real local-persistence mutation when it decides a new/replacement snapshot is due).

**Read surfaces, all read-only, ungated, no generate-on-demand tool exposed to agents (same
exclusion reasoning as `collectMetrics`/`runAutoCollectionIfStale`, §14.5/§14.6):** `GET
.../analytics/weekly-reports` (list, newest week first), `GET
.../analytics/weekly-reports/[weekStartDate]` (one report, `{ report: null }` if none exists yet),
MCP `analytics_weekly_reports_list`/`analytics_weekly_report_get`, CLI `analytics weekly-reports`/
`analytics weekly-report-get`.

**Known, tracked duplication (`docs/TECHNICAL_DEBT.md` RISK-50):** the report's own `topContent`
ranking (group `views` by video, sum, sort, top 5) is a second implementation of the same
aggregation the client-side `use-top-videos.ts` hook already does for the Analytics
Overview/Content tabs (§14.12 below) -- not unified in this slice (see RISK-50 for why; that entry
itself needed a 2026-09-26 correction since the client-side implementation it names moved from
`channel-overview-panel.tsx`'s own inline `fetchTopContent` into that shared hook).

### 14.12 Content/Audience breakdown cards + video retention curve (deep-parity plan, BL-092..098) — **IMPLEMENTED, not yet in `dev`**

`docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md` -- extends §14.8's Overview-only Studio
parity to the Content and Audience sub-tabs, plus closes §14.8's own impressions/CTR question
(corrected above, not merely repeated).

**One new report shape, one new gateway function, reused seven ways.** Every capability this slice
adds -- traffic sources, device type, age/gender, geography, subscribed status, content format,
and the video retention curve -- shares an identical wire shape once dimension/metric names differ:
a single date range, no `day` dimension, one row per distinct dimension-value combination, an
optional `filters=video==<id>` for the one per-video case (retention). `queryChannelBreakdownReport`
(`youtube-read-gateway/analytics-api.ts`) is the single function for all seven, live-confirmed
against a real channel for each one individually before being written (not assumed from
documentation) -- the same "never trust a documented name until a real response confirms it"
discipline `CHANNEL_OVERVIEW_METRIC_NAMES`'s own doc comment (§14.8) already established, now paying
off in the other direction: all seven confirmed clean on the first live-probe attempt, no retry
needed for any of them (unlike impressions/CTR below, the one capability this research effort found
genuinely needed correcting after a wrong initial assumption).

**Two service methods, both live reads, never persisted** (same `getChannelOverview` precedent as
§14.8, not `collectMetrics`'s daily-collection model): `getChannelBreakdown` (parameterized by
`CHANNEL_BREAKDOWN_PRESETS`, `contracts.ts` -- the dimension/metric pair for each of the six
breakdown kinds) and `getVideoRetentionCurve` (the one case needing a `videoId`, which it verifies
belongs to `channelId` via `videoStore.listVideosByChannel` before querying -- the same discipline
§14.10's `getComparableAgeComparison` already uses for its own `videoIds` input).

**Impressions/CTR, corrected (see §14.8's own updated paragraph above for the full story):** the
real identifiers Google shipped 2026-01-15 are recognized by the API but belong to a structurally
different Reporting API v1 bulk-job "Reach report," never this app's ad-hoc query gateway --
confirmed by exhausting every plausible request shape against the real API (channel-level, with
`dimensions=day`, paired with `views`, filtered to one video) and getting "query not supported" for
every one once the metric name itself stopped being rejected outright. This capability is
**out of scope**, not merely unbuilt -- reaching it would need a second, structurally different
Google API integration this repository has never built (a scheduled-job model: create a job, then
poll/download generated report files, rather than a single request/response call).

**Realtime panel, also confirmed out of scope:** a direct probe for "today"/"the last 48 hours"
against the same query endpoint returned empty rows -- the documented 48-72 hour processing delay
(already the reason `computeDefaultAutoCollectionRange`, §14.6, targets "yesterday" rather than
"today") applies uniformly to both the ad-hoc query API and the bulk Reporting API. Studio's own
live-updating 48h/hourly panel and live subscriber ticker are built on infrastructure neither public
surface exposes.

**Content-format label casing, genuinely unresolved (independent review, round 1, 2026-09-26):**
this session directly observed a real API response returning `"videoOnDemand"` (lowerCamelCase) for
`creatorContentType`, but a later review round found Google's own published dimension docs state
uppercase-snake-case values (`VIDEO_ON_DEMAND`, `SHORTS`, `LIVE_STREAM`, `STORY`). A live re-probe to
settle the discrepancy hit an unrelated OAuth token-refresh failure and could not complete this
session. `breakdown-labels.ts` maps both casings rather than picking one, with the discrepancy
documented in a code comment -- treat this as open until re-probed against a real response.

**Traffic-source label accuracy (independent review, rounds 2-3, 2026-09-26):** three
`insightTrafficSourceType` labels were found copied from the enum name's own surface resemblance to
a familiar term rather than checked against Google's documented meaning -- exactly the §L failure
mode this whole plan's own research discipline was meant to avoid, caught this time by review
rather than by a live probe. `SUBSCRIBER` was labeled "Subscription feed," but Google's own docs
describe it as views referred from either the YouTube homepage feed *or* subscription features --
homepage-feed views are commonly the larger share of this bucket for many channels. `CAMPAIGN_CARD`
was labeled "Campaign card" (reading it as a UI card, by association with the unrelated legacy
`card*` end-screen metrics), but Google's docs describe it as views from a claimed, user-uploaded
video the content owner used to promote the viewed content -- a Content ID promotion mechanism, not
a literal card. `PROMOTED` was labeled "Promoted content," dropping the documented "unpaid"
qualifier that distinguishes it from `ADVERTISING` (the actual paid-promotion source) sitting right
next to it in the same list. All three corrected to match their documented scope.

### 14.13 Impressions and CTR from the YouTube Reporting API (`src/lib/reach-reports/`) — BL-114, on `feature/bl-114-reporting-api-reach`

Decision record: `docs/decisions/0014-youtube-reporting-api-gateway-child.md`.

- **Why a separate mechanism.** The Analytics `reports.query` endpoint rejects the thumbnail impressions / CTR metrics (§14.4's live probes); they exist only in the Reporting API v1's Reach reports. That API is bulk and scheduled: the app creates a **job** for a report type, Google generates one file per day, the app downloads and stores them. Google backfills 30 days before job creation, first files appear within ~48 h, backfill files expire after 30 days and regular ones after 60 -- so the app persists everything it downloads.
- **Gateway.** `youtube-read-gateway/reporting-api.ts` is the third `googleapis` child. The client constructor (`createYoutubeReportingClient`) is the single choke point for the **Reporting reads** toggle and the `reporting_reads` traffic counter. `jobs.reports` is a nested resource that the quota-classification proxy does not wrap, so each call goes through `callYoutubeApi` explicitly. A report's `downloadUrl` comes from an API response, so the download refuses any host except `youtubereporting.googleapis.com` before any credential is sent. Creating a job is **not** a YouTube write (ADR 0014): no Live writes, no write gateway.
- **Module.** `reach-reports` follows the usual layering and does not import `analytics` (AGENTS.md §M): turning Reporting off, or a failure here, never affects the Analytics tab or `agent_query_channel_analytics`.
  - `syncReachReports`: `assertActiveChannel` (fail closed, before any credential use) -> `ensureReportingJob` (reuse an existing job, never duplicate) -> list files -> skip ids already in the ledger -> process oldest `createTime` first -> per file: download, parse by header name, map, import in one transaction. One bad file lands in `failures` and is retried next time. `onlyIfDue` skips the whole run if the job was checked, or a sync attempted with outcome `ok`/`partial`, less than 6 h ago (a `failed` attempt does not throttle: its cause is usually fixable). Every attempt after the channel check is recorded in `reporting_sync_attempts` (outcome `ok` / `partial` / `failed`, error text, failed files); a failure that stops the sync before any import is recorded and then rethrown. Failed files are deliberately **not** put in the file ledger, so they stay retryable.
  - `syncAllReachReports` (BL-141, `POST /api/reach/sync-all`, once per dashboard load after the active channel is
    resolved): every stored channel, concurrently. The session's active channel uses the session's credentials; every
    other channel goes through `syncReachReports` with its own `connected_user_id`, so its `assertActiveChannel` still
    fails closed when that user has another channel selected. For background channels a failed attempt also throttles
    (`throttleFailed`), and a "not synced" reason (no connected user, other channel selected) is written to that
    channel's `reporting_sync_attempts` row. An in-process guard skips a second automatic sync of a channel already
    running. The response shows only the active channel (ADR 0004). Cross-account token use: RISK-112.
  - **Import rules** (`reach-csv.ts`, `importReachReport`): a file is rejected whole for a missing documented column, a row naming another channel, an unreadable date/number, or two rows for one (video, day). A file for a period that already has an imported file replaces that file's rows only if its `createTime` is later (also dropping videos it no longer lists); an older file is recorded as superseded and changes nothing.
  - `getReachStatus`: a local read for the Analytics card (`GET .../reach/status`): job, `createTime + 48 h` as the expected first file (`firstFileOverdue` only when no file is imported and that time has passed), last attempt, next automatic check (`last check + 6 h`), file list (period, rows, status). Settings shows only the quota (`cloud-quotas` `reporting`, `youtubereporting.googleapis.com`), never job/file status.
  - `getChannelReach`: a local read. `state` separates no job / job but no file yet / data, so an empty result is never read as zero. CTR is a ratio, so totals are **impressions-weighted** (clicks = ctr x impressions); a row without a CTR contributes to neither side, and no CTR at all gives `null`, never 0.
- **Storage (schema v38, plus `reporting_sync_attempts` in v40).** `reporting_jobs` (job per channel and report type; Google stays the source of truth), `reporting_report_files` (ledger + supersession status), `channel_reach_daily` (primary key channel/date/video, no FK to `videos`, nullable `ctr`). Classified device-local in `snapshot/contracts.ts` (same accepted limitation as `video_metrics_daily`, RISK-52) and `authorized` in `youtube-data-policy` (III.E.4.b names Reporting API data).
- **Unverified until real data exists:** the report's `date` format (both `YYYYMMDD` and `YYYY-MM-DD` are accepted) and the CTR scale (ratio assumed, `reach-format.ts` is the one place to change).
- **Not in this slice:** `channel_reach_combined_a1` (by traffic source / device), an agent tool that triggers a sync, video titles beside the ids in the UI table.

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

## 17. Agent Operations Interface (`src/lib/agent-operations/`) — Phase 7, in progress, not yet in `dev`

Owner instruction, Telegram 2026-09-23: a full 34-section spec ("Phase 7 — Agent Operations
Interface for Codex") authorizing design and incremental implementation of a versioned interface
external operational agents consume, without per-slice approval (only the final `dev` merge needs
explicit sign-off). **The full technical design, permission model, error vocabulary, and
per-slice implementation status live exclusively in `docs/AGENT_OPERATIONS_INTERFACE.md` §7's
status table -- this heading deliberately never names which slice is implemented**, so it never
needs updating as slices land; consult §7 of that document instead, every time.

In one sentence: this application remains the sole source of truth for owned-channel data,
analytics, and the write-safety pipeline; the agent is a reasoning/proposal layer that must
re-request context rather than cache a private copy, and can only ever hold `READ`+`DRAFT`
permissions (never `APPROVE`/`EXECUTE`) until a future, separate, explicit owner decision widens
that. This phase's planned scope spans contracts/capability-discovery, channel/video context, an
analytics wrapper, a new creative-asset catalog, draft provenance, bulk-localization integration,
content-proposal/artifact registration, a Codex operations-workspace template, and independent
review -- **which of these is actually implemented as of any given moment is tracked exclusively
in `docs/AGENT_OPERATIONS_INTERFACE.md` §7's status table, never restated here**.

## 18. Market Intelligence (`src/lib/market-intelligence/`) — Phase 9, slices 1-4 + 9A-9E + 9G + 9H (parts A-C) + 9I

Owner instruction, Telegram 2026-09-26: an explicit assignment to research, plan, and begin
implementing Phase 9 (`docs/roadmap/FUTURE_PHASES.md` §5) as its own feature branch, superseding
§2a's Operational Validation Gate default ordering for Phase 9 specifically (see `FUTURE_PHASES.md`
§12). **Detailed design, slice breakdown, and acceptance criteria live in
`docs/roadmap/plans/PHASE_9_PLAN.md` and `docs/SYSTEM_MAP.md` §2.9v -- this section states only the
one architectural decision worth recording permanently here, not the full slice-by-slice detail.**

**The one new trust boundary this phase introduces:** every table this application had before Phase
9 implicitly assumes the operator owns the channel/video a row describes (`channels.id` is always a
channel `write-context.assertWriteChannel` could plausibly authorize a write against). Phase 9 is
the first phase whose entire purpose is data about a channel the operator does *not* own. Rather
than adding a nullable "is this owned?" flag to an existing table, this is enforced structurally:
`research_channels`/`research_evidence` are new, separate tables, never joined with
`channels`/`videos`, and a mechanical inventory test
(`src/lib/market-intelligence/write-path-inventory.test.ts`) fails the suite if any file in this
module ever references `write-context`/`assertWriteChannel`/`youtube-write-gateway`. This is the
same "enforce the invariant mechanically, not by convention" pattern already used for the read/write
gateways (§17's own reuse of `AGENTS.md` §G) and for `ai-connections`'/`shared-xlsx`'s own inventory
tests -- applied here to a new *data-ownership* boundary rather than a new *call-site* boundary.

The one real outbound YouTube call this phase makes (`getPublicChannelSnapshot`,
`src/lib/youtube-read-gateway/data-api.ts`) is a new function on the existing single read gateway
(`docs/decisions/0007-youtube-read-gateway.md`), never a new client or a direct `googleapis` import
-- confirming that gateway's own design already generalizes to reading an arbitrary, non-owned
channel's public data by explicit id, which this phase needed and which nothing before it had
exercised.

**Slice 4 (`docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`, 2026-09-26) -- agent-facing MCP/CLI
surface, fulfilling the two capability names `agent-operations` reserved since Phase 7
(`query_market_intelligence`/`query_competitors`).** Registered directly in `src/mcp/server.ts`/
`src/cli/video-metadata.ts` against `createMarketIntelligenceCore()`, deliberately **not** through
a new function in `agent-operations`'s own service layer the way slice C/K/L wrap `analytics`/
`comparable-content`/`asset-performance`. `PHASE_9_PLAN.md` §5's module-independence rule forbids
adding `market-intelligence` as a hard dependency of another module's *service* layer; keeping this
dependency confined to the MCP/CLI *interface* layer (which already imports every domain module's
own core factory directly, e.g. `analyticsCore`) avoids that without losing anything -- neither tool
needs slice C/K/L's richer "agent context" reshaping. `agent-operations`'s own `AGENT_CAPABILITIES`
still gains two entries under a new `market_intelligence` domain, following the same
"pre-existing tool, registered here for capability-discovery completeness" pattern already used for
`channel_context.list_channels`/`analytics.query_data_quality`.

**Slice 9A (`docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md`, 2026-09-26) -- structured, append-only
market snapshot model, the first slice of Phase 9's extended scope (Part II).** New
`market_channel_snapshots`/`market_video_snapshots` tables (SCHEMA_MIGRATIONS v23), FK'd to
`research_channels.id`. **Never upserted by any natural key** -- the central finding this slice's
own plan documents (§2/§10): unlike `video_metrics_daily`'s per-day upsert (correct for owned-
channel Analytics API data, which has a real "historical day" concept), `channels.list`/
`videos.list` return only the *current* cumulative count with no way to ask for a past day's value
-- every real observation must be its own newly-inserted row, or the exact history Phase 9's own
irreplaceability priority (spec §38, `PHASE_9_PLAN.md` §10) depends on would be silently
overwritten. `deleteResearchChannel` (`src/lib/db.ts`) was widened to cascade-delete both new
tables in the same transaction as `research_evidence`, closing the identical FK-ordering hazard
RISK-46 already taught this codebase the hard way.

**Derived metrics (delta, velocity) are pure functions computed at READ time** over raw snapshot
rows (`src/lib/market-intelligence/derived-metrics.ts`, styled after `src/lib/analytics/
staleness.ts`: zero I/O, `now` always an explicit argument) -- never a second, redundant stored
representation (spec §8's own "prefer retaining raw observations so formulas can evolve later").
`computeSnapshotVelocity` reports an explicit `insufficient_history`/`partial_window`/`full_window`
basis alongside its computed rate, rather than silently extrapolating over a span the real data
doesn't actually cover -- the same "expose limitations when history is incomplete" discipline
(spec §27) this slice's own `hiddenSubscriberCount` boolean column applies at the storage layer
(an explicit fact -- "YouTube hides this" -- kept structurally distinct from "we don't know").

**Deliberately narrower than the plan's own literal 9A text**, and explicitly recorded as such
(`PHASE_9_SLICE_9A_PLAN.md` §1): `market_video_snapshots` ships with a full schema and CRUD service
layer (`recordVideoSnapshot`/`listVideoSnapshots`) so 9B has something to write into and it is
independently testable now, but **no automatic collector writes to it yet** -- real video-
enumeration (walking a channel's uploads playlist, batching `videos.list`) is 9B's own named scope,
not silently pulled forward into this slice. `captureChannelSnapshot` (the one live YouTube call
this slice adds) reuses the identical `getPublicChannelSnapshot` read-gateway call `fetchPublicSnapshot`
(slice 3) already uses, but is a pure *addition* -- `fetchPublicSnapshot`'s own existing
`research_evidence` write path is completely untouched, proven by a dedicated test
(`AC-9A-10`, `services.test.ts`).

**Slice 9B (`docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md`, 2026-09-27) -- repeatable refresh, real
video collection, an operator-set quota budget, and a check-on-app-open scheduler.** Fills the gap
9A's own plan explicitly named: a data model and one manual/on-demand live action, with zero
automatic trigger. The one architectural decision worth recording permanently:

**A stricter, dedicated mark-then-run concurrency guard, not a reuse of Phase 8's own
`runAutoCollectionIfStale` pattern.** Direct inspection (before implementation, advisor review)
found that Phase 8's own auto-collection is actually mark-*after* -- it marks
`channels.analyticsLastAutoCollectedAt` only once collection finishes, and its own doc comment
explicitly accepts a rare double-collection race between two concurrent callers as a deliberate
tradeoff (Analytics quota is ample enough that a rare double-spend is harmless). That tradeoff does
not transfer here: this feature's daily budget is an operator-set number that can be small, so a
double-spend is a real correctness problem, not a rare harmless waste. This slice therefore adds its
own `research_channels.collection_claimed_at` column (nullable timestamp, same v24 migration as
`last_auto_collected_at`) and claims every eligible channel in ONE atomic
`UPDATE ... WHERE (stale) AND (unclaimed) ... RETURNING id` at the start of a run -- not
per-channel -- so two concurrent callers (two open dashboard tabs) can never together claim
overlapping channels, closing a race a per-channel-only claim would still leave open against a
run-scoped shared budget. A claim is released the moment its channel's attempt reaches any terminal
outcome; a claim older than 15 minutes is treated as an abandoned (crashed) attempt and may be
reclaimed, so a crash never permanently locks a channel out of future collection. This atomicity is
verified directly against the real libsql driver (`db.test.ts`), not assumed from SQLite's general
reputation.

Budget accounting is metered per real outbound call, not per assumed channel cost: the collector
tracks `remaining` across the whole run and, the moment a channel's next call can't be paid for,
writes exactly one `skipped_quota_limited` row for that channel (with whatever it honestly spent so
far, even 0) and releases every other still-claimed channel without its own row -- a deliberate
choice (found necessary by advisor review) to avoid writing one identical audit row per remaining
stale channel on every single dashboard mount once the budget merely runs short. A channel whose
most recent run failed within the last 24h is excluded from the next claim entirely, for the
symmetric reason: without this, a permanently broken (deleted/private) competitor channel would
spend at least one real unit on every mount, forever.

Video enumeration is deliberately capped to a channel's uploads playlist's first page only (a new
`listUploadsPlaylistFirstPageVideoIds`, exactly one `playlistItems.list` call, never paginates) --
an earlier drafted design widened the existing `listUploadsPlaylistVideoIds` with an `maxResults`
option instead, but advisor review found that would leave the real unit cost unobservable to the
caller whenever the first page came up short and a second page had to be fetched, silently
under-counting real spend. Capping by PAGE rather than by count makes the cost exactly and always 1
unit, deterministically -- consistent with this feature's own "never fabricate a unit-spend number"
requirement.

**Slice 9C (`docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md`, 2026-09-27) -- search.list-based
discovery, minimal by design.** Full detail lives in the plan doc and `docs/SYSTEM_MAP.md` §2.9v;
the one architectural point worth recording here: `market_discovery_candidates` is a **lifecycle
table** (rediscovery refreshes `lastSeenAt` -- since Phase 13 also `title`/`reasonDiscovered`, restarting
their 30-day clock -- never duplicates a row or resets an operator-set `status`), architecturally unlike 9A/9B's append-only snapshot/run tables -- it is closer in shape
to `research_channels` itself than to `market_channel_snapshots`. Its own run-log
(`market_discovery_runs`) is a separate table from 9B's `market_intelligence_collection_runs`
(that one's `research_channel_id` is `NOT NULL` and FK'd to the watchlist, which a discovery run
-- not about any one watchlisted channel -- cannot satisfy). Originally both fed one shared daily
budget (owner decision 2); since Phase 13 slice 13.4 `search.list` has its own bucket (100 calls a day,
`countMarketDiscoverySearchesSince`) and `getMarketIntelligenceUnitsSpentSince` sums collection only.

**Discover rework (BL-145, 2026-10-07, owner msgs 1900/1904/1905; analysis `docs/roadmap/plans/RESEARCH_DISCOVER_ANALYSIS.md`).**
Two search modes. *By genre* (default, `discoverChannelsByGenre`, `POST /discover {mode:"genre", publishedWithinDays?}`):
one `search.list type=video videoCategoryId=10` (1 call of the 100-searches bucket, up to 50 videos, optionally only the
last 30/90/180/365 days), grouped by channel, most matches first; auto-generated "… - Topic" channels are left out (title
suffix -- YouTube has no API flag); each channel gets `match` (videos matched, their total views via one `videos.list`,
the query). *By channel name* is the original `discoverChannels`. Both then record each found channel's public counts
(`stats`: subscribers or hidden, videos, views, creation date, observed-at) with one `channels.list` per 50 (1 pool unit)
-- best effort, a failed lookup never fails the search. Schema v65 adds those columns; the 30-day purge blanks them with
the title; a re-found candidate drops its older counts/match before they are re-observed, so nothing older than its
`last_seen_at` is ever served. The lookups' pool units are recorded on the search's run row (`pool_units_spent`) and
count in the Research daily unit budget; with no room left they are skipped. Searches no longer require that budget to
be set (the search itself never spends it); a search is logged in the quota history as "Research search", and
`countsAgainstPool` (youtube-quota) keeps `search.list` out of every 10,000-unit pool total (Settings bar, quota
guard, quota history). An agent's research request is limited to 200
characters like the search; on approval the found candidates are assigned to the requesting channel (approve route).
Discover offers Track (= promote, reason pre-filled from the query), Ignore and Archive; the old "watching" status is
no longer offered. Known gap, not fixed here: `videos.batchGetStats` returns no duration, so video durations are empty
(BL-146).

**Slice 9D (`docs/roadmap/plans/PHASE_9_SLICE_9D_PLAN.md`, 2026-09-27) -- historical intelligence,
code-complete with no calling code yet (`historical-intelligence.ts`, mirroring 9A's own
`derived-metrics.ts` at that same stage).** The one architectural point worth recording here: every
comparison this file makes is **age-normalized by construction**, never a raw lifetime-view
comparison -- `ChannelVideoBaseline` and the video argument to `assessBreakout` both carry an
explicit `dayOffset`, and the function refuses the comparison outright when they don't match, rather
than silently comparing across mismatched ages. This closes a real defect advisor review found
before merge: an earlier draft computed a channel's baseline and a candidate breakout video from
raw, un-normalized total view counts, which made every old video look like a "breakout" purely by
having had more time to accumulate views -- a direct violation of spec §9's "avoid comparing old and
new videos only by total views" one level up, at the baseline-comparison layer rather than the
single-video layer the spec text names literally. `computeAgeNormalizedViews` additionally rejects a
snapshot that is merely the *closest available* candidate for a target day-offset when it falls
outside a tolerance window (`max(1 day, 25% of dayOffset)`), returning `insufficient_history` rather
than silently mislabeling, say, a day-30 snapshot as "day 7" data. Real service/API/UI wiring over
these functions, and live verification against real accumulated multi-day history, are both
out of scope here (BL-105) -- this slice ships only the pure comparison logic, hand-tested against
synthetic fixtures derived from the spec, not from the implementation.

**Slice 9E (`docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md`, 2026-09-27) -- manual/structural topic and
trend model, two parts.** Part A (`market_topics`/`market_topic_assignments`) is a plain manual
tagging layer: a topic is a name an operator declares by hand, assignable to either a watchlisted
channel or a bare video id, with no AI classification anywhere in this slice (an explicit exemption
from owner decision 3's AI-connection gating, since nothing here calls an AI provider at all).

Part B (`market_trend_candidates`/`market_trend_evidence`) is where spec §14's "do not allow
lifecycle labels to exist without supporting observable rules or evidence" becomes a structural,
not merely documented, constraint: `createTrendCandidate`'s own input schema requires an
`initialEvidence` object, so there is no code path in this module that can create a trend candidate
with zero evidence rows. The same discipline extends to status changes -- `updateTrendCandidateStatus`
requires a non-empty `reason`, which the service layer writes as a `"signal"`-type evidence row in
the exact same action as the status change (advisor review, before implementation: "every status
change should require a reason, written as a signal evidence row in the same action"), so a status
can never move without a corresponding entry in that trend candidate's own evidence history.
`lastObservedAt` is deliberately only ever moved by an evidence write (including the evidence row a
status change itself produces), never by a bare status mutation alone -- there is no code path that
advances `lastObservedAt` without also appending to the evidence trail that justifies it.
`market_topic_assignments.subjectId` deliberately carries no foreign key (a single column cannot
conditionally reference two different tables depending on `subjectType`, and a video has no
canonical single-row table to reference in the first place); `deleteMarketTopic` cascade-deletes its
own assignments but only detaches (`topicId` set `NULL`, never deletes) any trend candidate tagged
with the removed topic, since losing a label should never destroy an otherwise-independent trend
candidate's own evidence history.

**Slice 9I (`docs/roadmap/plans/PHASE_9_SLICE_9I_PLAN.md`, 2026-09-27) -- shared data-quality
vocabulary (owner spec §27), taken ahead of 9F/9G/9H per advisor review.** Code-complete, no calling
code yet (`data-quality.ts`, mirroring 9A's `derived-metrics.ts`/9D's `historical-intelligence.ts`
at that same stage). The one architectural point worth recording here: a new `DataQualityFlag` union
(`contracts.ts`) collapses several previously-independent, bespoke local shapes (9A's
`hiddenSubscriberCount` boolean, 9D's `basis` return value, 9B's `"skipped_quota_limited"` status,
9C's partial-progress-before-failure counts) into one name other code can pattern-match on, rather
than each module keeping its own ad-hoc vocabulary indefinitely. **A documented spec/API-capability
discrepancy, not a silent drop (`AGENTS.md` §A):** the union has seven entries, not the spec's
literal eight -- `deleted_video`/`private_video` are collapsed into one `video_no_longer_public`.
**Correction (2026-09-27, later the same day; the original claim below was overstated):** this
slice's own plan doc and an earlier version of this section both said the two were "verified" as
indistinguishable against the API's documented behavior. Re-checked directly: the official
`videos.list` docs do not describe per-id behavior for a multi-id request at all (confirmed by
fetching that page, not assumed), and `playlistItems.list` (the other call 9B's own collector makes)
has a `status.privacyStatus` field whose behavior for a since-deleted video is likewise undocumented
there. The premise that a private video is never visible to an unauthenticated/public caller is
solid (YouTube's own access model), but the stronger claim -- that this codebase's specific call
pattern genuinely cannot tell "deleted" from "private" -- is **not documented and not live-verified**
(would need a real API call against a known deleted vs. known private video id, which spends real
quota and was not authorized for this purpose). The seven-entry union and the `video_no_longer_public`
collapse stand as this module's own design choice either way (still the more honest option
absent a confirmed distinguishing signal), but the discrepancy note should say "undocumented,
unverified," not "verified." `MARKET_INTELLIGENCE_STALE_WINDOW_MS` moved from a private `services.ts`
constant to `contracts.ts` so this module's own staleness threshold and 9B's real
collection-staleness check share the exact same value, never two copies that could drift.

**Slice 9G, part A (`docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md`, 2026-09-27) -- agent read
surface, taken as a plain READ-class extension before the approval-integrity part B (advisor
review's explicit split).** `getWatchlistEntryContext` -- the single implementation both MCP's
`query_market_intelligence` and CLI's `agent market-intelligence` already shared -- gained
`channelSnapshots`/`videoSnapshots`/`topicAssignments` and a derived `dataQualityFlags`, additive to
its original `{channel, evidence}` shape. This is 9I's own first real caller, exactly as that
slice's plan anticipated. A new `agent_list_market_records` MCP tool/`agent market-records --kind
<kind>` CLI command covers topics/trend candidates/discovery candidates through one tool with a
`kind` discriminator rather than three separate ones (owner spec §28's own "prefer a small number
of powerful composable MCP tools"), as a thin fan-out over the module's own already-existing
`listTopics`/`listTrendCandidates`/`listDiscoveryCandidates` -- no new service logic. Both stay
global and unzoned, explicitly citing slice 4's own precedent rather than leaving the exemption
implicit (`docs/DEVELOPMENT_PLAYBOOK.md` §6.7 point 6 otherwise requires `assertActiveChannel`
channel-scoping for every MCP tool by default). One new, narrow `db.ts` read,
`getLatestMarketIntelligenceCollectionRunForChannel`, fills the one per-channel gap that table
never had (only the aggregate `getMarketIntelligenceUnitsSpentSince` sum existed) -- used to derive
`missing_snapshot`/`quota_limited` for that channel's own most recent collection attempt.
`AGENT_API_VERSION` bumped to `0.12.0` for the new capability; no `ZONED_CAPABILITIES` entry, since
READ-class tools in this codebase are never zoned.

**Slice 9G, part B (`docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md`, 2026-09-27) -- agent-
created research requests, this codebase's first agent-facing DRAFT-class capability with a real
approval gate (owner spec §29).** Two templates existed to choose from, and the choice matters: this
module's own `content-proposals` is deliberately write-once with no approval workflow at all (its
own contracts.ts doc comment says so explicitly), while `changesets` already has a full
`approvalStatus` model whose `approveChange`/`rejectChange` actions are, by direct inspection,
registered as neither an MCP tool nor a CLI command anywhere -- approval is reachable only through
the Web UI's own API routes. This slice copies that second shape, not the first: an agent may only
create a `market_research_requests` row (`status: "pending"`); moving it to `"approved"`/
`"rejected"` exists ONLY as a Web UI action, enforced not just by omission but mechanically -- a new
inventory test (`market-research-request-approval-inventory.test.ts`, styled after
`write-path-inventory.test.ts`) scans every source file under `src/mcp/**`, `src/cli/**`, and
`src/lib/agent-operations/**` and fails if any of them references the approve/reject actions by
name, with `src/app/api/**` (where the real routes live) the one deliberate exemption.

Approval is one atomic conditional transition (`UPDATE ... WHERE status='pending' ... RETURNING`,
the same shape `claimStaleResearchChannelsForCollection` already established in this module) --
proven against the real libsql driver with a literally-concurrent `Promise.all` pair, not only
against a fake store (RISK-70's own resolution already showed a fake store proves nothing about
real atomicity). `monitorDurationDays` (spec §29's own "Monitor for 30 days" example) is stored and
returned but never read by any code path that decides whether/when to run anything -- the concrete,
structural reason this cannot become the "unlimited collection jobs" the spec explicitly forbids:
there is no scheduler anywhere in this application for such a field to feed.

**The one design correction worth recording (advisor review, before implementation):** the first
draft of this slice ran its `discoverChannels`-equivalent quota/reads preconditions AFTER the
`pending -> approved` transition. Since the operator-set daily quota budget defaults to `null`
(never a hardcoded value, an explicit owner decision from Part II's own gating decisions), that
would have made the FIRST approval on any fresh install fail unconditionally and permanently, with
the request stuck in `execution_failed` and no path back to `pending`. The corrected design extracts
`discoverChannels`'s own upfront precondition check into a shared helper
(`assertDiscoveryPreconditions`) and calls it BEFORE the atomic transition -- a missing/exhausted
budget now leaves the request genuinely untouched (still `pending`), and the real `discoverChannels`
call afterward re-runs the same check anyway (cheap, intentional defense-in-depth against a race
between the two).

**Slice 9H, part A (`docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md`, 2026-09-27) -- Channels
intelligence view, the first real caller either `derived-metrics.ts` (9A) or `historical-
intelligence.ts` (9D) has had since they shipped.** Two new UI-only service actions compose EXISTING
reads/pure functions rather than extending any existing MCP/CLI-facing contract:
`getChannelIntelligenceSummary` calls `getWatchlistEntryContext` internally and layers computed
subscriber velocity, upload cadence (the same `computeSnapshotVelocity` call's `videoCount` field),
per-video breakout assessment, and an emerging-channel verdict on top; `listTrendCandidatesWithFreshness`/
`getTrendEvidenceSummary` do the same over `listTrendCandidates`/`getTrendEvidence` (the latter
renamed from `listTrendEvidence` once this same slice's own PHASE9-INV-02 widening flagged it as
sharing its db.ts counterpart's exact name -- see the module's own `write-path-inventory.test.ts`).

**The one architectural point worth recording is the breakout baseline's own methodology choice,
found necessary by advisor review before implementation:** each recent video is compared against a
**leave-one-out** baseline -- the median of every OTHER recent video's own age-normalized view count,
never including the video itself. Including a video in its own baseline biases the comparison exactly
when it matters most: with a small recent-video sample, a single genuine breakout can pull the
baseline itself upward, partially masking the very signal being measured. The concrete disagreement
this was pinned against (also this slice's test fixture): four videos with day-7 age-normalized views
`[10, 20, 30, 65]` -- leave-one-out gives the video at 65 a baseline of 20 (median of the other
three) and a ratio of 3.25 (a breakout, `>= BREAKOUT_RATIO_THRESHOLD`); include-self gives it a
baseline of 25 (median of all four) and a ratio of 2.6 (not a breakout). The cost of the more
defensible method is stated plainly, not hidden: leave-one-out needs `BREAKOUT_MIN_BASELINE_SAMPLE_SIZE`
(3) OTHER recent videos, i.e. 4 total, before ANY video can get a verdict at all.

`RECENT_VIDEO_WINDOW_DAYS` (180, not a narrower window) is itself a considered choice, not an
arbitrary round number: this application's only collection trigger is a dashboard page load
(`collect-if-stale`, gated to at most once per 24h per channel, no background scheduler exists;
since BL-139 it also waits until device sync has caught up, §23) --
a video's own day-7 age-normalized point only exists at all if a collection run happened to land
within `ageNormalizedTolerance(7)` (`max(1, 7*0.25)` = 1.75 days) of its 7-day mark. A monthly-or-
slower-uploading channel needs a wide `RECENT_VIDEO_WINDOW_DAYS` just to have a realistic chance at
the 4 qualifying videos leave-one-out requires; widening this window costs nothing, since a video
lacking a usable point simply reports `insufficient_history` (via `computeAgeNormalizedViews`) and is
excluded from every other video's baseline sample, never fabricated. The four named constants driving
all of this (`CHANNEL_VELOCITY_WINDOW_DAYS`, `CHANNEL_BASELINE_DAY_OFFSET`, `RECENT_VIDEO_WINDOW_DAYS`,
plus 9H's own new `TREND_EVIDENCE_FRESH_WINDOW_DAYS` for Trends) are exported from `services.ts` and
returned to the client inside `getChannelIntelligenceSummary`'s own `methodology` field, rather than
hardcoded a second time client-side where they could drift -- shown in the UI next to the figure each
one produced, since an unstated methodology is exactly the "opaque score" owner spec §11 forbids.

`getChannelIntelligenceSummary` deliberately does NOT return `getWatchlistEntryContext`'s own
`videoSnapshots` array -- an unbounded, append-only series (tracked as RISK-78, `docs/TECHNICAL_
DEBT.md`, since this is the first time anything renders it to a human rather than an agent
making one bounded MCP call) that must not ship over the network in full merely because the DOM
rendering of it is bounded. `latestSnapshotPerVideo` (one row per distinct video, computed
server-side) replaces it for the main view; a separate `getChannelVideoSnapshotHistory` action
(its own new route) serves one video's own full series on demand, filtering server-side before
returning so the bounded response, not just the bounded render, is the actual fix.

**Slice 9H, part B (`docs/roadmap/plans/PHASE_9_SLICE_9H_PART_B_PLAN.md`, 2026-09-27) -- Market
Overview, aggregating part A's own per-channel composition across the WHOLE watchlist.** A new
`getMarketOverview()` action calls `getChannelIntelligenceSummary` once per watchlisted channel and
folds the results into `breakoutVideos`/`emergingChannels` (filtered to `isBreakout`/`isEmerging`,
each entry tagged with its own `channelId`), alongside two watchlist-independent reads
(`listDiscoveryCandidates` filtered to `status: "new"`, and a direct passthrough of
`listTrendCandidatesWithFreshness`). No existing action's output schema changes -- the same
"compose, don't extend" precedent part A established.

Two findings from this slice's own pre-implementation advisor review are worth recording structurally,
since both are the kind of gap that is easy to reintroduce in a future aggregation over this same
data: (1) **a channel-level `DataQualityFlag` is not automatically a "collection warning"** --
`hidden_subscriber_count` is a property of the channel (the owner hides it on YouTube), not a
collection-freshness problem, so `getMarketOverview` narrows the flag set it surfaces here to exactly
`stale_observation`/`quota_limited`/`missing_snapshot`, never the full seven-value vocabulary. (2)
**"never observed" produces no flag at all from `assessObservationFreshness`/`assessSnapshotCompleteness`**
(both explicitly treat a `null` last-observation as outside their own scope) -- naively surfacing only
non-empty `dataQualityFlags` would show a never-collected channel (the realistic first-render state
on a fresh watchlist, before any real collection has run) as having zero warnings, a false all-clear
that is actively worse than showing nothing. `getMarketOverview` adds its own explicit
`neverObserved: true` case for a channel with zero channel snapshots, and separately reads
`getLatestMarketIntelligenceCollectionRunForChannel` directly (one extra, already-indexed read per
channel) to surface a `"failed"` latest run immediately -- not only once `stale_observation` would
eventually fire 24h later.

A channel removed from the watchlist between this action's own `listWatchlist()` call and the
per-channel `getChannelIntelligenceSummary` fetch that follows for it (a real race, since the Remove
button lives on this same Research tab) is caught narrowly by `DomainError` code
(`RESEARCH_CHANNEL_NOT_AVAILABLE` only) and skipped -- every other error propagates unchanged, never
the broad/bare-catch pattern RISK-19/21/33 already removed elsewhere in this codebase.

Trend freshness deliberately does NOT reuse 9I's `MARKET_INTELLIGENCE_STALE_WINDOW_MS`/the word
"stale" -- that constant means "a channel collection run hasn't happened in a day," a daily-cadence
concept, while a trend's own `lastObservedAt` only moves on a human timescale (evidence added
manually, or by a future structural detector); worse, `"stale"` already names one of
`TrendCandidateStatus`'s own five lifecycle values, so a `"growing"` trend showing a `"stale"`
freshness badge would visibly contradict itself in the same UI. A new, trend-specific
`TREND_EVIDENCE_FRESH_WINDOW_DAYS` (30, a named starting point, not a claimed-correct number) and
non-colliding wording ("evidence added recently" / "no recent evidence") were used instead.

Neither `listTrendCandidates` (the `agent_list_market_records` MCP tool's own underlying call, and its
CLI counterpart's) nor `getWatchlistEntryContext`'s own output schema were touched -- both wrapper
actions call the existing action and pair its result with newly-computed fields in a SEPARATE return
shape, confirmed by a dedicated test that the original action's own output is byte-for-byte unchanged.
Explicitly out of scope for this part, and why: an "Overview" tab (needs this part's own summary as a
building block first); a "Videos" tab (`market_video_snapshots` has no `title` column -- though
`getPublicVideoSnapshots` already fetches it from YouTube at zero extra quota cost and simply
discards it today, a separately-scoped schema change); an "Opportunities" tab (needs 9F's niche
candidates, which don't exist yet); wiring `detectDisappearedVideoIds` (9I) into any UI (its own doc
comment warns against a naive two-snapshot diff, real design work belonging with the Videos tab).

**Slice 9H, part C (`docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md`, 2026-09-27/28) -- Videos
tab, closing the schema gap part B's own entry named above.** Migration v28 adds
`market_video_snapshots.title` (nullable -- `NULL` for any snapshot taken before this column
existed, never backfilled or guessed from a later, possibly-since-changed title of the same video);
`runCollectionIfStale` (9B) now passes `title` through to `insertMarketVideoSnapshot`, at zero
additional YouTube quota cost (`getPublicVideoSnapshots` already fetched it). An empty-string title
(the read gateway's own fallback when YouTube's response omits `snippet.title`) is normalized to
`null` at capture time, so "not captured" has exactly one representation, never two.

**The one architectural point worth recording is a refactor, not a new mechanism:** the per-video,
age-normalized, leave-one-out breakout assessment 9H part A built inline inside
`getChannelIntelligenceSummary` is extracted into a shared helper, `computeRecentVideoBreakouts`
(`services.ts`, module scope) -- identical logic, now called by both that action (output schema and
behavior unchanged, pinned by its own pre-existing tests continuing to pass unmodified) and this
slice's new `getMarketVideosOverview`, which needed the same methodology per video across the WHOLE
watchlist rather than reimplementing a second, drifting copy of it.

`getMarketVideosOverview` deliberately calls `getWatchlistEntryContext` directly per watchlisted
channel, not `getChannelIntelligenceSummary` (unlike part B's `getMarketOverview`) -- that action
deliberately omits the full `videoSnapshots` array (RISK-78), and this slice genuinely needs each
video's own full snapshot series to compute a per-video view-count velocity (`computeSnapshotVelocity`,
9A, reused by feeding a video's own `viewCount` series into the same `subscriberCount`/`videoCount`-
shaped function part A's own `uploadCadence` field already reuses this way). Topic/format resolution
needed a new bulk read, `listMarketTopicAssignmentsBySubjectType(subjectType)` (`db.ts`) -- the
existing `listTopicsForSubject` takes one `subjectId` at a time, and calling it once per video across
a watchlist would have been a real N+1; `getWatchlistEntryContext`'s own `topicAssignments` field is
channel-subject-only by construction and could not have served this need either way.

Adding `title` to `marketVideoSnapshotSchema` additively widens `getWatchlistEntryContextOutputSchema`
(MCP `query_market_intelligence`/CLI `agent market-intelligence`'s own contract, since it already
embeds `videoSnapshots: z.array(marketVideoSnapshotSchema)`) -- a real agent-contract change, but
**not** an `AGENT_API_VERSION` bump: `src/lib/agent-operations/contracts.ts`'s own doc comment on
that constant explicitly excludes exactly this shape of change ("a new optional input/output field
an existing caller can simply ignore... not every field-level widening"), reserving MINOR bumps for
capability-discovery-relevant changes only. `getMarketVideosOverview` itself has no MCP/CLI surface.

**Research tab layout (BL-140, `docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md`, 2026-10-06).** The tab is a summary
line plus five always-mounted sub-tabs (`src/components/research-tab.tsx`: Inbox, Channels, Videos, Discover, Topics &
trends); the Overview panel is gone. The summary line (`GET /api/market-intelligence/summary`, polled) reads
`getResearchSummaryCounts`, which needs no video series. Whether a channel "needs attention" is one rule,
`classifyCollectionStatus` over `readCollectionState`'s flags, shared by the summary count, the Channels status and
`getMarketOverview`'s collection warnings, so a count and the list it links to always agree.
Lists that can grow are bounded on the server: Videos (`videos-overview?page=…`, R2) and Discover candidates
(`discovery-candidates?page=…&status=…`, R4) return one page; both keep their old unpaged response when `page` is
absent. Channels reads one row per watchlist channel from `getWatchlistTable` (`GET /api/market-intelligence/
watchlist-table`, R3) -- only observed values with their dates, a status from the same data-quality flags
`getMarketOverview` counts as warnings, no derived metric. Record details open in the shared `side-drawer.tsx`; the
per-record "visible to agents" chip editor lives only in a drawer, lists show a pill (`useMarketAssignments`/
`VisibleToPill` in `market-channel-assignment.tsx`, one read per record kind). Web routes only: no MCP tool, schema
or agent contract changed.

## 19. Decision & Experiment Engine (`src/lib/decision-engine/`) — Phase 10, slices 1-5

Owner instruction, Telegram 2026-09-29: an explicit assignment to plan and implement Phase 10
(`docs/roadmap/FUTURE_PHASES.md` §6). **Detailed design, transition rules, and acceptance
criteria live in `docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md` and `docs/SYSTEM_MAP.md` §2.9w --
this section states only the architectural decisions worth recording permanently here.**

**Approval lives on the experiment, not a separate entity.** The first-pass plan document
(2026-09-20, planning only) sketched a `decisions` table conflating approval
(`approvedBy`/`approvedAt`) with outcome recording into one row. Re-reading `FUTURE_PHASES.md`
§6's own "Core entities" list before implementing found this doesn't match the actual
requirement: `Experiment` itself carries "approval status" as one of its own fields, and
`Outcome`/`Retrospective` are named as entities distinct from approval, not folded into it. This
slice follows §6 over the older sketch, `experiments.status` (`proposed → approved → running →
concluded|abandoned`) being the one place approval lives, transitioned only through one atomic
`UPDATE ... WHERE status IN (<valid predecessors>) ... RETURNING` function
(`transitionExperimentStatusIfValid`) -- the same shape Phase 9's
`approveMarketResearchRequestIfPending` already established for exactly this "two tabs race to
approve the same row" class of bug.

**Outcome is its own append-only table, gated by status.** `experiment_outcomes` never gets an
update/delete function (mirrors `market_channel_snapshots`'s append-only shape) -- a correction is
a new row, never an edit, which is what §6's "an AI agent may never silently rewrite a past
outcome" requires structurally. Recording one is only accepted for `running`/`concluded`/
`abandoned` experiments; a `proposed`/`approved` one has not actually run yet, so an "outcome" for
it would be fabricated, not observed.

**Structural isolation test deliberately differs from Phase 9's own `PHASE9-INV-02` pattern.**
That test scans whole-file text for forbidden substrings, which relies on Phase 9's table names
(`research_channels`, `market_channel_snapshots`) being unlikely to appear anywhere else by
coincidence. This module's table names (`hypotheses`, `experiments`) are plain English words that
really do collide -- with unrelated prose comments elsewhere in the repo, and with this module's
own public service-layer method names and JSON response keys (`{ hypotheses }`). `decision-engine-
inventory.test.ts` instead parses actual `import { X } from "@/lib/db"` specifiers and checks only
those against the forbidden list, immune to all three collision classes while still catching the
one real violation this test exists to prevent.

**Built as its own follow-up slice (2026-09-29):** an MCP/CLI agent surface --
`docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md` -- `agent_list_hypotheses`/
`agent_get_hypothesis_trail` (READ) and `create_experiment_proposal` (DRAFT, the reserved
capability name, always `status: "proposed"`, gated like `agent_create_market_research_request`).
Creating a hypothesis from scratch, transitioning an experiment's status, and recording an outcome
remain Web-UI-only, mechanically verified (`decision-engine-agent-approval-inventory.test.ts`).

**Evidence auto-linking (slice 3, 2026-09-29) references Phase 8/9 data without ever importing
either module from `decision-engine/**` itself.** `hypothesis_evidence` (SCHEMA_MIGRATIONS v30,
append-only) stores a structured, discriminated-union reference (`phase8_metric`/
`phase9_channel_snapshot`/`phase9_video_snapshot`/`phase9_trend_candidate`) alongside the existing
free-text `evidenceNotes`, validated -- does the referenced row actually exist -- at creation
time only, never re-checked at read time. The validation logic itself is an
`EvidenceReferenceResolver` **port** (`decision-engine/contracts.ts`, a plain interface with no
implementation): `decision-engine/services.ts`'s `addHypothesisEvidence` takes an
already-constructed resolver as a parameter, and the one real implementation
(`createRealEvidenceReferenceResolver`, `src/app/api/decision-engine/evidence-reference-
resolver.ts`) is built entirely OUTSIDE `decision-engine/`'s own directory, taking
`analyticsCore`/`marketIntelligenceCore` as constructor arguments (never module-level singletons,
which is what makes it independently testable against fakes). This is the identical shape
`PHASE_9_PLAN.md` §5 already established for market-intelligence itself ("no existing route/
service/component may take a hard dependency on market-intelligence's tables or services") --
applied here in the reverse direction (decision-engine depending on analytics/market-intelligence,
not the other way around) via the standard port/adapter split rather than a direct import.
Mechanically enforced by a new `PHASE10-INV-03` test (`decision-engine-inventory.test.ts`),
scanning for any `@/lib/analytics`/`@/lib/market-intelligence` import inside
`decision-engine/**`. A `RESEARCH_CHANNEL_NOT_AVAILABLE` from market-intelligence (a
`researchChannelId` not on the watchlist) is caught inside the resolver and folded into the same
`false` ("this reference doesn't exist") outcome, rather than leaking a market-intelligence-
specific error code out of a decision-engine route -- a real gap found by `advisor()` review and
covered by the resolver's own dedicated test file (`evidence-reference-resolver.test.ts`), kept
separate from `services.test.ts` (which only proves delegation to a fake resolver, not that the
real one decides correctly).

**AI-generated hypothesis drafts (slice 4, 2026-09-29) reuse `ai-connections`'s transport, never
duplicate it.** `openai-compatible.ts`'s SSRF-validated, timeout/retry-bounded HTTP call
(`callOnce`) was already security-critical, protocol-transport code with zero content specific to
localization; it is now wrapped by a shared `performChatCompletion` helper that both the
pre-existing `generate` (title/description) and the new `generateHypothesis` (statement/rationale)
build on, an additive widening of `ConnectionProtocolAdapter` rather than a refactor of its public
shape or a second copy of the transport -- proven zero-behavior-change by every pre-existing
ai-connections/ai-localization test passing unmodified. `HypothesisGenerationRequest`/
`HypothesisGenerationOutcome`/`HypothesisDraftProvider` are owned by `decision-engine/contracts.ts`
(the domain shape) and imported by `ai-connections/contracts.ts`, the identical relationship
`LocalizationProvider` already has -- `decision-engine/index.ts` imports `createAiConnectionCore()`
directly, exactly like `ai-localization/index.ts` does, since `ai-connections` is shared
infrastructure, not a feature-module peer `AGENTS.md` §M would forbid a hard dependency on
(`PHASE10-INV-03` only forbids `@/lib/analytics`/`@/lib/market-intelligence`, never
`ai-connections`). **The model never sees or produces an `EvidenceReference`.** It only receives
plain-text summaries of references the operator already selected and this module already
validated (`EvidenceReferenceResolver.describe`, a new method on slice 3's own port, implemented
alongside `resolve` in the same route-layer file) -- avoiding both a fabricated-citation risk and
a second evidence-fetch path. `saveGeneratedHypothesis` mirrors `createChangeSetFromProposals`'s
own "the caller resubmits the reviewed values, the server re-validates and persists them" shape
(`AGENTS.md` §D) rather than a server-held draft referenced by id -- every evidence reference is
re-validated at save time, never trusted from generation time, since real state (a channel's
snapshot history, a candidate's lifecycle status) can change in between. AI authorship is recorded
in a new, separate `hypothesis_generation_provenance` table (SCHEMA_MIGRATIONS v31, append-only) --
`createdVia` (mcp/cli/web_ui) is transport, and cannot represent "the AI wrote this text, a human
may have edited it before saving," the same reason `aiLocalizationGenerationProvenance` exists as
its own table rather than overloading an existing column. `editedBeforeSave`/`evidenceRefCount`
are computed server-side from the request, never trusted as caller-asserted fields. The draft route
(`/hypotheses/generate`) persists nothing and is `proxy.ts`-exempt exactly like
`/ai-localization/generate`; the save route (`/hypotheses/generate/save`) persists a real
hypothesis and stays behind the ordinary mutation gate. No real, non-mock AI provider call was made
in this session -- validated only against the mock adapter and an injected `fetchImpl` fake,
per `AGENTS.md` §K.2's separate gate on a real paid AI API call.

**Execution of an approved, localization-type experiment (slice 5, 2026-09-29) reuses the existing
Change Set/Batch pipeline unchanged -- no new write path.** Owner-confirmed scope, three explicit
safety questions answered before this slice started (Telegram): only localization-type experiments
get real execution (the only type with an existing execution interface); approval alone never
triggers it (a separate, explicit Execute action is required); execution never bypasses an existing
gate (Live Writes, identity, dry-run) -- it is one more caller of `createBatchCore().createBatch`,
never `prepareBatchExecution`/`executeBatch`. `experiments` gained `changeSetId`/`executionBatchId`/
`executionClaimedAt` (SCHEMA_MIGRATIONS v32) -- **deliberately no FK** on the first two: `change_sets`
rows are really deleted (`change-drafts/services.ts`'s `discardLocalAndAdoptPeer`, RISK-46's
divergent-lineage flow), and this connection runs with `foreign_keys=ON`, so an FK would break that
unrelated delete; validated at the application level instead, the same "no FK for an informal
reference" pattern RISK-66 already accepts. Execution is a second cross-module dependency in the
same shape as slice 3's evidence resolver: `ExperimentExecutionResolver` (`contracts.ts`) is a port
`decision-engine/**` depends on but never implements; the real implementation
(`experiment-execution-resolver.ts`) lives outside that directory, the only place allowed to import
both `@/lib/decision-engine` and `@/lib/changesets`/`@/lib/batches` (`PHASE10-INV-03` widened to
forbid both inside `decision-engine/**`, alongside the pre-existing analytics/market-intelligence
ban). **The execution design went through two real `advisor()`-caught redesigns, not one.** The
first draft called the resolver (creating a real Batch) BEFORE any atomic guard -- two concurrent
Execute calls could both create one, an exact repeat of the RISK-68 anti-pattern this project
already knows to avoid, not the claim-first pattern it was meant to copy. Redesigned claim-first,
mirroring Phase 9 slice 9B's `claimStaleResearchChannelsForCollection` exactly: an atomic claim
(`execution_claimed_at`, exclusive against another FRESH claim but reclaimable once stale --
`EXPERIMENT_EXECUTION_CLAIM_EXPIRY_MS`, the identical 15-minute precedent) taken BEFORE the resolver
is ever called. The second round found the claim alone wasn't sufficient: `transitionExperimentStatusIfValid`/
`setExperimentChangeSetIfEligible` never checked it, so an Abandon or a detach could land inside the
claim window and `finalizeExperimentExecution`'s then-unconditional write would resurrect a terminal
state back to `"running"`. Both functions now refuse while a fresh claim is held (still permitting
the action once the claim is stale/expired -- a crash must never permanently lock the experiment out
of its own lifecycle); `finalizeExperimentExecution` is now guarded by the exact claim timestamp and
clears the claim in the same write (required so the claim-freshness guard above doesn't then block
the experiment's own normal `running -> concluded/abandoned` transitions); and finalize was moved
OUTSIDE the resolver's own try/catch, so a finalize failure never releases a claim whose Batch
already exists (which would let a second call create a second real Batch for it) -- it self-heals
only via the same 15-minute expiry, a narrow, documented residual (`docs/TECHNICAL_DEBT.md`
RISK-82). `dryRun` mirrors the existing Batch-creation route's own fail-closed gate exactly
(`getLiveWritesEnabled()`, `live: true` in the request honored only when that toggle is already on)
-- the route is an injectable factory (`createExecuteExperimentHandler`) specifically so this
wiring itself has a test, not just the service's own boolean-in/boolean-out logic. The response
(and the UI) surface `dryRun` explicitly, so the operator can tell "dry-run Batch" from "LIVE
Batch" rather than the outcome being silent.

**Still not built, named explicitly rather than silently deferred:** agent-created hypotheses from
scratch (`create_hypothesis`, the reserved extension point left after slice 2); recording an
outcome/retrospective through MCP/CLI; execution of any non-localization experiment type (no
execution interface exists for one yet); MCP/CLI exposure of Change Set attach/execute (a
Batch-creating agent action is a materially different risk category than slice 2's read+draft
surface, needs its own separate assignment); evidence selection during AI generation is not yet
exposed in the Web UI (fully built and tested at the
API/service layer -- the "Generate with AI" panel is notes-only for this first UI pass, evidence
still attaches to a saved hypothesis through the existing, separate evidence form).

## 20. Channel Workspaces (`src/lib/channel-workspaces/`) — Phase 11, in `dev` (`f15a8c3`)

Scope comes from `docs/roadmap/FUTURE_PHASES.md` §11. The plan and acceptance criteria
(AC-P11-01..14) are in `docs/roadmap/plans/PHASE_11_PLAN.md`. The agent-facing contract is in
`docs/AGENT_OPERATIONS_INTERFACE.md` §4m.

**What it is.** One operator-set absolute local path per (device, linked channel): that
channel's production-workspace folder on this machine. This product's responsibility ends at
the path string. It never enumerates, reads, writes, or validates anything inside the folder.
The operational agent uses its own native filesystem tools. There is therefore no file-access
surface on this side to secure. Validation of the path itself happens once, at set time.

**Exception (BL-119, ADR 0019):** `src/lib/research-export/` (a separate module; this one keeps its contract) writes generated files into the fixed `99 Data Exchange/From YTM` subfolder of this path (owner-approved exception, 2026-10-04) when the agent asks for a research export — it re-validates the path, refuses a symlinked `exports`, names every file itself, and deletes its own expired files by ledger (`workspace_export_files`). Nothing else under the path is opened.

**Data flow.**
- *Operator writes.* Settings → Channels row → `ChannelWorkspaceField` → `PUT /api/channel-workspaces`
  → `setWorkspace`. That call checks, in order:
  1. The channel is one of `channel-connections`' connected channels.
  2. `local-path-validation` passes: the path is absolute, exists, is a directory, and does not
     overlap app-data in either direction (the RISK-07 reasoning from slice I).
  3. Only then does it upsert `channel_workspaces`.
- *Agent reads.* MCP `agent_get_channel_workspace` or CLI `agent channel-workspace` → identity
  resolution + `assertActiveChannel` → `getWorkspace`. The read is a store lookup that never
  touches anything at or under the workspace path (no path-validation or directory dependency is
  injected into it). The only other file it touches is this app's own `bootstrap-config.json`,
  read for the `deviceId`, and only ever read: with no config yet the answer is
  `{ configured: false }`. Only the operator write may create it (review round 1).
  Creating the file is now exclusive: `bootstrap-config`'s `ensureExists` writes a temp file and
  hard-links it into place, and if another caller wins the race it reads the winner's file
  instead (review round 2). Before this, two concurrent first calls could produce two different
  `deviceId`s, which would orphan a just-saved workspace row. On a filesystem without hard-link support it
  falls back to the previous rename-based creation. Temp-file cleanup is best-effort (review
  round 3). No agent surface receives
  `setWorkspace`: the MCP and CLI factories take a `Pick<…, "getWorkspace">`.

**Storage and device-locality.** `channel_workspaces(device_id, channel_id, path, updated_at)`,
primary key `(device_id, channel_id)`, SCHEMA_MIGRATIONS v33 (additive).
- §11 requires the value to be "device-local, never synced, keyed on this app's existing
  `deviceId`". So every read and write filters on the bootstrap `deviceId`. A row that arrives
  by some path other than this device's own writes (for example, a `data.db` copied between
  machines) is invisible rather than silently reused.
- The table is deliberately absent from `SNAPSHOT_TRANSFERRED_TABLES` (the reasoning is in the
  "never listed" block of `snapshot/contracts.ts`) and from `sync-gateway`.
- A snapshot-import test proves the receiving device's own rows survive untouched.
- Note: `cloud_connection` has no device column. It is device-local only through snapshot
  exclusion, so it is not the precedent for the `deviceId` key. §11's own wording is.

**Security posture: a deliberate reversal from slice I.** `operations-instructions` (§4j) never
exposes its configured absolute base path to the agent, because that would leak host layout and
the username. Phase 11's deliverable is exactly that absolute string. The owner requested it
explicitly in §11. The exposure is bounded:
- Only to an agent whose `channelId` is the caller's active channel.
- Only the one string the operator chose.
- Never any directory contents.

It is recorded here rather than carried silently (`AGENTS.md` §F).

**Module independence (`AGENTS.md` §M).**
- The set-time check lives in the shared `src/lib/local-path-validation/`, moved verbatim from
  `operations-instructions`, which re-exports it unchanged.
- MCP and CLI take `channelWorkspacesCore` directly rather than through `agent-operations`,
  the same pattern as market-intelligence and decision-engine.
- The UI field sits in its own error boundary inside each channel row.

**Deliberately not implemented.**
- The Workflow Registry (dropped by the owner).
- Any read-time re-validation. It would be meaningless, because nothing here ever opens the path.
- Cleanup of a row when its channel is disconnected. The row stays, is hidden from the Settings
  list, and reappears if the channel is reconnected.

## 21. Channel-bound agent isolation — Phase 12, in `dev` (`7a57a48`)

Plan, the inventory of holes it closes, the owner decisions (D0–D5) and the acceptance criteria:
`docs/roadmap/plans/PHASE_12_PLAN.md`. Interface contract: `docs/AGENT_OPERATIONS_INTERFACE.md`
§4n.

**Why choke points.** Before this phase, channel scoping rested on one mutable column,
`users.selected_channel_id`, shared by the Web UI and every agent. Agents could repoint it
(`write_channel_select`) or sidestep it with a caller-supplied `credentialRef`. Instead of adding a
check to each of 57 MCP tools and roughly 70 CLI commands, a per-request immutable scope
(`src/lib/agent-session`, an AsyncLocalStorage leaf; process-wide before ADR 0013) is consulted at the two functions every path already
funnels through:
- `db.ts`'s `getSelectedChannelId` / `setSelectedChannelId`: the bound channel, and a no-op
  write. The no-op is not an error, because `apply` and playlist writes persist the selection
  *after* a successful YouTube write.
- `cli-auth`'s `resolveEffectiveCredentialRef`: always the token's identity, and explicit refs
  rejected.

Every pre-existing `assertActiveChannel` and write-context identity check then enforces the
binding without modification. The few reads that never called `assertActiveChannel` (`list`,
`transcript`, `preview`, `channel_sync`'s explicit id) are wrapped once in their core wiring.

**Identity.** A channel token (`src/lib/agent-tokens`) is the only agent identity.
- It is a SHA-256 hash with the `ytom_ch_` prefix, stored device-locally. Since BL-130 (ADR 0024) the plaintext is
  `ytom_ch_<channelId>.<secret>`; verification also requires the embedded id to equal the row's channel (legacy tokens
  without it still verify). The operator can register an already-issued token on another device (`importToken`, same
  identity check as issuing, only into the embedded channel). Since BL-160 (ADR 0033, §34) tokens and revocations also reach every
  device through the `agent-tokens` sync family, so a revocation is no longer per device (RISK-108 resolved).
- It records the Google identity that owned the channel live at issue time; credentials come
  from there, never from `channels.connected_user_id`.
- The token is verified once at process entry, which enters the scope, and re-verified on every
  MCP call so revocation is immediate.
- BL-091 zones and `AGENT_CONNECTION_ID` are retired (ADR 0011). The tables stay, inert.

**Market data (D1).** Phase 9 data stays global and unaware of channels. `src/lib/market-assignments`
(table `channel_record_assignments`, v35, part of the snapshot) maps records to channels, and the
MCP/CLI market handlers narrow results for agents. Its `db.ts` exports avoid the words
"market"/"research" so PHASE9-INV-02 continues to guarantee that no other module reaches into
market-intelligence's own tables.

**Surface.** `src/mcp/tool-classification.ts` classifies every MCP tool as `bound` or
`operator-only`; an inventory test compares it with `server.ts`'s `registerTool` names. The CLI no
longer has an agent mode: it is the operator's tool and runs only under the "Operator CLI access"
setting (default off).

**Transport (`docs/decisions/0013-in-app-http-mcp-transport.md`, reverses D0(b)).** The running app
serves MCP at `POST /api/mcp` (`src/lib/agent-mcp-endpoint`, a thin route over it): stateless
Streamable HTTP, a fresh `McpServer` per request, the "MCP connection" toggle and the channel token
read on every request, a loopback `Host`/`Origin` guard, and the whole web server bound to
`127.0.0.1`. The request runs inside an `AsyncLocalStorage` agent scope (`src/lib/agent-session`);
because "no scope" means operator mode in the web process, every tool call first asserts the ambient
scope equals the request's token. `src/proxy.ts` exempts `/api/mcp` from the device-mutation gate
(every MCP call is a POST); mutating tools keep their own gate.

**Accepted limit (RISK-87).** The agent still runs as the operator's OS user, so the wall is in-app:
an agent that deliberately finds and opens `data.db` can bypass it. What changed is that the agent's
own configuration no longer contains the project path. Mitigations: `docs/AGENT_ISOLATION_SETUP.md`.

**OAuth tokens at rest (12.8, owner chose the "env" key variant).** `db.ts`'s OAuth-token
functions are the only readers and writers of `users.access_token` / `refresh_token`. They route
through `src/lib/oauth-token-crypto`:
- With `OAUTH_TOKENS_ENCRYPTION_KEY` configured, values are stored as
  `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, `src/lib/shared-crypto`). Legacy plaintext rows
  are re-encrypted on first read.
- Without the key, values are stored as plaintext exactly as before. Sign-in is never blocked.
- A value that cannot be decrypted reads as "no token", so the user signs in again.

This protects against reading the database file alone. It does not protect against an agent that
also reads the key from the environment file.

## 22. Architecture audit, 2026-10-01: documented rules that were implicit

This section comes from the independent architecture audit. The fixes are in
`docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md`. The points below are the audit's
low-severity divergences, recorded here as the actual rules rather than changed.

- **`expectedChannelId` optionality (A7).**
  - Required: `playlist_update/delete/add_videos/remove_videos` and the video-details writes.
  - Optional: `apply` and `playlist_create`. When omitted, it falls back to the stored selected
    channel (in an agent session, the bound channel).
  - Every write still passes `write-context.assertWriteChannel`: the live OAuth channel must equal
    the expected one, so the fallback fails closed rather than writing blindly.
- **"Analytics day" (A8).** YouTube Analytics reports days in Pacific time; `metricDate` is a
  Pacific calendar day.
  - `comparable-age` aligns on Pacific days.
  - The staleness / daily-collection boundary uses the operator's configured timezone
    (`analyticsSyncTimezone`).
  - The data-quality "too recent" cutoff (`ANALYTICS_REPORTING_LAG_DAYS`) is computed in UTC. It
    can therefore differ from a Pacific-day boundary by one day at the edges. This is acceptable
    for a "probably not yet reported" hint, but it is not an exact reporting-day computation.
- **GET routes with a local side effect (A6).**
  - `GET /api/youtube/channel-info` persists the resolved channel as the session user's selected
    channel (ADR 0004).
  - `GET /api/cloud-connection/callback` stores the Google Cloud grant: an OAuth redirect must be
    a GET.
  - Both write device-local state only, which is never part of a snapshot. They are therefore not
    behind the method-based mutation gate. The equivalent MCP/CLI selection actions are
    operator-only and gated.

## 23. Automatic device sync (`src/lib/device-sync/`) — ADR 0012, in `dev` (`21bb583`)

**Purpose.** Removes the manual export/import from the §13 handoff without changing its
single-writer, whole-copy semantics. Plan and acceptance criteria:
`docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md` (AC-AS-01..15).

**Data flow (one tick, every 30 s, from `src/instrumentation.ts`):**

1. Gates:
   - the toggle (`device_auto_sync_enabled`) and a configured Syncthing folder that already
     exists. Automatic sync never creates it, so an unplugged or renamed external drive gives
     `folder_unreachable`, never snapshots written to a local folder no peer sees;
   - no live operation lock (a dead export's lock is cleared first) and no recovery mode;
   - an unfinished Batch in this computer's data pauses sync both ways, with a `batch_in_progress`
     notice. `hasUnfinishedBatch` checks for a `RUNNING` batch or rows
     `AWAITING_EXECUTION`/`APPLYING`/`UNKNOWN` (`CANCELLED` rows -- ADR 0016 -- are terminal and never count as unfinished). It is judged on transferred data, not on the
     device-local locks, which some abort paths leak (RISK-90). The same predicate refuses an
     unfinished copy (`refuseUnresolvedExecution`) and is re-checked inside the lock before every
     import and export.
2. The folder is scanned. Only UUID-named directories count, which excludes the sync-gateway
   folders. An unreadable or incomplete snapshot is "pending": it is retried silently and noticed
   after 10 minutes.
3. `hasUnpublishedLocalChanges`: the current content fingerprint is compared with
   `snapshot_lineage.content_fingerprint`.
   - The fingerprint is a SHA-256 over every table `SNAPSHOT_REPLACE_ON_IMPORT_TABLES` names. Rows
     are sorted by all columns, and each row is hashed as its non-NULL `column=value` pairs. A
     missing table hashes like an empty one. So rowids and physical column order do not matter, and
     a migration that adds a nullable column or a new transferred table leaves it unchanged.
   - Export records the fingerprint of the exported file itself, so a write racing the copy stays
     dirty.
   - Import records it from the live DB inside the lock.
   - An unknown fingerprint (a pre-v36 lineage) counts as dirty. No lineage counts as clean only
     when every transferred table is empty.
4. `decideSyncAction` (pure):
   - "Known" is the local head plus its ancestry: recorded `ancestors_json`, `lineage.json`, and
     parent pointers through every manifest in the folder.
   - "Newer" means other devices' snapshots that are not known. Of those, only the tips count.
   - No tips: export if dirty, otherwise idle.
   - One tip that is a fast-forward, with local clean: import.
   - A newer schema: `update_app`.
   - Anything else: divergence.
4a. **Identical-content divergence (BL-139, owner 2026-10-06; reworked after review round 1).**
   Each conflicting tip is staged exactly like an import (checksums, private copy, migration;
   fingerprint cached per snapshot id, `null` only for a newer schema).
   - A tip whose content equals the fingerprint recorded with this device's head holds nothing
     this device lacks: it and its ancestry are added to `ancestors_json` by compare-and-set on the
     head (`addLineageAncestorsIfHeadUnchanged`). Head, data and fingerprint stay, so every device
     keeps its OWN snapshot as head (retention protects it), and the decision is made again
     (export if dirty, else idle). The export carries that branch as an ancestor, so the peer
     fast-forwards.
   - A clean device with several tips that all hold the same data imports the newest one that
     continues its history (an ordinary import); the next tick absorbs the rest.
   - "This head's content" is the recorded fingerprint or, when the head is still in the folder,
     its staged file (an import purges expired API rows, so the file and the live data differ).
   - "Take theirs" carries absorbed branches into its marker's ancestors and `supersedes`, so they
     do not come back as conflicts after the choice.
   - Anything else (different content, a comparison that fails) is a divergence as before.
   An earlier version switched the head to the peer's snapshot instead; review round 1 showed it
   left the peer asking about an abandoned branch (where "take theirs" lost a row on both sides),
   a third device asking forever, and no device protecting the current snapshot.
5. Actions go through the existing `exportHandoff` / `importHandoff`. `assertStillSafe` re-checks
   the gates, and the fingerprint for an import, inside the operation lock, right before anything
   is written. In a divergence, local unpublished changes are still published on their own branch,
   so the other computer sees the conflict too.

**Resolution (human only, in the Merge tab → `POST /api/device-sync/resolve`):**
- The bell only links to the Merge tab. `DeviceSyncDivergenceCard` there shows both computers, the
  newest common snapshot, and per section (Batches/Audit/Research/Decisions/Other) the rows only
  here, only there, and changed (same primary key), from `GET /api/device-sync/divergence`
  (`runner.divergencePreview` → `diffTransferredContent`, read-only ATTACH of the staged copy).
- Both actions accept only a CURRENT conflicting peer tip.
- `keep_mine` exports with `supersede` (parent = the named tip; ancestry = every current peer tip
  and its history, plus the local one), so every peer fast-forwards.
- `take_theirs` imports with `acceptDivergentLineage`, using its own backup prefix
  `pre-take-theirs-`, which is never pruned. If this device had already published its own branch,
  it then publishes a marker: the adopted state again, with that branch as ancestors. So the peer
  sees a fast-forward.
- Resolutions never delete from the shared folder. A deletion propagates asynchronously and looks
  like "not arrived yet". Review round 2 showed two opposite resolutions made at the same time then
  left both computers "synced" with swapped data. Markers fail closed instead: both computers ask
  again.
- `lineage.json` `supersedes` lists what a resolution replaces: the peer tips for `keep_mine`, the
  own abandoned branch for a marker. It never widens the fast-forward rule. It only makes the
  receiving import keep a `pre-superseded-*` backup, which is never pruned, when its head is
  replaced.
- **Import atomicity (round 2).** Three things run inside `applySnapshotToDatabase`'s
  `BEGIN IMMEDIATE`, via hooks:
  1. "Live content still equals the pre-import backup's", plus the caller's re-checks, before
     the first DELETE.
  2. The merged content's fingerprint.
  3. The lineage pointer, before COMMIT.

  A write that lands between the backup and the merge aborts the import with
  `snapshot_local_changed_during_import`, and nothing is replaced.
- A snapshot whose data fails schema migration is remembered in the status and reported as
  `update_app`, never retried.
- All actions on one runner are serialized. The runner is a `globalThis` singleton shared by the
  scheduler and the routes.
- The decision uses exactly the fast-forward rule `verifySnapshotForImport` enforces. An
  older-build chain without `lineage.json` is caught up one direct child at a time.
- `src/lib/device-sync/convergence.test.ts` runs the resolution matrix with one folder per device
  and delayed propagation:
  - {keep, take} on A × {keep, take, none} on B;
  - sequential and simultaneous;
  - with and without further work;
  - plus a third device.

  The invariant: identical content and no notices, or someone is asked; never lost without a
  backup.

**Retention.**
- This device's own snapshots: the newest 5 plus the head.
- `pre-auto-import-*` backups: the newest 10.
- Another device's files are never touched, since Syncthing would propagate the deletion.

**Why a dedicated DB connection.** `importHandoff`'s `BEGIN IMMEDIATE` on the shared
`rawSqlClient` would absorb any unrelated in-process write issued meanwhile, such as the Live-writes
lease renewal or a draft cycle. On its own connection, such a write just waits for the busy
timeout.

**Draft cycle.** `runAllSyncFamiliesOnce` (sync-gateway) is shared by the "Sync now" route and
the scheduler. It runs every 60 s under the same gate the route gets from `src/proxy.ts`, and it is
NOT tied to the device-sync toggle (§M). Instrumentation and route bundles may not share module
state, so these are held per process via `globalThis`:
- the run-all single-flight guard;
- the three production sync cores, which keeps the existing "adopt peer" vs cycle exclusion real.

**Boot.** `initializeDatabase` takes the migration lock only when a migration is due
(`acquireMigrationLockIfDue`). It waits for a busy lock and clears a dead export's lock. Around the
migrations, `createSyncPreservingMigrationHooks` (BL-139) moves the lineage fingerprint by
compare-and-set if the device was in sync before them: every computer applies the same migrations,
so a column added with a non-NULL DEFAULT is not a local change. Both fingerprints come from the
pre-migration backup (`after` from a private copy of it, migrated), never the live DB, so a write
another process makes during the migration window still reads as unpublished.

**Automatic writes wait for sync (BL-139).** The dashboard's Market Intelligence refresh
(`collect-if-stale`) first calls `runner.syncBeforeBackgroundWrite()` (one tick, 60 s bound) and
waits only while something from another computer is arriving (a pending entry younger than the
10-minute grace), while sync is paused (`busy`), while the folder is unreachable, while a
divergence notice is open, or while `update_app` says the other computer's data cannot be loaded
yet. A stuck transfer and `error` have their own notices and do not block it; any tick clears a
reason that no longer applies. A skip is saved as `backgroundWritesPausedReason` and shown in the bell; the next
dashboard load tries again. A device-sync failure never blocks it (§M).

**Stuck operation lock recovery (2026-10-01).** A migration/import killed mid-run leaves its
`app_operation_locks` row; by decision 2b it is never auto-released (only a dead *export*'s is), so
the next boot used to wait 30 s and then fail, with no UI to fix it. Now: (1) a boot whose holder
process is provably dead fails at once instead of waiting; (2) `instrumentation.ts` keeps the server
up when database initialization fails and starts the session work once a later attempt succeeds;
(3) `db.ts` initialization is a `createRecoverableInitializer` -- after a failure the next call
re-attempts (at most every 3 s), so clearing the lock needs no restart; (4) `/recovery`
and `/api/operation-lock` (exempt in `src/proxy.ts`) use `ungatedRecoveryClient`, independent of
initialization and session; (5) the same `OperationLockControl` is shown in the Merge tab and as a
dashboard banner for non-export locks; (6) `npm run operation-lock -- status|clear` works with the
app stopped; `wait-idle` is what `stop.bat`/`stop.sh` run before killing the server (and `start` runs `stop` when port 3000 is busy), so a server is never killed mid-operation. FO-MSG-0013: they then run `media-idle`, which refuses (unless the script gets `--force`) while a media session on this computer is `approved`/`starting`/`running`/`stopping` -- stopping the app terminates its pod (AC-P14-09) and fails its queued jobs. Clearing is always an explicit operator action, a compare-and-delete on the exact lock
shown; a holder that looks alive needs `force` plus the typed word CLEAR. See RISK-91.

**Not done, by design.**
- No export in SIGINT/SIGTERM handlers, because a killed export leaves a never-auto-released
  operation lock. The idle shutdown does flush, since nothing is in flight. Under the macOS system
  service (BL-158, ADR 0032) idleness only ends the session (Live writes reset) and the process
  stays, so there is no final flush; the regular sync tick keeps exporting.
- No concurrent editing.

See RISK-89.

## 24. Data sources and YouTube API policy compliance — Phase 13, branch `feature/phase-13-data-sources`

Plan, decisions and acceptance criteria: `docs/roadmap/plans/PHASE_13_PLAN.md`. Owner decision D1 = (a): competitor
data from the API is kept at most 30 days, and no metrics are derived from it.

- **Classification, 13.1** (`src/lib/youtube-data-policy/contracts.ts`). Every table is classified once against
  the [Developer Policies](https://developers.google.com/youtube/terms/developer-policies), and a test fails on an
  unclassified table. The classes:
  - `authorized`: our own channels (III.E.4.b/c);
  - `non_authorized`: other people's channels (III.E.4.d), with its clock column and the condition that selects
    API-sourced rows (an exact list of the sources collection writes);
  - `not_api_data`: anything that is not YouTube API data.
- **Retention, 13.2** (`purgeExpiredApiData`, `runRetentionOnce`). Revised by review round 1:
  - It runs on a dedicated connection.
  - Snapshot rows are selected by the exact API sources, not a prefix.
  - Research evidence written from the API ("Fetch public snapshot") also expires. Other evidence sources are
    free text typed by the operator and are kept.
  - For a discovery candidate the operator has decided on, the title and reason are blanked instead of the row
    being deleted. A re-seen candidate refreshes its title along with its clock.
  - In the same transaction, a device that was in sync has its sync fingerprint re-baselined by
    compare-and-set. Every computer applies the same expiry, so it is not a local change to publish.
  - Owner decisions (msg 1139):
    - **An import never brings expired rows back.** The import purges inside its own merge transaction, before
      the lineage fingerprint (`purgeExpiredApiDataWithinTransaction`).
    - **Backups are scrubbed by the same rule on every run** (`scrubBackupFile` over `backups/migrations/*.db`,
      with `secure_delete`, then a best-effort VACUUM). Files are not deleted.
    - **Device sync removes this device's own sync-folder snapshots older than 30 days on every tick**, except
      the lineage head.
  - Reads (`listMarket*SnapshotsByChannel`, `listResearchEvidenceByChannel`, discovery candidates in
    `market-intelligence`) hide or redact expired API rows even before the purge has run. An MCP start runs the purge once. The AI decision engine's evidence descriptions carry no
    competitor values.
  - What is deleted: API-sourced rows of `non_authorized` tables older than 30 days, plus the market assignments
    pointing at deleted discovery candidates. Manual observations are kept. It runs in one transaction.
  - When: from `src/instrumentation.ts`, a minute after boot and then every 6 h. It is skipped under the operation
    lock or in recovery mode. The check is repeated inside the purge's own write transaction, so an
    export/import/migration that started first pauses it.
  - Backup: a full backup (`backups/migrations/pre-api-retention-*.db`) is taken before the very first purge.
  - Refresh: re-fetching through the daily collection is what keeps current values (a new row starts a new 30
    days).
- **No derived metrics, 13.3.** In `market-intelligence`, velocity, breakout and emerging-channel values built
  from watchlist snapshots are withheld. The fields stay in the responses, as part of the agent contract, but
  carry no value: velocity has `basis: "withheld_by_policy"`, breakout lists are empty, and `emergingChannel` gives
  a reason that cites III.E.4.h. The raw observations, each with its time (III.E.4.f), are still returned. The pure
  functions in `derived-metrics.ts` and `historical-intelligence.ts` remain for our own channels.
- **Quota model, 13.4** (`src/lib/youtube-quota`, a pure leaf).
  - The quota day starts at midnight Pacific time.
  - `search.list` has its own bucket of 100 calls a day at 1 unit, counted by `countMarketDiscoverySearchesSince`
    (one discovery-run row equals one call).
  - The shared unit budget (`getMarketIntelligenceUnitsSpentSince`) counts collection runs only.
- **Collection sources, 13.5/13.6, as revised by review round 1.**
  - Ids, titles and publish times come from the uploads playlist's first page: 1 pool unit, up to 50 videos.
  - The RSS feed (`youtube-read-gateway/feed.ts`, the newest ~15, no quota, with its own toggle and counter) is
    only the fallback when that call fails, for example when the pool is exhausted.
  - Statistics come from `videos.batchGetStats`, 1 unit of its own bucket. Its documented response carries only
    `snippet.publishTime`, no title. `videos.list` (1 pool unit) is the fallback.
  - A channel normally costs 2 pool units. The worst case, 3, is unchanged, and so is the budget pre-commit.
  - A test pins every snapshot `source` collection writes to the purge's exact API-source list.
- **View-counting break, 13.7.** `YOUTUBE_VIEW_COUNTING_CHANGED_ON = "2026-08-27"` (Data API revision history).
  The channel overview returns `viewCountingChangeInComparison`, and the UI warns that the views delta is not
  like-for-like.
- **Wikipedia interest, 13.8.** Wikimedia data is CC0, not YouTube data, so it can be kept and summarized.
  - `src/lib/wikipedia-gateway` is the only path to the Wikimedia Pageviews API. It has a toggle, the
    `wikipedia_reads` counter and a descriptive User-Agent, and an inventory test enforces it.
  - `src/lib/wikipedia-signals` is its own module (§M). It links articles to topics, using a foreign key onto
    `market_topics` with ON DELETE CASCADE as the existence check, so it never reads market-intelligence tables.
  - It collects only the missing days, up to yesterday and at most 90 days back, every 6 h, and shows 30-day sums.
  - Schema v37: `topic_wikipedia_articles` travels with handoff; `wikipedia_pageviews_daily` is a device-local
    cache.
- **Music chart, 13.9.** `chart=mostPopular`, `videoCategoryId=10`, by region, at 1 unit. It is current-only: an
  in-memory cache for 30 minutes, never persisted.
- **Not exposed to agents yet:** the Wikipedia signals and the Music chart. That depends on the separate
  agent-recommendations proposal.

## 25. Factory Operator access: logical path registry and a second agent role (BL-129, ADR 0022)

The plan and acceptance criteria (AC-FO-01..14) are in `docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md`; the decision is
`docs/decisions/0022-factory-operator-access.md`. Status: in `dev` (`ada77c5`), not released.

**Two independent modules, no shared state.**
- `src/lib/logical-paths/` is a registry of named local paths. `logical_paths(name, audience, description)` is the definition;
  `logical_path_values(device_id, name, path)` is one value per device. Both tables are device-local: they are not in
  `SNAPSHOT_TRANSFERRED_TABLES` and not in sync-gateway, by owner decision (each machine configures only its own values). Reads filter on the bootstrap
  `deviceId`; a read never creates it, never touches the filesystem and returns the stored string exactly as stored. Only the operator routes
  (`/api/logical-paths`, session required) create, set (validated once with `src/lib/local-path-validation`, like Phase 11) or delete.
- `src/lib/factory-agent-tokens/` holds the Factory Operator's token: `ytom_fo_` prefix, SHA-256 hash only, one active row, no channel, no Google identity. It can also be registered by operator import of an already-issued token (BL-130, ADR 0024); since BL-160 (§34) it and its revocation reach every device by themselves.
  It lives in its own table so that a channel token can never be looked up as a factory token or the reverse; the prefix check rejects a foreign
  token before any lookup.

**Two MCP surfaces, never mixed.**
- Channel agents: `POST /api/mcp`, token `ytom_ch_`, `createMcpServer`, `bound` tools inside the channel agent scope (`src/lib/agent-session`).
  Two additive reads were added (`agent_list_logical_paths`, `agent_get_logical_path`); the handler pins the registry to the `channel` scope, so only
  `all_agents` paths are visible and a `factory_only` name fails exactly like an unknown name.
- Factory Operator: `POST /api/mcp/factory`, token `ytom_fo_`, `createFactoryMcpServer` (`src/mcp/factory-server.ts`), a closed list of tools -- four read-only
  ones (ADR 0022) plus, since BL-132 (ADR 0025, Factory API 1.1.0), eight `factory_media_*` tools: storage status, models, pulls and templates (reads) and
  pull / cancel / delete a model and sync templates (writes, pinned by `FACTORY_WRITE_TOOL_NAMES`, audited as actor `factory`, each behind the device mutation
  gate injected as `assertMutationAllowed`; no session or job tool). The
  server file imports only the MCP SDK, zod and shared-domain: everything it can reach arrives through dependencies wired in
  `src/app/api/mcp/factory/route.ts`, which imports only the allowlisted modules (since BL-132 also `media-generation` and `device-mutation-gate`; no YouTube gateway, database access beyond the connection toggle and the traffic
  counter, analytics, change sets, batches). The endpoint never enters the channel agent scope, so it cannot read the operator's selected channel. Its
  channel listing returns channel id, title and this device's workspace path only.
- Shared, unchanged safeguards: loopback guard (extracted to `src/lib/loopback-guard`), the master MCP-connection switch (403 when off, for both
  endpoints), per-call token re-verification (a revocation lands on the next call), traffic counted in `mcp_tool_calls`.
- Revoking the factory token (`DELETE /api/factory-agent-token`) is an operator stop switch: it is exempt from the recovery-mode gate in `src/proxy.ts` like the channel-token revoke, so the role can be cut off exactly when something has gone wrong. The database also allows at most one active factory token (partial unique index, `factory_agent_tokens_one_active_idx`; migration v60 (v51 before the Phase 14 merge) first revokes all but the newest active row if several exist).
- `src/mcp/factory-server.test.ts` is the mechanical boundary: exact tool list, no `factory_*` name in `MCP_TOOL_CLASSIFICATION`, import allowlists, no channel-scope
  identifiers in the factory files.

**Known limit** (`docs/TECHNICAL_DEBT.md` RISK-105): a process running as the same OS user can read the factory token from its client configuration or the
database. The exposure is read-only (path strings, channel titles and workspace paths). The in-app wall does not defend against a hostile same-user process (see
`docs/AGENT_ISOLATION_SETUP.md` §5).

## 26. Remote media generation (RunPod + ComfyUI) — Phase 14, slice 1, branch `feature/phase-14-media-generation`

Plan and acceptance criteria: `docs/roadmap/plans/PHASE_14_PLAN.md`; research:
`docs/roadmap/plans/MEDIA_GENERATION_RUNPOD_COMFYUI_SYNCTHING_RESEARCH.md`. Slice 1 delivers the
foundation only — gateways, credentials, settings, Settings UI, operator CLI. Sessions (pods that are
approved per session and always terminated), jobs (ComfyUI prompts whose outputs are pulled over S3 into
`99 Data Exchange/From YTM/media/<jobId>/`), the Models panel and the agent tools are later slices.

- **Gateway (`src/lib/media-gateway/`).** One barrel over three children, one per external API
  product, each checking the single "Media gateway" toggle and recording a traffic event: `runpod-api.ts`
  (RunPod REST **v2** at `api.runpod.io/v2` — v1 at `rest.runpod.io` retires on 2026-11-15), `runpod-s3.ts`
  (RunPod's S3-compatible network-volume API, signed by the hand-written SigV4 in `sigv4.ts`, verified
  against the official AWS test vectors rather than adding the AWS SDK), `comfyui-api.ts` (the ComfyUI
  server behind RunPod's HTTP proxy, bearer token per session). `inventory.test.ts` fails the suite if any
  production file outside the gateway names a runpod.io host, or imports a child instead of the barrel.
  There is deliberately no "stop pod" function anywhere: a stopped pod's disk is billed at twice the
  running rate, so the only idle state this app knows is "terminated".
- **Credentials (`src/lib/media-generation/`, owner instruction 2026-10-05).** The RunPod API key and the
  optional S3 key pair are entered only in Settings → RunPod (Settings → Media before slice 6), encrypted as one AES-256-GCM blob in
  `media_credentials` (schema v50, singleton, device-local: not in `SNAPSHOT_TRANSFERRED_TABLES`, not in
  `sync-gateway`). **The encryption key is a file the app creates itself** (`media-generation.key` in the
  app-data directory, written through `writeJsonFileAtomic`, mode 0600), not an environment variable —
  unlike `ai-connections`/`cloud-connection` (ADR 0008). A database copied to another machine has no
  matching key file and reads as `{ configured: false, reason: "key_file_missing" }`; no decryption is
  attempted. A read never creates the key; only the operator's save does. Decryption happens inside the
  service for the duration of one call and the plaintext reaches only the gateway factory. No route, CLI
  command, log line or (future) agent tool returns a secret; the public status carries the key's first
  characters, the S3 key id (RunPod's `user_…`, not a secret) and `verifiedAt`.
- **Settings.** One JSON blob under `app_settings.media_generation_settings`, validated by
  `mediaSettingsSchema` (defaults in `DEFAULT_MEDIA_SETTINGS`). Catalog-backed values are checked live on
  save: the datacenter must be in `GET /catalog/data-centers`, the GPU in `GET /catalog/gpus`, the network
  volume must exist and sit in the chosen datacenter (`media_settings_invalid`); numeric limits:
  `watchIntervalSeconds ≥ 15`, `idleMinutes ≥ 1`, `maxUsdPerDay > 0` (AC-P14-19). Setting a catalog value
  before credentials exist is refused (`media_generation_not_configured`), never silently accepted.
- **Operator surfaces.** `src/app/api/media-generation/*` (session required, mutating methods behind
  `src/proxy.ts`'s device gate), the Production section and Settings → RunPod (slice 6; `production-panel.tsx`, `media-generation-settings.tsx`: every
  RunPod call is an explicit click — Load / Test / Create — never on mount; creating a volume goes through
  `ConfirmDialog` with the monthly price), and `src/cli/media.ts` (`npm run media -- …`), a separate entry
  point from the main CLI (AGENTS.md §M) with the same gates (Operator CLI access; device mutation gate for
  `volume-create`/`pod-create`/`pod-terminate`/`s3-rm`). Scripts under `scripts/media/` wrap this CLI so a
  secret is never an argument or an environment variable (AC-P14-20).
- **Independence (AGENTS.md §M).** With no credentials the feature answers "not configured" and makes no
  outbound call; nothing else in the app imports it. Residual risks: RISK-106, RISK-107.
- **One core per process (review rounds 3–4).** `createMediaGenerationCore()` returns a `globalThis`
  singleton per scheduling mode: `background` for everything inside the web process (the watch loop, every
  route, the in-app MCP endpoint of ADR 0013), `detached` only for the operator CLI, so the in-flight job
  set and the serialized pulls-list writer are shared by every caller in the process and a job is never
  polled twice. A detached core never polls a job itself -- the web watch loop re-attaches to it
  (`resumeInFlightJobs`, run BEFORE the idle check so the first poll counts as activity; it also resumes
  stuck `transferring` rows, which need only S3, and fails a submitted/generating job whose session is
  gone instead of leaving it "in flight" forever). A transient "cannot receive outputs" (workspace
  unmounted, gateway off) keeps the job `transferring` for retry up to 24 h; the boot sweep fails only
  queued/submitted/generating jobs and leaves `transferring` ones to the resume. The pod's name is
  deterministic (`ytm-media-<sessionId prefix>`), so a pod created in the instant before the `starting`
  write is still found and terminated (and billed to the session) by the boot sweep. The S3 gateway gives
  body transfers a 30-minute budget (the abort signal also cuts the body stream) and metadata calls 60 s.
  The daily cap's day is the operator machine's local day. Web `POST /sessions` and `POST /jobs` refuse a
  `channelId` that is not a connected channel (AGENTS.md §F); the MCP path asserts the bound channel.
- **Orphan-proofing (review round 5).** A `createPod` call can fail after RunPod created the pod (timeout,
  dropped connection): sessions and model pulls both name their pods deterministically
  (`ytm-media-<session prefix>`, `ytm-models-pull-<pull prefix>`) and look the pod up by name through the
  cursor-paged `listPods` before concluding "no pod"; the start wait re-checks the pod on every ComfyUI
  poll so a container that dies while booting aborts within one interval; a pull's pod is confirmed gone
  before the pull is terminal (the volume stays "busy" until then); a job cancelled while its submit was
  in flight has its prompt withdrawn (`/queue delete` or `/interrupt`); a `queued` row is swept only
  after a 5-minute grace period. The janitor deletes BY LEDGER ONLY: a key under `exchange/` goes only
  when its `media_exchange_files` row says the file is local -- a failed or cancelled job's leftovers,
  which may be a finished generation nobody recorded, stay for the operator (`scripts/media/s3.sh`).
  The SIGINT/SIGTERM terminate is best-effort (Next.js owns the exit); the boot sweep is authoritative.
- **Abandoned starts and truthful outcomes (review round 6).** `media_sessions.stopping_outcome` (schema v53)
  records the terminal status a `stopping` row is heading for (`done` / `failed` / `interrupted`), so a stop
  retried by the watcher or the boot sweep ends with that status and the original `stopReason` (an aborted
  start never reads as `done`; "max USD reached" survives a restart). The watcher reconciles an `approved`/
  `starting` row whose approve request died once it is older than start + stop timeout + 2 min (pod
  terminated, session `failed`, cost recorded) -- before, such a pod billed until a manual restart while
  `hasOpenPod` blocked the idle shutdown. The boot sweep keeps an `approved` row without podId `approved`
  (error recorded) while RunPod is unreachable, because only that state triggers the deterministic-name
  search; an EXITED pod whose termination is unconfirmed stays `stopping` instead of `interrupted` on trust.
  The pulls list is read-modified-written in ONE libSQL write transaction (`updateMediaModelPullsJson`,
  `BEGIN IMMEDIATE`) and merged per pull, so the operator CLI (a separate process) and the web watch loop
  never drop each other's pull; `GET /models` and the CLI `models` are read-only (`listPulls`) -- only the
  watch loop advances pulls, so a read verb never terminates pods behind the device mutation gate's back.
  A download that fails verification is removed from the workspace folder (the remote copy stays for a
  retry); a transfer resumed from the ledger still registers the asset, reusing an entry an earlier attempt
  may have created (`findAssetByLocalPath`). A ComfyUI history entry without a `status` block but with
  outputs is `completed`; `agent_get_media_session`'s list filters by channel in the query. Dead surface
  removed: `uploadImage`/`viewUrl` on the ComfyUI client, `listMediaExchangeFilesByJob`.
- **Bounded billing and submit-time checks (review round 7).** `media_sessions.last_seen_alive_at` (schema v54)
  is written at readiness and on every watcher tick that finds the pod alive; when a reconciliation (boot
  sweep, watcher, operator Stop) finds the pod ALREADY gone, the billable window closes at that last
  sighting, not at `now()` (the row's `error` says so and defers to the RunPod invoice) -- a pod killed by
  hand hours before a reboot no longer eats the daily cap. A pod still alive is billed to its confirmed
  termination as before. `createJob` resolves the channel's workspace folder BEFORE any ComfyUI call
  (`media_workspace_unavailable` at submit, as the agent contract promises; no GPU minute spent on a job
  that could never land); a 400 from `/prompt` is stored with ComfyUI's own `error`/`node_errors` text
  (`describeComfyRejection`, bounded to 2000 chars); history outputs are filtered to `type: "output"` (a
  PreviewImage's `temp` files are neither pullable nor a reason to mark the job partial) and a prompt that
  saved nothing fails. `startPull` refuses a key that already exists on the volume (the poll would call it
  done on the first tick); the boot sweep is no longer awaited in `register()` (the watch loop waits for
  it instead, so a slow RunPod cannot hold HTTP startup for minutes); S3 object paths use the SigV4
  encoder for the wire URL too; `findAssetByLocalPath` is one indexed lookup
  (`getCreativeAssetByReference` → `assetCatalog.findAssetByReference`), not a channel-wide scan; the
  CLI `janitor` accepts only the bare `--delete` switch.
- **Closed race, shared lifecycle, bounded polling (review round 8).** AC-P14-18 (no GPU session while a pull
  writes the volume) had a window: both sides checked, then wrote. Now a pull RESERVES its record (podId
  null) before its `createPod` and re-checks the open pod after; an approve re-checks the pull after its own
  `approved` write (which `hasOpenPod` counts) and puts the request back to `pending` if one slipped in --
  whichever wrote second sees the other. A reservation with no pod past a 2-minute grace is adopted (pod of
  its deterministic name) or voided by the poll. `pod-lifecycle.ts` holds the ONE terminate-and-confirm and
  find-pod-by-name implementation sessions and pulls both call (AGENTS.md §M). The job poll loop credits
  session activity only for a prompt ComfyUI confirms (history, or `/queue` every 15th empty poll) and fails
  fast when the prompt is neither queued, running nor in history (ComfyUI restarted) instead of billing to
  the generation deadline. A THROWN per-object S3 failure during transfer keeps the job `transferring` for
  the retry window (a verdict such as "outside the job's folder" stays a note). Template defaults are
  validated against their own type/bounds/enum at import (`checkParameterValue`, shared with job params);
  `output_node_ids_json`/`node_count` (schema v55) are derived at import/update so a listing never
  re-parses graphs; `createAssetCatalogCore` wires `getAssetByReference` (round 7 had added it to the
  services only); S3 query strings use the SigV4 encoder (a space is `%20`, never `+`).
- **The volume lock and the last guesses removed (review round 9).** AC-P14-18 is now a CONSTRAINT, not a
  protocol: `volume-lock.ts` is the one database-enforced "network volume is busy" lock (one
  `app_settings` row, `media_volume_lock`, whose primary key makes the insert the atomic test-and-set). A
  session takes `session:<id>` before its `approved` write and `finish()` releases it with the terminal
  write; a pull takes `pull:<id>` before its reservation and releases it with its terminal write. An
  acquire that finds a holder asks the holder's module whether it is still active and steals a stale one
  (crash between the terminal write and the release). Every future writer to the volume takes the same
  lock. Disabling the media gateway is refused while the lock has an active holder (the toggle gates the
  only path that can terminate that pod). A failed `createPod` whose name lookup ALSO fails leaves the
  session `approved` (slot and lock kept, error recorded) -- the watcher repeats the search; a pull in the
  same situation keeps its reservation; neither frees the volume on a guess. The abandoned-start margin is
  5 min (derived from the approve request's real worst case, not 30 s over it). Stored settings with one
  invalid key keep every valid key (the spend cap included) and default only that key. A remote key with a
  `.`/`..` segment (an untrusted Save-node subfolder) is never HEADed, pulled or deleted; an output pulled
  earlier but not cataloged is cataloged on the retry; a template rename does not bump the version that job
  provenance records (only a graph/parameter change does).
- **Lock row never assumed, settled pulls never resurrected (review round 10).** `tryAcquireMediaVolumeLock`
  re-inserts when the read-back is null (the holder released between the no-op insert and the read):
  `acquired` is true only with the caller's own row in the table. After `createPod`, a pull records its pod
  only if its reservation is still `running` -- one settled by another process meanwhile (a cancel from the
  web UI while the CLI was inside `createPod`) keeps its verdict and the just-created pod is terminated.
  An output not yet visible in the S3 view of the volume, or read short, is a THROWN transient (the job
  stays `transferring` within the retry window), never a verdict. A template parameter may not target
  `filename_prefix`; `min` is enforced for string/text parameters; a datacenter change re-validates and
  re-prices the kept GPU; `models-pull.sh` quotes manifest values like `buildPullCommand`; the Settings
  card imports `NETWORK_VOLUME_USD_PER_GB_MONTH` instead of restating it.
- **Readiness, activity cadence and settings drift (review round 11).** `getSystemStats` is "up" only with
  ComfyUI's documented `system`/`devices` shape (a proxy's placeholder 200 is not). While ComfyUI confirms
  the prompt (history, or `/queue` on every 15th empty poll), EVERY poll credits session activity, so the
  1-minute minimum idle timeout cannot fire mid-generation. Approve refuses a request whose saved
  GPU/datacenter/price no longer match Production → Setup (`media_settings_invalid`): the estimate, the cap
  check and the record must describe the pod that is billed. Settings refuse a GPU the catalog does not
  offer in the chosen datacenter (`gpu.dataCenters`). A Save node whose `filename_prefix` is a link is
  refused at import. A Stop whose terminate throws records the cause on the `stopping` row. The money
  fields of the Settings card are controlled text inputs (`parseMoney`: "2.5" and "2,5", never a native
  number widget, per the project's settings-widget rule); the Jobs card polls only `/jobs` every 5 s and its
  context every 60 s. `src/lib/shared-async` holds the one `sleep` (unref'd for the detached CLI) and
  `round2`; `key-file.ts` has no `this`.
- **The route that was never committed, and verdict vs. outage (review round 12).** `.gitignore`'s
  `credentials/` pattern had swallowed `src/app/api/media-generation/credentials/` (the GET/PUT/DELETE
  route, `credentials/test` and their test) -- un-ignored and committed; without it no RunPod key could be
  saved on another checkout. `updateMediaModelPullsJson` is a compare-and-swap (guarded UPDATE / INSERT ON
  CONFLICT DO NOTHING, re-applied on a lost race), the single-statement idiom `db.ts` uses everywhere
  instead of a cross-connection transaction. The ComfyUI gateway distinguishes `comfyui_rejected` (a 4xx
  with a JSON body: ComfyUI's own verdict, 422) from `comfyui_unavailable` (5xx, a proxy's HTML, a
  timeout, 502); the poll loop fails at once on the former and retries only the latter. A 0-byte HEAD is
  "not there yet" (never recorded, never deleted). A `transferring` job that cannot be received backs off
  exponentially (15 s → 10 min cap, per process) instead of being re-driven every tick for 24 h.
  `getRunningSession` answers null for an unknown session id (never a throw out of the resume loop);
  `holdsVolumeLock` counts only a session past its `approved` write, so a lock left by a failed approve
  write is stale; `templateId` is validated against the account's templates like the other three pod
  inputs; `finish()` builds the pod facts once.
- **The lock's own window, and the third writer (review round 13).** An owner acquires the volume lock
  BEFORE its row is visible (approve → `approved` write, pull → reservation), so for milliseconds it is
  not "active" to the staleness check: the lock row now carries its acquire time (`<owner> <epoch ms>`)
  and a not-visibly-active holder is stolen only once older than a 2-minute grace -- a fresh one is a
  conflict. Operator pods (CLI `pod-create`, `scripts/media/*.sh`) that mount the configured volume are
  the third writer: the passthrough takes `pod:<name>` (active while a live pod of that name exists; the
  terminate passthrough releases it). Readiness requires the S3 key pair (outputs travel over S3 only),
  and `createJob` resolves the S3 client before submitting. The start wait marks the pod seen alive on
  every successful poll, so a pod that vanishes mid-start after a crash is billed to its last sighting.
  A history entry without a verdict (no `status`, no outputs) is in progress: progressed to `generating`
  and liveness-checked like an absent entry. A transfer window that ends with an output still not
  received is a failure, never a `done` missing an output. `credentials-test` is a gated CLI command (it
  writes `verified_at`). The pod template ships no default `COMFY_TOKEN` (`pod-start.sh` refuses to expose
  ComfyUI without one). `src/lib/shared-json` holds the one tolerant JSON reader set (`asRecord`,
  `asRecordOrNull`, ...) that the media gateway and the transcript provider both import.
- **Nothing that can strand a billing pod is editable while one is open (review round 14).** The guard that
  refused disabling the gateway now also refuses changing or clearing the credentials and switching the
  network volume or datacenter while the volume lock has an active holder (`assertVolumeFree`); limits,
  GPU and template stay editable (they bind only future sessions). An operator Stop on a `stopping` row
  retries the terminate with the row's OWN outcome and reason (an aborted start still ends `failed`); a
  Stop on an `approved` row whose approve request died runs the name search and terminate at once (the
  manual override of the watcher's abandoned-start path) and, while RunPod cannot be asked, keeps the slot
  and says so (`runpod_api_unavailable`). `releaseMediaVolumeLock` matches the owner by exact prefix
  (`substr`), never `LIKE`. `creative_assets_reference_idx` (schema v56) backs the per-output asset
  lookup. The pull command removes the Hugging Face CLI's download cache from the volume after the
  download and on any exit (a trap), as does `models-pull.sh`.
- **One transport, one pull implementation, no orphan on a late pod (review round 15).**
  `media-gateway/http.ts` is the one fetch → timeout → body → JSON-or-raw step both the RunPod and the
  ComfyUI children call (status mapping stays with each child). `comfyui_rejected` is definitive for
  `POST /prompt` only; a poll counts it like any other failure (ComfyUI never answers 4xx on `/history`;
  an intermediary does). `VolumeLock.acquire` reports "acquired" vs "already-held" (a store's `acquired`
  is true only for the row THIS call inserted), and an approve that loses the `approved` transition to a
  concurrent approve of the same session leaves the lock to the winner. A Stop on an `approved` row is
  refused while its approve request may still be inside `createPod` (no error on the row, not yet
  abandoned by age); a pod created after the row was stopped meanwhile, whose terminate cannot be
  confirmed, is written onto the row (`podId`, cost, how to terminate it) instead of being forgotten.
  `resumeInFlightJobs` credits session activity synchronously for each job it picks up (the watcher's idle
  check follows in the same tick). The operator terminate passthrough confirms the pod is gone before
  releasing `pod:<name>`. `models-pull.sh` drives `media model-pull` per manifest line and `media
  models-poll` (a gated command that advances the pulls) instead of re-implementing the pull shell.
- **A corrupt key file has a remedy; one rule each (review round 16).** An unreadable key file is reported
  as `key_file_invalid` (the card renders a Reset); Clear removes the row and -- only when the key file is
  unreadable -- the key file too (CLI: `credentials-clear`), so the next save starts a fresh key; a readable
  key file is kept (AC-P14-21). An output's path below `exchange/<jobId>/`
  is kept locally (two Save nodes with the same file name in different subfolders never overwrite each
  other). The generation deadline counts from the job's submit, not from each pickup. The lock row is
  JSON `{ owner, since }` matched by `json_extract` (a name with spaces, `_`/`%` or non-BMP characters is
  exact). Cancelling a RESERVED pull searches the pod by name first (a pod the dead reserver created is
  terminated, never orphaned). Community Cloud with a network volume is refused at settings time; only a
  CHANGED compute field is validated against the live catalog. The Jobs card explains when the open
  session belongs to another channel. The UI uses the core's own public types (`MediaSession`, ...), not
  hand copies. `isStartAbandoned` and `retryOrFail` are the single statements of the abandonment and the
  transfer-retry rules.
- **Tolerance where it was missing, no zombie prompts (review round 17).** The readiness wait tolerates up to
  five consecutive RunPod failures (a 502 or a timeout on `getPod` no longer terminates a healthy,
  almost-ready pod) and a DB hiccup on the seen-alive mark. A lost `POST /prompt` response is not a
  rejection: the queue is asked for the entry with `client_id ytm-<jobId>` (the gateway's `getQueue` now
  exposes `entries` with client ids) and the prompt is adopted; only `comfyui_rejected` fails the job as
  rejected. Every failure exit of the poll loop (deadline, a run of poll failures) withdraws the prompt
  (`withdrawPrompt`, the one interrupt/dequeue sequence a cancel uses too). The boot sweep moves a
  `running`/`starting` row to `stopping` before terminating, so nothing reads it as running meanwhile. A
  finished pull deletes `models/<folder>/.cache/**` over S3 (the pod may be killed before its own cleanup).
  `hasInFlightJobs` ignores a `transferring` job sleeping in its backoff, so the idle shutdown is not
  deferred for it. The integer Settings fields (minutes, seconds, GB) are controlled text inputs parsed on
  save (`parseInteger`), like the money fields.
- **Never on the strength of one GET (review round 18).** A pod the watcher cannot GET goes through
  `stopRow` (DELETE, then confirm) like every other exit, never straight to `interrupted` -- a transient
  404 on a live pod would otherwise free the slot and the lock while it bills. An operator pod whose
  `createPod` failed keeps the volume lock while a live pod of its name exists (or RunPod cannot be asked);
  only a confirmed "no pod" releases it. The pull poll evaluates each check on its own (a flaky S3 cannot
  hide a dead pod or the cap). An abandoned `approved` row with an adopted orphan pod is `stopping` while
  its terminate is confirmed (a concurrent Stop resumes that stop). RunPod's `createdAt` is parsed with
  `Date.parse` and falls back when unparsable (never a NaN cost that would silently disable the daily
  cap). A `done` stop of an already-gone pod carries the gone-note in its reason, not as an error. The
  janitor's documentation and the Jobs card say what it does: by ledger only, failed/cancelled leftovers
  kept. `job-run.sh --param-string` sends a numeric-looking text value as text. The credentials Reset
  dialog says the unreadable key file is removed too.
- **The window ends at OUR delete (review round 19).** `media_sessions.terminate_sent_at` (schema v57) records
  when this app's terminate DELETE went through; a retried stop whose DELETE answers 404 then bills to that
  moment (the pod died by our hand), not to the last sighting and not as "vanished on its own". A pod
  created after another party ended the row, whose terminate is confirmed, is written onto that row with
  its billed seconds (a pod on no row would hide spend from the daily cap). An intentional Stop while a
  session is starting is the approve request's outcome (the session as it ended), not a start error. A
  `done` job's `error` lists only outputs that were NOT received (an informational note stays on the
  output). The operator `createPod` resolves credentials before taking the volume lock, and a `pod:`
  holder check that cannot even resolve credentials counts as inactive (the lock ages out instead of
  blocking the very credentials needed). `updateSettings` derives one `revalidate` set from what changed
  (never by rewriting the caller's update); `finalCost` is `liveSeconds`/`liveUsd` frozen at `stoppedAt`.
- **Every terminate records its DELETE; a stopping row keeps its reason (review round 20).** The boot sweep's
  and the aborted start's terminates persist `terminateSentAt` like the watcher's, so a retry that finds the
  pod gone bills the crash-to-reboot hours to our DELETE. `stopRow` takes the caller's reason/outcome only
  from `starting`/`running`; a row already `stopping` keeps its own (a watcher tick racing an operator Stop
  never relabels the deliberate `done` as `interrupted`). Re-saving the same GPU re-prices it when its stored
  price is unknown (the remedy `requestSession`'s error names). The pull poll resolves S3 and RunPod on
  their own (an unusable pair never skips the dead-pod check or the cap). RunPod's 403 is
  `runpod_forbidden` (no permission for THIS resource: another account's pod, a restricted key), 401 alone
  is `media_credentials_invalid`. The janitor's `deleted` lists only what was really deleted; a dry run
  reports `wouldDelete`. The dead "another session is open" check in approve is gone (the unique open-slot
  index is the guarantee); `job-run.sh` refuses a `--param` without `=`.
- **Single owners (review round 21).** The session status lists live once, in the pure `contracts.ts`; `db.ts`
  imports them for the column enum and for freeing the open slot. The MCP tool input schemas are the core's
  `requestSessionInputSchema`/`createJobInputSchema` minus the server-set identity field. The boot sweep's
  already-gone path honors a recorded `terminateSentAt` like `stopRow`. `round2` moved to
  `src/lib/shared-money`. `verifyKey` probes `GET /pods?limit=1` (the scope the app needs). The job outputs
  cell shortens Windows paths too.
- **Sessions (slice 2, `sessions.ts`, `media_sessions` schema v51 + v53 + v54, owner decisions D2/D3).** A session is one
  pod. `requestSession` (operator now, agent in slice 5) stores a pending row with a LOCAL estimate
  (`gpuOnDemandPricePerHr × maxMinutes / 60`, the price captured when the GPU was saved -- zero RunPod
  calls, AC-P14-03) and `fitsToday` against the daily cap; a request that does not fit is still created
  and flagged. `approveAndStartSession` is Web-only (fenced by `session-approval-inventory.test.ts` from
  `src/mcp`, `src/cli`, `src/lib/agent-operations`): every precondition (ready, cap not used up, no
  other open session, credentials resolve) runs before the first transition (AC-P14-04); then
  `pending → approved → starting → running` as atomic `UPDATE … WHERE status IN (…) RETURNING` steps,
  the pod created from the template with the network volume at `/workspace`, port `8189/http` and a
  per-session `COMFY_TOKEN` (stored encrypted under the device key, never returned), `startedAt` =
  creation time (RunPod bills from there), `costPerHr` from the pod; the route blocks behind the shared
  progress overlay until `GET /system_stats` answers through the token proxy. A start that fails or
  times out terminates the pod and ends `failed`. *(Until slice 6: one open session per device via a UNIQUE index on
  `open_slot` -- superseded, see "Concurrent sessions" below.)* The
  watcher (`src/instrumentation.ts`, interval = `watchIntervalSeconds`, min 15 s) terminates on idle ≥
  `idleMinutes` (activity = job traffic, slice 3), minutes ≥ `maxMinutes`, usd ≥ `maxUsd`; a pod found
  `EXITED`/`ERROR` is terminated and the session `interrupted`, a vanished pod likewise (AC-P14-06/07).
  Termination is always `DELETE /pods/{id}` confirmed by a re-read; if RunPod cannot confirm, the
  session stays `stopping` (slot kept) and the watcher retries. Boot sweep terminates whatever a dead
  process left and marks it `interrupted` (AC-P14-08); the idle auto-shutdown and the SIGINT/SIGTERM
  handlers call `stopForShutdown` first (AC-P14-09; the signal path is best-effort, the boot sweep is
  the backstop). Cost: `usdCharged = secondsUsed × costPerHr / 3600`, seconds from pod creation to
  confirmed termination, live while running; the daily total sums sessions started today (AC-P14-17).
- **Templates, jobs and the exchange (slice 3, `jobs.ts`, schema v52, owner decisions D1/D4/D7).** A
  workflow template is an operator-imported ComfyUI graph in API format plus declared parameters
  (`name → nodeId/input`, type, bounds); import validates that every parameter targets an existing node
  input and that the graph has at least one Save node (an input named `filename_prefix`); editing bumps
  `version`, which a job's provenance records. `createJob` (operator now, agent in slice 5) requires a
  running session of the same channel, validates the values against the declared parameters before any
  ComfyUI call (AC-P14-10), writes them into a clone of the graph, rewrites every Save node's
  `filename_prefix` to `<jobId>/<base>` so the outputs land under `/workspace/exchange/<jobId>/` on the
  volume, submits `POST /prompt` through the token proxy and starts a background poll of
  `/history/{promptId}` (every 4 s, 2 h cap; each poll counts as session activity). `node_errors` or an
  `execution_error` mark the job `failed` with ComfyUI's message (AC-P14-11). On completion each output
  is pulled over the S3 API: `HEAD` → `GET` to a temp name + rename (the gateway hashes the stream) → a
  second SHA-256 of the file on disk must match (AC-P14-12) → ledger row in `media_exchange_files` →
  `DELETE` on the volume (a failed delete leaves `remoteDeletedAt` null for the janitor, AC-P14-13) →
  one `creative_assets` entry (`local_path`, type by output kind, provenance with template id+version,
  params, promptId, podId, gpu, cost, sha256). Outputs are written only under `<workspace>/99 Data
  Exchange/From YTM/media/<jobId>/` — the folder is resolved by the shared `src/lib/workspace-exchange/`
  module (extracted from research-export, AGENTS.md §M: same symlink/containment proofs as ADR 0019);
  without a configured workspace the job fails and nothing is pulled or deleted. An output reported
  outside the job's folder is never pulled or deleted. **Manifest** (FO-REQ-0002): `buildJobManifest` (explicit
  allowlist) → `manifest.json` written last via `.part` + rename; for `done` before the transition (a failed write is a
  transient transfer failure, retried within the window, then failed), for `failed`-with-folder after it, best effort;
  only files inside the folder are listed (an earlier workspace's file goes to `missing`); the name is reserved as the
  first segment below the job's folder (such an output is not pulled). A `done` transition that finds the row already
  moved (only possible from another process) is logged. Device = bootstrap `deviceId` + `os.hostname()`. **Janitor** (`cleanupExchange`, AC-P14-14): lists
  only `exchange/`, skips `exchange/in/` (reference inputs) and keys of unknown or non-terminal jobs,
  deletes a key only when its job is terminal and either its ledger row says the file is local or the
  job failed/was cancelled; dry run by default (Settings button, CLI `janitor`), real deletes daily from
  `src/instrumentation.ts` and on demand. Jobs left mid-flight by a dead process fail as interrupted at
  boot, right after the session sweep.
- **Factory media control (BL-132, ADR 0025, schema v61).** *Pulls* (`models.ts`): the Hub pre-check through the gateway
  child `media-gateway/huggingface.ts` (revision → commit, size, LFS SHA-256; gated/private refused) and a free-space check
  (`getNetworkVolume`) run before any pod; the CPU pod's script (`buildPullCommand`) downloads the commit into
  `ytm-staging/<pullId>/`, `sha256sum`s it, `mv`s it into `models/` only on a match and writes `ytm-pulls/<pullId>.json`;
  `pollPulls` settles a hashed pull ONLY on that verdict (+ S3 showing the verdict's size at the final key), and
  `finishPull` deletes the pull's staging/verdict keys. Pull records stay the `app_settings` JSON list (now 100 finished);
  the durable history is `media_control_events` (actor `owner|factory|sync`). *Usage/guard*: `jobs.modelUsage()` = this
  device's templates (factory: declared `models_json`; local: loader-node literals recorded at import) + every template the
  registry lists; `models.deleteModel` refuses the factory on any user or an unreadable registry, takes the exclusive
  volume lock as `delete:<id>` for the delete. *Registry*: `template-registry.ts` (format, pure checks, the known
  loader→folder map), `adapters/template-registry-fs.ts` (the only read inside a logical path: `media_templates`, direct
  regular files ≤ 5 MB, real path inside), `jobs.syncTemplatesFromRegistry` (serialized; fingerprint of index + listed
  files for the 60 s check in `src/instrumentation.ts`; last result in `app_settings`). Factory rows are written by
  `upsertFactoryMediaWorkflowTemplate`, whose `ON CONFLICT` update only applies to a `source='factory'` row. *Inputs*:
  parameter types `image|audio|video`; `createJob` resolves every input with `workspace-exchange.resolveSentToYtmFile`
  before the job row, then streams each with `RunpodS3Client.putObjectFromFile` (two passes: SHA-256, then the body with
  Content-Length) to `exchange/in/<jobId>-<param>-<name>` before the submit; ledger `media_exchange_inputs`; the janitor
  deletes such a key only by that ledger and only for a terminal job (other `exchange/in/` files stay "reference input").
- **Factory GPU sessions, fallback, capacity wait (BL-133, ADR 0026, schema v64).** `gpu-plan.ts` resolves the candidates (session plan,
  else device GPU + `gpuFallbackIds`; filtered by VRAM, price cap and the volume's datacenter via the catalog) and classifies a failed
  createPod (400 "could not be placed" = no capacity; 429/5xx/none = transient; else fatal). `startApproved` loops over them, keeping the
  orphan-name search per attempt and recording each attempt in `media_capacity_attempts`; none placed → `waitForCapacity` (`approved →
  waiting_capacity`, no pod). `watchOne` retries a due waiting session in the background (`waiting_capacity → approved` with `approvedAt`
  restarted) and fails it after the wait; the loop ticks at least every `capacityRetrySeconds`. `approveInner` is shared by the owner's
  approve and `factoryStartSession`, which first checks the factory limits (`factorySpendUsd`: spend plus the remaining caps of active factory
  sessions, per local day and month); `stopInner` is shared by the owner's Stop and `factoryStopSession`; `getFactorySession` hides every
  non-factory session from the factory route.
- **CUDA host check and re-placement (BL-155, `docs/roadmap/plans/CUDA_HOSTS_PLAN.md`, FO-REQ-0007, no schema change).** Setting
  `minCudaVersion` (12.8 default; null and no session minimum (BL-159) = no create-pod filter and no host-version check -- the
  host's version is still read, for display only) → every createPod sends
  `gpu.allowedCudaVersions` = the known versions ≥ it (`cuda-host.ts`, pure); no matching host is RunPod's "no capacity". Before
  `running` the start reads the host's CUDA -- first from the pod answer itself (`cudaVersion`, seen live 2026-10-08), else gateway `getPodHostCudaVersion` (GraphQL `pod.machine.machineSystem.cudaVersion`) -- on
  each RUNNING poll until it gets a value or the container is up (then unknown = not blocking), and always requires a `cuda` device
  with VRAM in `/system_stats`. A mismatch terminates the pod (confirmed, else the usual `stopping` path, no second pod), logs a
  capacity attempt `error` and places again from the candidate list -- at most `MAX_EXTRA_PLACEMENTS` = 2 more, each with its own
  start budget -- then fails `media_gpu_host_incompatible` (503); a re-placement that cannot create a pod fails too (never waits).
  Between placements the row goes back to `approved` with `podId` null (the name search covers a crash), `approvedAt` = now, and
  each placement's `starting` write sets `approvedAt` to its pod's placement time (`startAttemptSince` = the later of `startedAt`
  and `approvedAt` drives the abandoned-start clock). One billing window spans all placements: `startedAt` stays the first pod's,
  `costPerHr` is the dearest pod's, and a failure after a re-placement is billed to the last confirmed terminate. The replaced
  pod's `terminateSentAt` is kept on the `approved` row (a crash with no pod found closes the window there, else at the last
  sighting) and cleared by the next `starting` write; wherever a new pod's facts are written outside it (orphan adoption in
  `reconcileAbandoned`, `abortStart`, the swept-meanwhile path) they carry that pod's own DELETE time (or null) and a
  `lastSeenAliveAt` no earlier than its placement/sighting. The watcher stops a `starting` session (every session, not only
  re-placements) at `maxMinutes` counted from `startedAt` -- "max minutes reached (N) while starting". Factory jobs carry an
  `errorCode` derived from their error text (Factory API 1.7.0); release-when-done with every job failed says "all jobs failed".
- **A minimum CUDA per session and per template (BL-159, `docs/roadmap/plans/PER_SESSION_CUDA_PLAN.md`, FO-REQ-0011, schema v71).**
  `factory_media_start_session { minCudaVersion? }` or the started template's top-level `minCudaVersion` (call wins) is the session's
  own minimum (`media_sessions.min_cuda_version`; channel agents and the Web UI cannot set it). `startApproved` computes
  `higherCudaVersion(owner, own)` at every start and capacity retry -- the owner's setting is the floor (owner's decision) -- writes it
  at once to `used_min_cuda_version` (so a session waiting for capacity shows why), and uses it for `allowedCudaVersions`, the host
  check and the mismatch text. The host's CUDA is read with or without a minimum (without one a failed read, even a 401, is unknown)
  and written to `host_cuda_version` and to that placement's own capacity-log row (`insertMediaCapacityAttempt` returns the id,
  `setMediaCapacityAttemptHostCuda`); going back to `approved` for a re-placement clears it. `jobs.ts` `assertHostFitsTemplate`
  refuses `createJob` and `validateJobParams({ sessionId })` with `media_gpu_host_incompatible` when a template's
  `media_workflow_templates.min_cuda_version` is above the session's KNOWN host; `generation-plans` `checkJobs` passes that code
  through (not `plan_mismatch`). Strict template files: a build without BL-159 marks one carrying `minCudaVersion` invalid (RISK-116).
- **Concurrent sessions, Production section, balance (slice 6, ADR 0023 amendment 1, schema v58).** Requests are
  never refused for another open session; `approveSession` runs the preconditions, clears a crash-stale exclusive
  volume lock (`volumeLock.activeHolder`), then `pending → approved` as ONE `UPDATE` guarded by "active sessions <
  `maxConcurrentSessions`" and "no `media_volume_lock` row" (`approveMediaSessionGuarded`); a refusal re-reads to
  say which guard (`media_session_conflict`) or that the row moved on. The exclusive lock insert of a pull / operator
  pod is guarded the other way (`INSERT … SELECT … WHERE NOT EXISTS active session`), so a session and a pull can
  never both hold the volume (AC-P14-18/-23). Daily cap at approve: spent today + Σ other active sessions'
  `max(0, estimate − live)` + this estimate ≤ cap. The approve returns `{ session, started }`; the Web route answers
  202 with the `approved` row and the start runs in the background (failures land on the row). `watchTick`,
  `bootSweep`, `stopForShutdown` (parallel) and `hasOpenPod` iterate every open session; one session's failure is
  that session's tick result, not the loop's. Balance: `RunpodApiClient.getAccountBalance` -- legacy GraphQL
  `myself { clientBalance currentSpendPerHr spendLimit }`, else the v2 `/billing/pods` + `/billing/networkvolumes`
  totals with the reason (`GET /api/media-generation/balance`). UI: sidebar **Production** (after Content,
  `production-panel.tsx`: balance header; tabs Sessions, Jobs, Models, Workflow templates | Setup), sessions table
  with per-row Approve / Reject / Stop confirmed in the row and 5 s / 15 s polling; Settings → **RunPod** keeps only
  the credentials card.
- **Agent surface (slice 5; Agent API 3.4.0 on `dev`, one MINOR on top of Factory Operator's 3.3.0).** Seven `agent_*` MCP tools in a new `media_generation`
  capability domain, registered directly in `src/mcp/server.ts` against a request/read/job subset of the
  core (`MediaGenerationCoreSubset`): list templates, request a session, get session(s), get limits, create
  / get / cancel a job. Every tool asserts `channelId` is the caller's active (bound) channel first; a
  session or job of another channel is reported as not found; `agent_get_media_limits` discloses only this
  channel's open sessions (`openSessions`, 3.4.0) plus the device-wide `activeSessionCount`/`maxConcurrentSessions` and
  `deviceHasOpenSession`. Request,
  create and cancel pass the MCP mutation gate like `agent_create_collection_request`. No tool can approve,
  start or stop a session: those symbols are absent from `src/mcp` by inventory test (AC-P14-16). The CLI
  gets no agent commands (ADR 0013: the CLI is the operator's tool).
- **Models panel (slice 4, `models.ts`, owner decision D5).** `listModels` is one S3 listing of `models/` on
  the volume (never another prefix); `deleteModel` accepts only a `models/…` object key. `startPull` creates
  a CPU pod (`python:3.12-slim`, default flavor `cpu3c`, 2 vCPU) with the volume at `/workspace` whose
  command installs the Hugging Face CLI and downloads one file into `models/<folder>/`, then idles;
  `pollPulls` (every media watch tick -- never a GET or a CLI listing, which are read-only) terminates the
  pod as soon as the expected key has a size, or marks the pull failed when the pod died first, or timed
  out after 6 h -- never "stop". The in-flight list lives in `app_settings.media_model_pulls`
  (device-local; every mutation is one write transaction merged per pull, review round 6). A GPU
  session's approve is refused while a pull is running (shared volume, AC-P14-18); the CLI mirrors the
  panel (`models`, `model-pull`, `model-rm`).

**Live job progress (BL-144, 2026-10-06, owner msg 1887: real information, not estimates).** `jobs.ts` opens
ComfyUI's websocket **before** submitting a prompt (ComfyUI only sends events to sockets already connected with that
client id; the submit waits up to 5 s for it), keeps it through the unchanged `/history` polling loop, reopens a dropped
one at most every 15 s, and opens one late for a job picked up after a restart (ComfyUI re-sends its current node on
connect, without a prompt id). The socket goes through the media gateway (`comfyui-api.ts` `openProgressStream`: `wss://<pod>-<port>.proxy.runpod.net/ws?clientId=ytm-<jobId>`, the
per-session bearer token in the upgrade request's header, the same "Media gateway" toggle and traffic counter; an open
socket re-checks the toggle every 15 s and closes when it is off). The node count and names come from the template's
graph only while the template is at the job's version. ComfyUI
sends a prompt's execution events only to the client id it was submitted with, so the socket sees exactly that job.
`media-gateway/comfyui-progress.ts` parses `execution_start`, `execution_cached`, `executing`, `progress`, `executed`,
`progress_state`, `execution_success`, `execution_error`, `execution_interrupted`; `media-generation/job-progress.ts`
reduces them into `JobLiveProgress` (current node and its class type from the template graph, the node's steps, nodes done
and cached, a percent from nodes and steps that reaches 100 only on success). It lives in memory in the media core (one
per process on `globalThis`) and is attached to job reads as the optional `progress`. The stream never changes a job's
status: when it cannot open or drops, progress is `unavailable` and the job continues exactly as before (§M). Shown in
Production → Jobs (a bar per generating job, refreshed every 2 s) and Sessions ("Now" under each running session: the
current job, its progress, how many wait). **Live-verified 2026-10-07** on an RTX 4090 pod through RunPod's proxy with the
ACE-Step 1.5 2B turbo template: `execution_start`, `execution_cached`, `executing` per node, `progress_state` and the
KSampler's `progress` (8 of 8) all arrived, node 1 included (the socket connected before the submit). ComfyUI sends
nothing while a node works before its first step, so such a stretch shows only the node name.


## 29. Generation plans (BL-143, ADR 0029) — phase 1

- **Module:** `src/lib/generation-plans/` (contracts / schemas / services / progress / adapters/store / index). It depends on
  `media-generation` through a port (`PlanMediaPort`: get a session, link a session to a plan, check job params, create a job,
  read a job's outputs); `media-generation` imports nothing from it (test AC-GP-16).
- **Storage (schema v66, device-local):**
  - `generation_plans` holds the definition (stages, groups, items with job `params` and `seeds`) as one JSON document, changed only
    by a compare-and-swap on `revision`.
  - `generation_plan_results` holds external-stage reports, verdicts and imported attempts. Its key is (plan, stage, item,
    attempt), so a repeat replaces the row.
  - `generation_plan_events` holds the owner's re-run requests, group notes and plan writes, each with its actor.
  - `media_jobs.plan_id/plan_stage_id/plan_item_key/plan_seed` and `media_sessions.plan_id` link the media rows to a plan.
- **Derived, never stored:** in-app attempts are the linked jobs. Job status maps to queued/running/done/failed; a job whose
  error starts with "interrupted" is an interrupted attempt. Imported attempts are added unless a linked job carries the same
  ref. `progress.ts` computes, from those rows and the plan's sessions when a plan is read:
  - per-stage counts;
  - per-item `missing` (fixed: target − usable attempts; until_accepted: target − accepted − pending, capped by `maxAttempts`);
  - waiting-for-review attempts;
  - spend (final `usdCharged`, live cost while running);
  - budget warnings at 80 % / 100 %;
  - ETA from finished jobs on the current GPU type;
  - events with a `since` cursor.
- **Runs:** `runStage` / `rerun` check everything first: a running session the factory started, of the plan's channel, not
  another plan's; then each job's template and params (`validateJobParams`), and a `seed` parameter when seeds are used. Only
  then do they create jobs one by one. A create failure after the checks returns the jobs created so far and `stoppedAt`.
- **Review:** `reviewQueue` lists the attempts that passed the stage before `owner_review` (BL-153: with the plan's `reviewRejected`, also the playable attempts rejected there -- one rule, `reviewCandidates` in `progress.ts`, feeds the queue, `waitingReview`, todo, the notice and the badge; the shared peer report keeps its format and the reader derives passed/rejected with `validatorOfEntry`). `resolveAudition` picks the latest
  reported `auditionFile`, else the job's own output.
  - The audition route resolves that file through `workspace-exchange`: `resolveSentToYtmFile`, or the new
    `resolveFromYtmJobFile`, which accepts a file only inside `From YTM/media/<jobId>` after realpath.
  - It serves allowlisted types with Range support.
  - The player (`media-review-player.tsx`) loads `wavesurfer.js` and its regions plugin on mount and knows nothing about plans.

- **Phase 2 (other devices):**
  - `src/lib/sync-gateway/per-device-report` holds the shared report mechanics, used by `media-sessions` and `generation-plans`.
    The `media-sessions` report is version 2 since BL-148: an open session also carries its job counts and up to 5 unfinished
    jobs with BL-144 live progress (no `detail`), shown under "Other devices" (ADR 0028 amendment).
    Each device writes only its own report and keeps each peer's latest. A report older than the stored one, one dated in the
    future, or an invalid one is refused; a peer silent for 7 days is forgotten.
  - On the media watcher tick, `publishGenerationPlansShare` (in `generation-plans/index.ts`) first runs `applyPeerVerdicts`,
    then publishes `buildSharedPlans()` together with the outgoing verdicts.
  - A peer's audition is resolved by `resolvePeerAudition` from that peer's report, then proven inside this device's workspace
    by the same `workspace-exchange` resolvers.

## 30. Shared Production settings and the conflict screen (BL-150, ADR 0030)

- **Sync family.** `src/lib/sync-gateway/media-settings/` holds one global Automerge document, `{ format, version, settings: map }`.
  - The genesis is deterministic (`genesisDocument()`: fixed actor, time 0, loaded as a copy so each device writes with its own actor). Independently started documents therefore merge.
  - `scanForConflicts` drops values written identically on both sides.
  - API: `publishChanged` (an owner edit, may settle a conflict), `seedMissing` (never overwrites), `resolveConflict` (one of the conflicting values only), and the runner hooks.
  - It is registered in `run-all-families.ts` as `media_settings`.
- **Applying in Production.** `src/lib/media-generation/settings-sync.ts` holds `SHARED_SETTING_FIELDS`, `ACCOUNT_BOUND_FIELDS` and `planPeerApply`, which is pure. `createSettingsSync().tick()` does the following on the media watcher tick (`src/instrumentation.ts`):
  - seed;
  - read;
  - plan: conflicted fields are held, account-bound fields are held on another account;
  - apply through `base.updateSettings`: the whole patch first, then each field alone on failure. A busy volume is retried; an invalid value is held until the shared value changes;
  - record `settings_applied_from_peer`.
- **Publishing a local edit.** `media-generation/index.ts` wraps `updateSettings` to publish only the fields that save changed. A failure to share never fails the save.
- **UI.**
  - `components/conflict-center.tsx` (`useConflictCenter`, `ConflictCenter`) reads every family's conflicts plus the snapshot divergence, and resolves through each family's own route. Its display helpers are in `conflict-values.ts`: labels, units, word and list diff.
  - The `(app)` layout shows it blocking after the startup steps (`startup-progress.ts`, `loading-overlay.tsx`), and the Merge tab shows it non-blocking.
  - Setup shows `settings-sync-notice.tsx`.

## 31. Analytics and reach data shared between devices (BL-151)

Plan: `docs/roadmap/plans/ANALYTICS_DATA_SHARING_PLAN.md`; owner msgs 2004/2008.

- **Module.** `src/lib/analytics-data-sync/` is shaped like `quota-ledger-sync`.
  - **Files.** Each device writes only its own day files, `<Syncthing root>/analytics-data/<deviceId>/<YYYY-MM-DD>.json` (UTC day of collection). Each holds that day's rows from `exportAnalyticsShareRows`, in `db.ts`.
  - **Publishing.** Today and yesterday are rewritten only when changed; own files older than 45 days are deleted. The Syncthing folder is never created.
  - **Peer files.** They are read once per size/mtime. A file naming another device or day, an invalid file or an oversized one is skipped with a reason.
- **Import.** `importAnalyticsShareRows` runs in one transaction and never deletes. Its merge rules:
  - metrics and video history: the later `collected_at`/`updated_at` wins;
  - collection runs: added once (channel, window, `ran_at`);
  - the channel auto-collect stamp, the reach sync attempt and the job check time: only move forward;
  - report files: added once;
  - reach rows: replaced only by a later-created report;
  - a video metric for a video this device has not synced: skipped;
  - sync attempts: shared without error text.
- **When it runs.**
  - Every 2 minutes on the server (`src/instrumentation.ts`).
  - Before deciding what is stale: `auto-collect-all` and the automatic `reach/sync-all` first call `importPeersFirst()`, which waits at most 30 s and never fails the collection. Each publishes once its collection is done.
  - The existing staleness checks are unchanged. They now see the other device's runs and stamps, so a channel it collected today is current here. The startup window then says "collected on the other computer".
- **Measured on a copy of the Mac's database (2026-10-07).**
  - Everything: 45,780 metric rows and 1,880 reach rows, 4.3 MB as JSON. One day: about 11,000 rows.
  - Export of a day: 35 ms. A full re-import into the same data: 1.1 s, and nothing changed.

## 32. Interface language (BL-152, `docs/roadmap/plans/UI_LANGUAGE_PLAN.md`)

The Web UI shows every text in the person's interface language: English or Russian today, any language later. MCP tool texts, API response bodies and CLI output stay English -- agents and scripts read them (AGENTS.md §B).

- **Module `src/lib/ui-text/`** (flat and pure, like `shared-formatting`; not the §6.2 five-piece layering). Not related to `localization`/`ai-localization`, which translate *video* metadata.
  - `locales/en/<area>.ts` -- the English source, one file per area of the app; `locales/en.ts` merges them into one flat map, and `UiTextKey` is its key type. `locales/ru/<area>.ts` -- each typed `Record<keyof typeof <en area>, string>`, so a missing or extra key fails `tsc` and the build. A new language = a new locale folder + `<lang>.ts` + one entry in `UI_LANGUAGES`.
  - `formatMessage`: `{param}` substitution and `{n, plural, one {…} few {…} many {…} other {…}}` via `Intl.PluralRules` (no ICU library). Number params and `formatNumber` use the language's own marks (`en-US`, `ru-RU`), never the browser's locale. Dates keep `DD.MM.YYYY` in every language (`shared-formatting`).
  - `UiMessage` (`{ key, params }` or `{ text }`) lets pure `.ts` helpers return display text without holding English.
  - `apiErrorText`: a failed API answer `{ error: <DomainErrorCode>, message }`. English shows the server's message exactly as before; another language shows `errors.<code>` in words with the server's message as the detail; an unknown code shows the server's text.
- **Choosing the language.** `requestUiLanguage()` (`ui-text/server.ts`) in the root layout: the `ui_language` cookie (set by `PUT /api/ui-language`, `{ language: null }` = system) wins; else the first supported language of `Accept-Language` (the browser on the same computer follows the system language); else English. A cookie and not `app_settings`: the root layout renders every page, the recovery page included, which must work while the database cannot open. The choice is per browser profile on a computer and never syncs between devices. The layout sets `<html lang>` and passes `language`, `source` and `systemLanguage` to `UiTextProvider`; components call `useT()` / `useUiText()`. A change calls `router.refresh()`, so the whole interface re-renders without a reload.
- **Keeping it complete.** `locales.test.ts` (every language has every key, same placeholders, unique keys across areas, well-formed plurals) and `literal-text.inventory.test.ts` (the scan in `src/test-support/ui-text-literals.ts` fails on English JSX text, text attributes and sentence-like strings in `src/components` / `src/app`; a non-interface string is marked `ui-text-ignore` with a reason).

## 33. Servers and Media, other channels' work, plan move, reviewing from two computers (BL-157, ADR 0031)

Plan: `docs/roadmap/plans/SERVERS_MEDIA_PLAN.md` (FO-REQ-0009, FO-MSG-0011). Branch `feature/servers-media`.

- **Sections.**
  - `/servers/<tab>` (`ServersPanel`) holds the shared infrastructure:
    - Sessions, every channel's, named via `useChannelNames`, with a channel filter;
    - Models and Templates;
    - Setup, with the capacity log.
  - `/media/<tab>` (`MediaPanel`) holds the active channel's Plans (and `/media/plans/<id>/review`) and Jobs, plus
    `NowRunningLine`. It remounts when the channel changes.
  - `production/[[...rest]]` redirects with `productionRedirectTarget`: plans and jobs go to Media, everything else to Servers.
  - The tab lists live in `section-tabs.ts` (`SERVERS_TABS`, `MEDIA_TABS`).
- **Active-channel scoping of Media (ADR 0004 (b)).**
  - `generation-plans/shared.ts` `planHandler` calls `core.assertPlanOfChannel(planId, activeChannelOf(userId))` first. The
    audition and reference handlers do the same check through `assertVisible`. The peer routes use `assertPeerPlanOfChannel`,
    with the channel named in the report.
  - The plans list and the peer plans list filter on the server. The peers list also filters the verdicts sent from here and
    the other devices' claims to the plans it shows. Jobs use `GET /api/media-generation/jobs?scope=active`.
  - With no active channel, everything is empty or `not_found`.
- **Other channels' work (exception to ADR 0004: counts and names -- plan, wave and stage titles and notice kinds; never
  tracks, files or verdicts).**
  - `core.channelSummary({ activeChannelId, connectedChannelIds })` returns, per connected channel:
    - waiting passed / rejected;
    - the plans with waiting tracks;
    - each wave's waiting count;
    - the plans' notices other than `review_waiting`. Another device's notices are read from its report with `sharedNotices`,
      which keeps only well-formed known kinds.
  - Other devices' plans count, minus the verdicts sent from here. A channel not connected here is never counted.
  - `GET /api/generation-plans/summary` puts the active channel's counts on top (the Media badge) and `channels` beside them.
    The layout polls it every 60 s and when the channel changes.
  - The channel switcher shows `waitingLabel`.
  - The bell (`device-sync-bell.tsx`) shows `otherChannelEntries`:
    - one entry per non-active channel and type of work, derived on every poll;
    - entries cannot be dismissed, and the dot is sky blue;
    - an entry's button runs `activateStoredChannel`, waits until `channel.id` matches, then `router.push`es the place.
  - The pure rules are in `components/channel-work.ts`.
- **Plan move (`movePlan`, `factory_plan_move`).**
  - It is serialized per plan and uses the plan's compare-and-swap.
  - Refused (`plan_invalid`) when:
    - the plan is not active (`plan_closed`);
    - the target is the same channel;
    - the target is not connected;
    - the target has no workspace;
    - the plan has an unfinished job;
    - any file is missing.
  - The file check goes through the `files` port: `resolveSentToYtmFile` in the target workspace, the player's own rules. It
    covers every distinct `auditionFile` of every result row and every reference. The answer reports
    `{ checked, missing (≤ 500), missingCount, unfinishedJobs, moved }`. `checkOnly` writes nothing.
  - On success it records `plan_moved { from, to, checked }`.
  - A plan changed during the check (its revision moved) is refused, to be asked again. The factory's plan-linked
    `create_job` runs under the same lock (`withPlanLock`, on the trimmed plan id), so a move cannot pass between its check and
    the job's creation.
  - Only the factory links a job or a session to a plan. A channel agent's `agent_create_media_job` refuses a `plan` field and
    `agent_request_media_session` a `planId`. The operator's `POST /api/media-generation/jobs` and `/sessions` and the CLI
    `media job-create` drop them.
  - `PlanJobRow.channelId` (`media_jobs.channel_id`) makes `resolveAudition` of a job output use the job's channel. The report's
    `jobChannelId` does the same for the other device.
- **Plans report version 2** (`GENERATION_PLANS_REPORT_VERSION`; the reader accepts 1 and 2, and every level stays strict).
  - On a review entry: `jobChannelId` and `history` (≤ 10).
  - On a plan: `batches` (`reviewBatches`).
  - On a group: `ownerNote`.
  - On the report: `claims` (≤ 200).
- **Plans report version 3 (BL-162, FO-REQ-0013; the reader accepts 1–3).**
  - On a group: `ownerNoteAt` -- when the current owner note was written (`ownerNoteTimes`: the newest not-superseded owner
    `group_note` event, by `writtenAt` for one that came from another device).
  - On the report: `groupNotes` (≤ 200) -- the newest wave note per device, plan and wave written here on another device's plan
    (schema v73, `generation_plan_peer_group_notes`, kept 30 days).
  - `applyPeerGroupNotes` runs with `applyPeerVerdicts` before each report: a note written after the wave's last owner-note
    change is applied (`ownerNote` set, `group_note { noteId, fromDevice, writtenAt }`); an older one is recorded with
    `superseded: true`. A note id already in an event is passed over; a note dated > 5 min ahead, for an unknown wave or a
    closed plan is skipped.
  - `recordPeerGroupNote` refuses a device whose report is below version 3 (`plan_invalid`, `peer_update_required`).
- **Waves.**
  - `reviewBatches` (pure, in `progress.ts`) returns per group: title, `note`, `ownerNote`, earliest attempt, templates, the
    params that differ between the group's items, and passed / rejected at the stage before `owner_review`.
  - `setGroupNote` from the owner writes `ownerNote`; from the factory it writes `note`. An upsert keeps `ownerNote`.
  - `recordGroupsReviewed` compares the review entries before and after an owner verdict, given here or applied from a peer. A
    wave that goes from waiting to none records `group_reviewed { groupId, accepted, rejected, overridesValidator }`.
  - The review screen:
    - lists the waves (`waveSummaries`);
    - walks one wave together with the validator filter (`visibleEntries`);
    - shows the wave's context card, its "done" summary and the next wave;
    - heads the screen with "<channel> · Review · <plan> · <wave>".
- **Two computers.**
  - **History (schema v69, `generation_plan_verdict_history`, device-local on the owning device).**
    - `recordOwnerVerdict` appends a row with `deviceLabel`, the host name.
    - `applyPeerVerdicts` appends a row with the sending device and the verdict's own note. A peer verdict older than the
      stored one is not applied but is still appended, and is recorded once as `peer_verdict { superseded: true }`.
    - `seedHistory`: before the first history row of an attempt, a current verdict stored before v69 goes in first. Its device
      is read from the note's ` (from <device>)` suffix only when a `peer_verdict` event from that device on that item proves the
      relay. Otherwise it is this device, and the note is kept whole. A replacement or an older peer verdict therefore never hides
      it. History rows are clamped to the report's bounds when they are shared.
    - `planEvents(..., history)` emits one `owner_verdict` per history row, with `device`. A key with no history row gets one
      event from the result row.
  - **Claims (schema v70, `generation_plan_review_claims`, this device's own).**
    - `claimReview` takes `{ deviceId?, planId, scope: attempt|group, itemKey/attemptRef | groupId, release? }`.
    - The claim id is a sha256 of (scope, owning device, plan[, group]). That gives one track claim per plan, which moves with
      the track, and one claim per wave.
    - A claim lasts 90 s (BL-162; was 10 minutes). `since` is kept while the same track is renewed. A verdict here ends this
      device's claim on that track.
    - The claim routes (`[planId]/claim`, `peers/[deviceId]/[planId]/claim`) publish the report at once.
    - `claimReview` runs under the plan's lock, so a release and the next claim sent together keep the new claim. A release
      removes only this device's own claim (the same track) and needs no plan or channel, so it works after a channel switch.
    - `claimsOn` and `peerClaims` read the peers' live claims. A claim that reaches more than 15 minutes ahead is ignored.
    - The screen (BL-162):
      - renews its claims every 30 s and releases them on leaving (`keepalive`);
      - reads the others' claims every 3 s from `GET .../claim` (not the whole queue);
      - passes over claimed tracks (`claimOf`, `stepIndex`, `nextWaitingIndex(skip)`); the queue column still opens one on a
        click ("show them too" and "take this wave" were removed: what is in work follows what is open, owner msg 2263);
      - when two computers opened the same track within the sync delay, the later opener moves on to the next free track,
        but only while its verdict draft is untouched.
  - **Presence files (BL-162, `sync-gateway/generation-plans/presence.ts`).** Each device writes its live claims into
    `<sync folder>/generation-plans/global/<deviceId>.presence.json` (`ytm-review-presence` v1, strict, ≤ 256 KB read)
    the moment a claim changes; `peerClaims` reads the others' files straight from disk and, for a device that has one,
    ignores the claims in its (older) report. A file must name the device it is named after. The sync runner only reads
    `*.automerge`, so it never sees these files.
  - **Pending verdicts.**
    - On the owning device, `pendingPeerVerdicts` uses the same rules as `applyPeerVerdicts`.
    - `withPending` overlays a not-yet-applied verdict from another device as given (`pendingFrom`), in the queue, `summary` and
      `channelSummary` (`ownerQueue`). The owner's plan list and plan card (`listPlans` / `getPlan` with `ownerView`) adjust the
      items' and waves' waiting counts and the `review_waiting` notice the same way (`ownerProgress`). The factory's reads do not.
  - **Replace guard.**
    - `recordOwnerVerdict` and `recordPeerVerdict` refuse an existing verdict without `replace`: one here, relayed, sent from
      here, or pending from a peer. The error is `plan_verdict_exists` (409, `planVerdictExists`) with
      `{ existing: { result, rating, device, at } }`.
    - The screen asks first (`ConfirmDialog`) and asks again on a 409.
- **Limits** (RISK-114, RISK-119):
  - claims are advisory and arrive within the sync delay (seconds with the presence files and a 1 s Syncthing watch delay);
  - both computers must run the same report version (3 since BL-162).
- **Screens (BL-162, `docs/roadmap/plans/MEDIA_UX_REDESIGN_PLAN.md`).** The review screen is a window-high workstation:
  a toolbar (back, plan, wave picker, progress, validator filter, "About the wave", "View") and three columns -- the player
  with the verdict under it, the auto-check, the queue. The Plans list holds this device's and the other devices' plans of
  the channel; one card (`plan-card-model.ts` adapts another device's report defensively) with KPI tiles, a stage funnel and
  a waves table; actions that change the plan are shown disabled "on <computer>" for another device's plan.

## 34. Agent tokens shared between devices, and the Producer role (BL-160, BL-161, ADR 0033, ADR 0034)

Plan: `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md`. Status: on `feature/producer-role-synced-tokens`, not merged.

**Tokens across devices (BL-160).**
- `src/lib/sync-gateway/agent-tokens` is a per-device report family (the `media-sessions` shape): each device writes only its own report of
  the agent tokens it knows -- `{hash, role, channelId, userId, label, createdAt, revokedAt}`, never the token -- and keeps the peers' latest
  reports. It merges nothing and imports nothing from the token modules; `run-all-families.ts` runs it with the others.
- `src/lib/agent-token-sync` owns the rules (`reconcileAgentTokens`, a pure function) and applies them through `db.ts`
  (`listAgentTokenRowsForSync`, `applyAgentTokenSyncPlan`: one transaction, revocations before inserts so the role tables' one-active
  indexes hold). Rules: joined by hash; revoked anywhere = revoked (earliest time), never undone; a peer record conflicting with a local row's
  role/channel/account is ignored; one active token per slot, newest `createdAt` wins (tie: larger hash), losers revoked at the winner's
  `createdAt`; a token's `createdAt` is the earliest any device reports (local rows re-dated); a peer record dated more than 5 min ahead
  is ignored. Every device computes the same result from the same records. The family's peer reports are never forgotten
  (`forgetAfterMs: null` on the per-device report core) and an unchanged report is republished daily.
- Timing: `src/instrumentation.ts` runs a step after each 60 s family cycle and once 5 s after start (agent-tokens family only); while
  the database is paused (recovery mode, an operation lock) it still exchanges the agent-tokens files, without applying. The three
  token stores call `shareAgentTokenChangeSoon()` after an issue/import/rotate/revoke: a publish-only step (no peer apply, so it also works in
  recovery mode) that pushes the family at once.
- Verification is untouched: each token module reads its own table; a learned channel token still needs the channel connected here under the
  recorded Google account (`users.id` = Google `sub`). The token tables stay out of the snapshot. `POST /api/channel-connections/disconnect`
  no longer revokes the channel's token.
- Trust: the shared folder's reports are unsigned (RISK-117).

**The Producer role (BL-161).**
- Token: `src/lib/role-agent-tokens` is the role-token logic extracted from `factory-agent-tokens` (now a thin wrapper);
  `src/lib/producer-agent-tokens` adds `ytom_pr_` on `producer_agent_tokens` (v72, partial unique index, one active).
- Endpoint: `src/lib/producer-mcp-endpoint` (the factory endpoint's checks; no request-level scope) and `src/app/api/mcp/producer/route.ts`,
  which wires a `ProducerSession` (re-verify, `resolveChannelUser` = the channel's `connected_user_id` if Settings → Channels lists it,
  `recordCall`, `listChannels`, `portfolioOverview`) into `createMcpServer`'s producer mode. The endpoint also logs every `tools/call`
  the MCP layer refused before a tool ran (it peeks at the request body and subtracts the calls the server's log recorded).
- `createMcpServer` producer mode: `registerTool` routes every tool through `producerRegistration`. A `bound` tool in the closed list
  (`src/mcp/producer-tools.ts`, each entry naming its READ capability) gets `.extend({ channelId })` (required; `query_market_intelligence`'s
  own `channelId` moves to `watchlistChannelId`); its wrapper re-verifies, resolves the channel's account (none: `CHANNEL_NOT_ACTIVE`), runs the
  unchanged handler inside `runInAgentSession({tokenId, channelId, userId})` for that one call, logs it, and adds `forChannelId`. The
  `producer-only` tools (classification class) run without a scope; one that names a `channelId` (the proposal tools, BL-163) is logged under
  it and answers with `forChannelId`, so the endpoint matches the call to the server's own log entry. A channel session never registers a producer tool; the SDK registration
  is still one call.
- `src/lib/portfolio-overview` adds up stored data per channel (`channel_metrics_daily`, Reach totals read in the channel's scope, synced
  videos' `publishedAt`, freshness); a source with nothing stored is `null`, not zero.
- `producer_call_log` (v72) records every call with tool, channel, outcome and error code; pruned to 90 days on insert; shown on the Producer
  card (`GET /api/producer-agent-token/calls`).

## 35. Watchlist hygiene and agent proposals (BL-163, FO-REQ-0014, ADR 0034 Amendment 1)

Plan: `docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md`. Schema v74.

**Activity and pause (market-intelligence).**
- Read model: `listLatestUploadDates` = `MAX(published_at)` of each entry's retained video snapshots (the 30-day window applies to API rows,
  so a paused entry's date fades). `watchlistActivityOf` derives `inactive` = known and older than `monthsBefore(now, N)`; N is the
  `market_intelligence_inactive_after_months` setting (default 6, 1-60). Every watchlist read carries the raw date, `inactive`, `pausedAt`
  and `pausedReason`; nothing is computed from another channel's statistics (III.E.4.h).
- Pause is stored state (`research_channels.paused_at`, `paused_reason` `inactive` | `owner`, `resumed_at`); inactivity only sets it.
  `claimStaleResearchChannelsForCollection` skips paused rows, so neither auto-collection nor an approved collection request collects them.
- Detector: `evaluateInactivity` runs before and after `collectStaleChannels` in `runCollectionIfStale` (and on demand; also when the
  refresh waits for the quota reserve, since it reads only stored data). A detector failure is logged and never fails the collection. It
  skips paused entries, unknown dates, active ones and entries the owner resumed while already inactive (`monthsBefore(resumedAt, N) >=
  newest upload`; a resume from an unrelated pause earlier does not shield), and for the rest calls `pauseInactiveResearchChannel`:
  one transaction that pauses only a still-unpaused row and inserts the system proposal `watchlist.delete` with `onConflictDoNothing` on the
  pending dedupe key (`watchlist.delete|<id>`), so two connections or two passes add one. The proposal stores N, not the upload date
  (another channel's API data may be kept 30 days at most, a proposal can wait longer); the owner's card reads the entry's current date
  from the watchlist. `monthsBefore` counts calendar months and clamps the day (Aug 31 minus 6 months is Feb 28).
- A paused entry has its own collection status `paused` (`classifyCollectionStatus`), which `isCollectionWarning` leaves out of the
  "needs attention" count and filter.
- `setResearchChannelPause` writes only a state change (a paused entry keeps its first reason; resuming stamps `resumed_at`).
  `deleteResearchChannel` also deletes the entry's `channel_record_assignments` rows and its pending proposals.

**Agent proposals (`src/lib/agent-proposals/`).**
- Store: `agent_proposals` (source `producer` | `system`, kind, `channel_id`, `target_id`, `payload_json`, `text`, status
  `pending | applied | rejected | failed`, `dedupe_key` with a unique index -- cleared when decided, so it binds only pending rows --,
  decision fields, `done_at`). In the device snapshot; `notApiData`.
- Services: `submitProducerProposal` checks the channel is connected, the payload per kind (strict zod), and the current state through
  the watchlist port (the entry exists and this channel follows it; pause needs an active entry, resume a paused one; add refuses an entry the
  channel already follows), then inserts; a pending duplicate is `AGENT_PROPOSAL_DUPLICATE`. `approveAgentProposal` checks (for a
  hypothesis) that the proposal's channel is the session's active channel -- `createHypothesis` requires it -- then claims (`decide` to
  `applied`, atomic on `status = pending`) and only then applies; a throw is stored as `failed` with its message (RISK-120 for a stop in
  between). Claim-first is what makes a double approve apply once, and keeps a deletion (which drops the entry's pending proposals) from
  dropping the proposal being applied. `rejectAgentProposal` requires a trimmed comment.
- Apply goes through public cores only: `market-intelligence` (`addToWatchlist` with `createdVia: "mcp"`, `setWatchlistPause`,
  `removeFromWatchlist`, `getWatchlistEntry`, `listWatchlist` for labels), `market-assignments` (`listAssignments` / `setAssignment` for
  follow and unfollow) and `decision-engine` (`createHypothesis`, `createdBy: "producer"`). None of them depends on this module (§M).
- Cleanup runs only on the gated writes (approve, reject, mark-done; never on a read, so nothing is deleted during a device handoff):
  decided rows that are done, or decided more than 90 days ago, are deleted. Reads leave such rows out without deleting them.
- Counts and lists: the inbox count is a SQL `COUNT` of pending rows; lists are capped (500 for the Producer and the owner's pending
  list, 200 newest decided for the owner).
- Late refusals that keep the proposal pending: an add whose channel is no longer connected (checked before the claim) and a
  hypothesis whose channel stopped being the active one between the check and the creation (the claim is reopened).
- Two entry points: `createAgentProposalSubmitCore` (wired into `ProducerSession.proposals` by the Producer session deps,
  `src/lib/producer-mcp-endpoint/session-deps.ts` since BL-166) and
  `createAgentProposalReviewCore` (the Web routes and the summary count). The approval inventory test pins that split.

## 36. Video milestones: day-7 and day-28 retention and totals (BL-166, FO-REQ-0015 items 1 and 8)

Plan: `docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md` (AC-VM-01..08). Schema v75.

- **Windows.** `milestoneWindow(publishedAt, M)` = the Pacific publish date .. +M-1 (inclusive); `isMilestoneDue` once today (Pacific) is at
  least `MILESTONE_LAG_DAYS` (reporting lag + 1 = 3) after the window end.
- **Collection** (`createVideoMilestoneServices.collectDueMilestones`, analytics core). `planDueMilestones` takes never-attempted milestones by
  window end, then retries whose `next_attempt_at` has passed, at most 25 per channel per run. Each costs two `queryChannelBreakdownReport`
  calls (gateway, `dimensions` optional): `elapsedVideoTimeRatio` with the five retention metrics, and the four totals with no dimension, both
  `video==<id>` over the window. A per-video error records an attempt (`recordVideoMilestoneFailure`: retry after 24 h, `failed` at 3); reads
  off, quota, sign-in or channel errors stop the run with nothing counted. The core wraps it in the analytics quota context and
  `isBackgroundReadAllowed("analytics")`. `/api/analytics/auto-collect-all` runs it after the daily rows for each channel whose collection
  did not fail, each in its own try/catch.
- **Storage.** `video_milestones` (primary key `video_id, milestone_days`): status, attempts, last error, next attempt, collected time, the
  four totals and `retention_json` (as returned, `[]` when none). Classified `authorized`; device-local (not in the snapshot, not synced).
- **Reads.** `listVideoMilestones` (channel scope, joins each row with the video's stored `durationSeconds`, drops rows whose video the
  channel does not have) backs `agent_get_video_milestones`. `producer_upload_milestones` is built by `createUploadMilestonesServices`
  (`src/lib/portfolio-overview/upload-milestones.ts`): uploads by UTC date in the range, windows from the analytics helpers (passed in, so
  the module does not import analytics), stored rows, and `getVideoWindowsReach` (`reach-reports`: one `listDaily` over the span of all
  windows, per-window `daysWithData`, summed impressions, `weightedCtr`), read in each channel's agent scope. A Reach figure is null unless
  Reach is `ready` and the window has a stored day.
