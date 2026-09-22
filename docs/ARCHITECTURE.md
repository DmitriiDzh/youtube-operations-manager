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
copy of the snapshot's `data.db` to the live connection and, in one transaction: fully replaces
every "application state" table (`channels`, `videos`, `change_sets`, `changes`, `batches`,
`batch_ledger_rows`, `batch_attempts`, `audit_events`, `channel_editorial_profiles`,
`ai_localization_generation_provenance`, `rules`), and upserts `ai_connections` by `id` (`INSERT
OR REPLACE ... SELECT` — an `INSERT ... SELECT ... ON CONFLICT DO UPDATE` was tried first and
found unsupported by this `@libsql/client` build's SQLite, verified directly). `users` and
`ai_connection_credentials` are never referenced by this code path at all — there is no
"exclude" branch to bypass, because no code path here can reach them structurally. `users.id` was
confirmed, by reading `src/lib/auth.ts`'s `session()` callback and `src/lib/db.ts`'s
`upsertUserOAuthOnSignIn`, to be the Google OAuth `sub` claim — a stable, provider-issued
identity, not a locally-generated artifact — which is why no identifier remapping is ever needed
for `channels.connectedUserId`/`rules.userId` across devices.

### 13.5 Restricted recovery mode is computed, never cached

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

### 13.6 One gate, three call sites

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

### 13.7 Known limitations

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

## 14. Phase 8 (Intelligence Foundation) — schema-only first sub-slice

### 14.1 Status

Assigned 2026-09-22 (Telegram, project owner: "Приступить к полной реализации фазы 8"), on
`feature/phase-8-intelligence-foundation` (not yet merged to `dev` without the owner's separate,
explicit consent for that branch specifically). `docs/roadmap/plans/PHASE_8_PLAN.md` §6 slice 2
(the additive `video_metrics_daily` table + tests) is implemented and reviewed. The owner answered
§8's two required decisions on 2026-09-22 (Telegram msg 356, recorded verbatim in the plan's §10):
OAuth scope approved, and metric scope widened to every metric `yt-analytics.readonly` covers (not
`views` alone) — see §14.2 below for the schema consequence. Slice 1 (OAuth scope, BL-051) is now
**done** — `YOUTUBE_ANALYTICS_READ_SCOPE` added to `src/lib/auth.ts`'s `YOUTUBE_SCOPES`; see
§2.1's own updated entry in `docs/SYSTEM_MAP.md` for why no separate re-consent mechanism needed
to be built (every existing sign-in path already forces full consent). Slices 3 (Analytics
adapter) and 4 (manual "collect now" trigger, Web UI) are **assigned, not yet implemented**
(`docs/roadmap/BACKLOG.md` BL-052/BL-053); a fourth item, BL-054 (daily staleness-based
auto-collection + a configurable local sync-time/timezone setting), was also authorized the same
day, superseding the plan's original "no scheduling" boundary (plan §10 items
3-4).

### 14.2 Schema (additive, `SCHEMA_MIGRATIONS` version 8)

```text
video_metrics_daily (new) — channelId, videoId, metricDate (ISO date), metricName (e.g. "views"),
                             metricValue (REAL), collectedAt
                             PRIMARY KEY (videoId, metricDate, metricName)
                             + index on channelId
```

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

No `src/lib/analytics/` (or equivalent) domain module exists yet — these two functions are called
directly by tests today (`src/lib/db.test.ts`), with no adapter/service/route consumer, since a
consumer needs the still-undecided Analytics API adapter (slice 3) to have anything real to write.
Wrapping these in a store adapter follows the normal §6.2 pattern once that module exists.

### 14.4 Known limitations

No Analytics API client, no OAuth scope request, no route, no UI — this slice is the persistence
primitive only, exactly `PHASE_8_PLAN.md` §6 slice 2's scope, deliberately not a vertical slice
end-to-end. See `docs/roadmap/BACKLOG.md` BL-051/BL-052/BL-053/BL-054 for the current status of
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
