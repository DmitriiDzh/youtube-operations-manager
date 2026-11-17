> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

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

**Language move (BL-232, 2026-10-29, PRD-REQ-0043).** `changesets.proposeLanguageMove` builds on the same deletion machinery: one source `deletion` Change Set whose per-video unit is a `delete` pair for `fromLanguage` plus an `add` pair for `toLanguage` whose `proposedValue` is the synced `fromLanguage` text (the delete's `baselineValue`), so both come from one read. Videos where either code is the video's own language or the channel's language baseline, or whose `fromLanguage` text is empty, are never included (listed in the result); a video that already has `toLanguage` gets only the delete. Batches already put all approved changes of a video into one ledger row and one `videos.update` (`buildSafeLocalizationsPayload`, delete applied last, other locales kept), and the read-back (`classifyFreshStateAgainstAttempt`) counts the write done only when `toLanguage` reads the text and `fromLanguage` reads empty. Two new rules. Pairing: `unpairedMoveHalves` (`src/lib/batches/targets.ts`) refuses one half of a move (the delete, or the add) when the other half of the same set and video neither goes in the same send nor is already on YouTube -- the delete alone would lose the text, the add alone would copy text that may be stale when the delete follows; checked by the send service before it rejects or creates anything, and by `createBatch` for the manual Batches selection (`listSetChanges`, loaded once per set). Target check: the set is marked in its `schemaVersion` (`language-move/1 <from> <to>`, `parseLanguageMoveMarker`), the Batches change adapter carries the move on each change (`PendingChangeRecord.languageMove`), and `runSafetyPipeline` makes the row a CONFLICT (`missingMoveTargets`, on the fresh fetch) when a move's delete would leave the target without a title -- not added by this row, absent or empty on YouTube, or deleted by another set in the same row. Ordinary deletion sets (deletes only, no marker) are unaffected. As for every Batch write, a video whose own language differs from the channel's language baseline is also aligned to it in the same write (PROJECT_SPEC §14, FO-REQ-0022); `get_change_set.languageAlignments` lists such videos before approval.

Merge semantics for an approved deletion: `buildSafeLocalizationsPayload` collects every `"delete"`-typed change's `language` into a `Set` while processing the batch's other changes normally, then deletes each collected language from the final `localizations` object **after** the main loop — so a `"delete"` always wins over a same-locale `"modify"` in the same approved set, independent of which one appears first in the change list (tested both orders, `src/lib/batches/merge.test.ts`).

**Deliberately out of scope for this slice** (advisor-reviewed before implementation): no UI triggers a deletion proposal yet (`change-set-review.tsx`/`languages-manager.tsx` only got a one-line source-label fix so a `"deletion"` Change Set doesn't mis-render as "XLSX import" if one is ever created some other way), and no restore mechanism exists — §16's 30-day local recovery window is a UI/data-retention feature that has no testable effect while `assertLiveWritesAuthorized()` (§2.9a) still blocks every real YouTube write unconditionally; building it now would be exercised only against a payload that can never actually leave this database. Both are planned for a later, separately-assigned slice.

---

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
