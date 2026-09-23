# ARCHITECTURE.md

Living architecture reference for this repository. For the historical TubeMaster-derived baseline and Phase 0/1 verification, see `docs/UPSTREAM_ANALYSIS.md` and `docs/UPSTREAM_BASELINE.md`. For the product roadmap and safety rules, see `docs/PROJECT_SPEC.md`. For how to extend this architecture, see `docs/DEVELOPMENT_PLAYBOOK.md`. For the current risk register and release gates, see `docs/TECHNICAL_DEBT.md`. For significant architectural decisions and their rationale, see `docs/decisions/`.

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

### 7.1 Schema (additive to the existing TubeMaster-derived tables)

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
3. **This is not a permanent decision.** `docs/UPSTREAM_ANALYSIS.md` §9 (risk #2) already flagged that the idempotent-ALTER pattern will become error-prone as more tables accumulate. Phase 4 added two more tables (`change_sets`, `changes`, §6.10) purely additively, confirming the decision still holds; `batches`/`audit`/`backups` remain future additions per the roadmap. The threshold for revisiting this is unchanged: **the first schema change that is not purely additive** (a column type change, a `NOT NULL` backfill, a data transformation, or a multi-step migration ordering requirement) — at that point, introduce Drizzle Kit migrations via a dedicated ADR (`docs/decisions/00X-database-migrations.md`, per `docs/PROJECT_SPEC.md` §45), not silently.

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

- **Content** (Phase 2; restyled 2026-09-20, `docs/roadmap/plans/STUDIO_PARITY_PLAN.md` Slice S2, formerly named "Sync") — `src/components/content-manager.tsx`: a Studio-shaped video table (Video/Access/Date/Views/Comments columns, search + privacy filter, pagination) for the single active channel (no channel picker — `docs/decisions/0004-active-channel-read-scoping.md`), with a staleness-gated (~20 min) automatic re-sync on tab activation and a manual "Sync now" for an explicit forced refresh (`docs/roadmap/plans/TAB_REFRESH_AND_CHANNEL_UI_PLAN.md` §4). Existing localization languages still shown as badges under each title — a capability this app has that Studio's own Content page doesn't, kept rather than dropped for parity's sake.
- **Languages** (Phase 3, extended in Phase 4; merged with AI Localization 2026-09-20, redesigned again 2026-09-21, `docs/roadmap/plans/LANGUAGES_TAB_MERGE_PLAN.md` and `LANGUAGES_UX_REDESIGN_PLAN.md`) — `src/components/languages-manager.tsx`: one table is the primary surface (Video/Published/one ✓-or-— column per language actually present in the channel/Last modified, sortable by any header). One shared row-selection set drives both bulk AI generation and XLSX export; checking ≥1 row opens a contextual bar ("Generate with AI ▾"/"Export to XLSX"). Clicking a video opens it in the shared `video-detail-modal.tsx` popup (§2.9e in `docs/SYSTEM_MAP.md` — not a row expansion, since 2026-09-21) showing the original title/description, every existing locale, and an inline "Generate with AI for this video" mini-form/review step feeding the same Change-Set-creation path as the bulk flow. A small "+N" button under each language header bulk-selects every video missing it. XLSX import/export remains a secondary, collapsed-by-default section. A change-set queue below the table is filtered by three sub-tabs ("Все"/"В процессе"/"Одобрено") mapped onto `ChangeSet.status`, not onto any per-video state Studio's own UI assumes but this app's approval model doesn't have. "Одобрено" never implies a real YouTube write happened (Phase 5's write barrier is unaffected). See `docs/SYSTEM_MAP.md` §2.9/§2.9b/§2.9e for the full, current detail — this paragraph is kept intentionally brief and should be treated as a pointer, not the source of truth, for exactly which UI slice shipped when.

Both follow the existing component conventions (Tailwind dark theme, same button/card styling used throughout the dashboard). No existing tab, route, or component was modified beyond adding the new tab entries, their conditional render branches, and (for the 2026-09-20 merge) the `LocalizationOverviewRow.lastSyncedAt` field and `ChangeSetReview`'s optional callback described above.

**Removed, 2026-09-20 (project owner: "давай удалим их, т.к. пока не вижу им применения"):** the **Manual** tab (`src/components/manual-mode.tsx`, deleted) and the **Rules** tab (auto-playlisting: `src/components/{rule-form,rule-list,run-button}.tsx`, `src/app/api/{rules,run}/route.ts`, all deleted) -- both inherited from the upstream TubeMaster baseline (Phase 0/1), unrelated to this project's own localization/Change-Set/Batch feature set. `src/lib/playlist-management/` and its Web API routes (`/api/youtube/{videos,playlists,create-playlist,add-to-playlist,remove-from-playlist}`) were deliberately **kept** -- they are the same domain module the MCP `playlist_*` tools and CLI `playlist` namespace already depend on (`docs/SYSTEM_MAP.md` §2.12/§2.13), a programmatic surface independent of whether a Web UI tab exists for it (`AGENTS.md` §B's dev/ops split -- a future operations agent can still manage playlists via MCP/API with no Manual tab present). The `rules` database table's own `CREATE TABLE IF NOT EXISTS` statement was deliberately left in `src/lib/db.ts`'s frozen baseline rather than replaced with a `DROP TABLE` migration -- see the comment immediately above it for why (a subtractive schema change needs its own ADR per `docs/decisions/0001-additive-idempotent-schema-strategy.md`, not needed here since nothing reads/writes that table anymore).

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
(Variant A — no simultaneous multi-device editing, no application-managed sync, no automatic
database merging). Four new leaf/near-leaf modules plus one small domain-adjacent module:

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
write-pipeline tables (`batches`, `batch_ledger_rows`, `batch_attempts`, `audit_events`) only.
`SNAPSHOT_TRANSFERRED_TABLES` (the snapshot *file's* own contents, §13.3) additionally includes
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
widgets, both on Home and on Analytics' Content sub-tab) are rejected by the real API as unknown
metric identifiers. These are not the same as the `annotation*`/`card*` legacy metrics already in
`ANALYTICS_METRIC_NAMES` (dead since 2019, always zero) — they are a structurally different,
genuinely unavailable-via-public-API capability. No code path in this repository requests them.

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
aggregation `channel-overview-panel.tsx`'s client-side `fetchTopContent` already does for the
Analytics "Overview" tab -- not unified in this slice (see RISK-50 for why).

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
other three gateways already use -- shown in the "Google Cloud connection" Settings card. Like
`mcp_tool_calls`, it never records a `blocked` outcome: there is no enable/disable toggle for this
category, so every attempt is allowed by definition.

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
