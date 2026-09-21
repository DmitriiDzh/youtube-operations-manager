# Automerge Migration Plan — CRDT-backed draft/change-set layer

Produced 2026-09-21, per the project owner's direct Telegram request ("Создай план перехода на
automerge") following a dedicated research pass this same session and
`docs/decisions/0006-automerge-for-draft-layer.md`. **This is a plan, not an implementation.**
Nothing here is authorized to run until its own explicit slice-by-slice assignment (`AGENTS.md`
§C) — this plan itself does not add the `automerge` dependency, write any code, or touch the
database schema.

This follows `docs/roadmap/FUTURE_PHASES.md` §9's 9-step planning sequence, the same structure
`PHASE_7_PLAN.md` through `PHASE_10_PLAN.md` use, applied here to a backlog item
(`docs/roadmap/BACKLOG.md` BL-006's follow-up) rather than a numbered roadmap phase.

## 1. Current repository state relevant to this plan

- **The draft layer today:** `change_sets` (one row per import/AI-generation batch: source,
  status) and `changes` (one row per video × language × field: `baselineValue`/`proposedValue`/
  `approvedValue`, plain text columns) — Drizzle/SQLite, `src/lib/db.ts`. Read/written by
  `src/lib/changesets/` (`services.ts`, `diff.ts`, `import.ts`), the Web UI
  (`languages-manager.tsx`, `change-set-review.tsx`), API routes under
  `src/app/api/channels/[channelId]/change-sets/**`, and MCP tools (`changeset_list`/
  `changeset_get`/`changeset_create_from_import`, `src/mcp/server.ts`).
- **The send pipeline, explicitly out of scope for this plan:** `batches`/`batch_ledger_rows`/
  `batch_attempts`/`audit_events` (`src/lib/batches/`, `src/lib/audit/`) — the safety-critical,
  extensively-tested `docs/acceptance/PHASE_5_ACCEPTANCE.md` pipeline. A Batch is created from a
  clean, one-time read of already-approved `changes` rows; this plan does not change that
  boundary, only what sits behind it on the draft side.
- **Today's cross-device story:** `src/lib/device-handoff/` + `src/lib/snapshot/` — Variant A, one
  active device at a time, whole-database snapshot export/import over an operator-configured
  Syncthing folder (`docs/RELEASE_LAYOUT.md`). This is the mechanism BL-006 found structurally
  incompatible with concurrent multi-device editing, and the mechanism this plan's scope (the
  draft layer only) is meant to eventually stop relying on for that one slice of data — every
  other table keeps using it unchanged.
- **The per-channel identity concept to reuse as a sync boundary:** `write-context`
  (`assertWriteChannel`) and the `channels` table already make "which channel" the central
  scoping concept for write-safety; this plan reuses it as the CRDT document boundary, not as a
  new concept.
- **No CRDT library or Automerge dependency exists anywhere in this codebase today** — this is a
  fully new dependency and data model, not an extension of something partially built.

## 2. Existing capabilities vs. missing dependencies

| Capability this plan needs | Status |
|---|---|
| Per-channel scoping concept to reuse as the CRDT document boundary | **Exists** (`write-context`, `channels` table) |
| A propose → approve → execute pipeline shape to preserve at the boundary with Batches | **Exists** (`changesets` → `batches`) |
| Local persistent storage | **Exists** (SQLite) — but Automerge needs its own storage for documents/incremental changes; this is new, not a reuse of the SQLite file itself |
| A transport for moving data between machines | **Exists** for whole-database snapshots (Syncthing + device-handoff) — **not proven** for frequent, small, binary CRDT change exchange; see §8 |
| A CRDT library itself | **Missing entirely** — new dependency (Automerge) |
| A materialized SQL read-projection layer from CRDT state | **Missing** — new code, needed so the existing query-heavy UI/API/MCP/CLI surface keeps working unchanged |
| Conflict-surfacing UI for a same-field concurrent edit | **Missing** as a dedicated flow, but the project already has the right *shape* to imitate — `change-set-review.tsx`'s diff display and the batches pipeline's own pre-write conflict detection (`src/lib/batches/merge.ts`'s `detectPreWriteConflict`) are the pattern to extend, not invent from scratch |
| A one-time migration path for existing local `change_sets`/`changes` data | **Missing** — every existing local install has real data that must convert losslessly |

## 3. Smallest useful vertical slice

**A throwaway spike, not production code:** a single Automerge document per channel holding just
the `changes` shape (title/description proposals), driven by a small standalone script (not the
app's UI or API) that can (a) create/edit a proposal, (b) persist the document to a local file,
(c) load two independently-edited copies of the same document and merge them, inspecting the
result for both the "different fields changed" case (should merge cleanly) and the "same field
changed on both sides" case (should surface as a resolvable conflict, never silently pick one).
This validates that Automerge's actual behavior matches what this plan assumes about it, against
this project's real data shape, before any production wiring, service-layer design, or dependency
addition is committed to. Nothing from this spike ships — it exists to de-risk the slices below.

## 4. Scope and explicit non-goals

**In scope:** `change_sets`/`changes` only. One Automerge document per channel.

**Explicitly out of scope, this plan does not propose touching any of the following:**

- The actual YouTube-write pipeline — `batches`/`batch_ledger_rows`/`batch_attempts`/
  `audit_events` stay exactly as they are, fed by a clean read of approved drafts, unchanged.
- Real-time collaborative UI (live cursors, presence indicators) — this is an async draft-review
  workflow with an approval gate, not a live shared document editor; that category of feature is
  not requested and not needed for the stated goal (sync between devices, not simultaneous
  keystroke-level co-editing).
- Multi-user accounts/permissions — "multiple devices" in the owner's request means one operator
  working from several machines, not multiple distinct human accounts with different permissions
  on the same channel. That would be a separate, larger, unrequested feature.
- The device-handoff/snapshot mechanism for every table *other than* `change_sets`/`changes`
  (`channels`, `videos`, `batches`, `audit_events`, etc.) — stays exactly as documented in
  `docs/RELEASE_LAYOUT.md`, at least for the scope of this plan.

## 5. Interfaces, data structures, and security boundaries

- A new domain module, e.g. `src/lib/change-drafts/` (naming TBD at implementation time),
  following the existing `contracts/schemas/services/adapters` pattern (`AGENTS.md` §D,
  `docs/DEVELOPMENT_PLAYBOOK.md` §6.2) rather than a one-off integration bolted onto
  `src/lib/changesets/`.
- Data shape: one Automerge document per `channelId`, containing the equivalent of today's
  `change_sets` and `changes` rows (source, status, per-field baseline/proposed/approved values).
  The exact internal shape is implementation-time work, not decided here, but must map every
  existing SQL column 1:1 so the migration in §6 (CD4) loses no information.
- **Security boundary, stated explicitly so it isn't accidentally weakened during implementation:**
  a channel identifier living inside an Automerge document is a data-partitioning convenience,
  never an access-control decision. `write-context.assertWriteChannel` remains the sole authority
  for which channel a write-safety-relevant action is permitted to target — nothing in the new
  sync path may be trusted as an identity check the way that guardrail is today.
- Must preserve `AGENTS.md` §F's existing scope boundary unchanged: the localization mechanism
  governs exactly `title`/`description` per language, nothing else. This migration changes *where*
  that data lives, never *what* fields it's allowed to touch.

## 6. Proposed implementation slices, once assigned

**Rollout strategy decided 2026-09-21 (§8 below): direct cutover, not dual-write.** The owner
explicitly chose the faster, single-step path ("мы пока только строим систему и можем себе это
позволить") over a parallel dual-write period — CD2/CD3 below are a single slice, not two.

- **CD1 — Spike** (§3). **DONE, 2026-09-21.** Throwaway, no production wiring -- confirmed
  Automerge's real conflict behavior matches this plan's assumptions.
- **CD2 — Automerge-backed service + SQL read-projection, direct cutover. DONE, 2026-09-21**
  (`src/lib/change-drafts/`, `src/lib/changesets/adapters/change-drafts-store.ts`). What exists:
  the document model, all mutation operations (create/add/update/approve), `mergeIncoming` with
  correct new-conflict detection, `listConflicts`, `exportBytes`/`migrateFromSql` -- proven to
  actually run inside the real Next.js server runtime (`serverExternalPackages` fix for
  Automerge's WASM binary). The SQL read-projection (`adapters/sql-projection.ts`, `db.ts`'s
  `upsertStoredChangeSet`/`upsertStoredChange`) re-projects the *entire* current document into the
  existing `change_sets`/`changes` SQL tables after every mutation (AC-CRDT-04, verified against
  real SQLite), with the projection call isolated (a projection failure is logged, never allowed
  to fail the calling write). **The cutover itself is done**: `src/lib/changesets/index.ts` now
  wires `createAutomergeBackedChangeSetStoreAdapter()` (`./adapters/change-drafts-store.ts`)
  instead of the old direct-SQL store adapter. This is the one place that changed --
  `src/lib/changesets/services.ts` and every one of its callers (API routes, MCP tools, CLI
  commands, AI-localization's `createChangeSetFromProposals`, XLSX import) are unmodified, since
  they only ever depended on the adapter's interface, never its implementation; reads still go
  straight to SQL (re-projected after every successful write -- see the atomicity/projection notes
  below for what happens when a projection fails), only the four write methods
  (`createChangeSetWithChanges`/`updateChangeSetStatus`/`updateChange`/`bulkUpdateChanges`) now
  route through `change-drafts/`, resolving `channelId` via a cheap SQL lookup where the old
  interface didn't pass one. **Atomicity note (found during review, fixed before merge):** the old
  direct-SQL adapter wrapped `createChangeSetWithChanges` and `bulkUpdateChanges` each in one
  `db.transaction(...)` -- an all-or-nothing guarantee. The Automerge-backed adapter preserves it
  by batching each into a single `Automerge.change` + a single `saveDocument` call
  (`change-drafts/services.ts`'s own `createChangeSetWithChanges`/`bulkPatchChanges`), never as N
  separate per-change saves; a batch of 300 changes (create + approve-all) completes in well under
  half a second against real SQLite. Verified by `src/lib/changesets/index.test.ts` (the first
  test to exercise `createChangeSetCore()`'s real production wiring end-to-end, not a fake store)
  and by a live browser/API check against the real Tropico Jazz channel (create → approve → reject-all
  through the actual `/api/channels/.../change-sets` routes, confirming both the SQL projection
  and the underlying `.automerge` file on disk). **CD7 confirmed, no separate change needed:** an
  independent audit of every MCP tool (`src/mcp/server.ts`'s `changeset_list`/`changeset_get`/
  `changeset_create_from_import`) and CLI command (`src/cli/video-metadata.ts`'s `changeset
  list|get|import`) found both call exclusively through `createChangeSetCore()`'s public
  interface, never `@/lib/db` or the old adapter directly, so they benefit from the cutover
  automatically. Approve/reject and AI-localization change-set creation aren't exposed on
  MCP/CLI at all today (API-route only), so there was nothing else to check there. One unrelated,
  pre-existing item flagged by that audit: `src/lib/batches/adapters/store.ts`'s own,
  independent `createChangeSetStoreAdapter()` (used by `createBatchCore()` for batch-execution's
  own payload re-validation) reads a `Change` row directly via `getStoredChangeById` from
  `@/lib/db`, bypassing `createChangeSetCore()` entirely -- this is a separate, narrower code path
  unaffected by this cutover (it only reads, and only for batch re-validation), not a gap in CD2
  itself; worth a follow-up look given `src/lib/batches/` is still Gate-B-blocked either way.
  **Known, accepted edge case from projection isolation:** if `projectToSql` throws on the very
  first write of a brand-new change set (inside `persistChangeSet`'s create call), the caller sees
  "Change set disappeared after creation" (its own post-write SQL read finds nothing) even though
  the Automerge document now holds a real, complete change set. A caller retry mints a new
  `changeSetId`, so the original stays orphaned in the document until some later save
  re-projects the whole document and it surfaces on its own. This is a direct, deliberate
  consequence of never letting a projection failure fail the write it followed (see
  `saveDocument`'s own doc comment) -- also a durability improvement over the old design, since no
  data is lost, only temporarily invisible to SQL readers -- not something CD2 needs to fix.
  Filesystem durability of the Automerge document itself (the actual source of truth) was also
  reviewed: `adapters/automerge-store.ts`'s `saveDocumentBytes` writes to a sibling temp file and
  atomically `rename`s it into place, so a crash mid-write can never leave a truncated, unloadable
  `.automerge` file on disk.
  CD5/CD6 (background sync, Merge-tab UI) are not
  started.
- **CD4 — One-time data migration. DONE, 2026-09-21** (`migrateFromSql`, `adapters/sql-source.ts`).
  Converts every existing local `change_sets`/`changes` row for a channel into its initial
  Automerge document, refusing to run a second time against a channel that already has one
  (all-or-nothing; a crash mid-migration leaves nothing written, safe to retry). AC-CRDT-03
  verified both via direct field comparison and across the real `Automerge.save`/`load`
  serialization boundary (not just an in-memory round trip) -- the same class of boundary where
  this slice's own clone-related merge bug was found. Still needs CD2's actual cutover to matter
  in practice; migrating data into a document nothing reads yet is inert until then.
- **CD5 — Transport wiring, continuous background sync (revised 2026-09-21, owner instruction).**
  File-based, over the existing operator-configured Syncthing folder (§8) — but **not**
  on-demand/manual like today's device-handoff export/import. The owner explicitly wants this to
  match how Syncthing itself actually behaves in practice: it can run continuously, moving files
  in near-real-time whenever both machines are online. This layer must support the same model — a
  background loop that periodically (a) writes the local Automerge document's current state (or
  its incremental changes) into the shared folder, (b) scans that folder for other devices' files,
  loads and merges any found, and (c) after every merge, diffs for newly-introduced conflicts and
  records them for the UI in §CD6 to read. This is a materially bigger piece than "file-based
  transport" originally implied — it is closer in shape to
  `docs/roadmap/plans/DEVICE_HANDOFF_AUTO_SYNC_PLAN.md`'s §3.2 periodic-export idea (which that
  plan left as a judgment call given the *existing* handoff mechanism's real cost — a full-DB
  `VACUUM`), except here the cost profile is fundamentally different: an Automerge document for
  the draft layer is small (the CD1 spike measured ~500 bytes for a single-field edit's history),
  so a frequent background sync loop is proportionate here in a way it explicitly was not for a
  full database snapshot. The exact polling/push interval is still an implementation-time tuning
  decision, not a blocker to building the mechanism itself. **Constraint found empirically while
  building CD2/CD4 (`src/lib/change-drafts/services.ts`'s `mergeIncoming` doc comment):** two
  Automerge documents must share a real history to merge correctly -- two devices that each
  independently bootstrap the same channel's document from scratch (e.g. both ran `migrateFromSql`
  locally before ever syncing once) are not safely mergeable, and Automerge does not error when
  this happens, it can silently produce an incomplete result. CD5 must guarantee every device's
  first participation in a channel comes from importing a real exported document (or being the
  one device that ran the migration), never two independent from-scratch bootstraps.
- **CD6 — Rename the "Devices" tab and make it the conflict-resolution surface. DONE, 2026-09-21**
  (both the first slice below and the resolution action).
  The tab is renamed **"Merge"** (`src/app/dashboard/page.tsx`'s `NAV_ITEMS`). Three new API
  routes: `POST /api/change-drafts/sync` (device-wide, triggers `runSyncCycle()`), `GET
  /api/change-drafts/conflicts-summary` (device-wide, cheap read-only aggregate count), `GET
  /api/channels/[channelId]/change-drafts/conflicts` (per-channel detail, channel-scoped per
  `docs/DEVELOPMENT_PLAYBOOK.md` §6.6(b)). `device-handoff-panel.tsx` gained a "Change drafts
  sync" section: a "Sync now" button and a list of the active channel's current `FieldConflict`s,
  each rendered as an N-column diff over `valuesByActor` (generalizing `change-set-review.tsx`'s
  2-column pattern). The header badge (AC-CRDT-08) deliberately does NOT live in a new top-right
  header icon area as this section originally proposed -- `app-shell.tsx` has no such area for
  anything else yet, and building one for a single consumer was judged disproportionate; instead
  `AppShell`'s `NavItem` type gained an optional `badge?: number`, rendered directly on the
  "Merge" sidebar entry, visible regardless of which tab is active. Polling (`page.tsx`, active
  regardless of tab) is deliberately two independent intervals, not one, per advisor review: the
  cheap conflict-count summary polls every 20s, while the real push+merge sync cycle (a genuine
  write to local files, protected by `change-drafts-sync/services.ts`'s single-flight guard) polls
  every 60s -- satisfies AC-CRDT-07 (background sync without opening the Merge tab) without
  hitting a write-classed endpoint as often as a UI-freshness poll would otherwise demand.
  **Live-verified (first slice only)** against the real Tropico Jazz channel (`claude-in-chrome`):
  "Sync now" really exported and wrote a `.automerge` file to the actual configured Syncthing
  folder on an external drive, confirmed as a valid, loadable Automerge document; the sidebar
  badge correctly showed a stubbed nonzero count and correctly returned to empty after reload;
  zero console errors. A real live CRDT conflict was not demonstrated through the UI in that pass
  (safely engineering a genuine concurrent edit against the production document without risking
  real data was judged not worth attempting) -- the conflict-detection mechanism itself already
  had thorough unit coverage (`change-drafts/services.test.ts`'s AC-CRDT-02 and neighbors).

  **Second sub-slice, conflict resolution, DONE, 2026-09-21** (owner: "продолжай"). New
  `change-drafts/services.ts` method `resolveConflict({channelId, changeId, field,
  winningActorId})`: takes `winningActorId`, never a raw value -- the actual winning value is
  re-derived server-side from `Automerge.getConflicts`, so this can never write a value that
  wasn't already one of the genuinely-conflicting options a device produced through this module's
  own validated write paths. Restricted to `proposedValue`/`approvalStatus`/`approvedValue`/
  `conflictStatus` -- the only fields realistic for two devices to actually conflict on in
  practice (`baselineValue`/`changeType`/`validationStatus` are set once at creation and never
  re-edited by this module's own API). Empirically verified (a probe script, not assumed from
  Automerge's docs) that a fresh `Automerge.change` write to a conflicted field fully clears
  `Automerge.getConflicts` for that property, both in-memory and across the save/load boundary --
  this is the mechanism the whole feature depends on. New `POST` handler on the same
  `.../change-drafts/conflicts` route file as the existing `GET`; gated by `src/proxy.ts` like any
  other real mutation. UI: a "Use this version" button under each competing value in
  `device-handoff-panel.tsx`, behind `ConfirmDialog` (BL-043's standing rule for an app-designed,
  irreversible-once-synced action); a conflict on a non-resolvable field is still shown, never
  hidden, with an explicit "can't be resolved from this screen yet" note instead of a button.
  3 new spec-driven tests (success + persistence-across-save/load, an unknown `winningActorId`
  rejected without partial mutation, a field/change with no actual conflict rejected rather than
  performing a no-op write). **Live-verified against the real Tropico Jazz channel**, after two
  advisor-review fixes required spinning the dev server back up anyway (surfacing `pushError`/
  `peersSkipped` in the Merge tab; a `useRef` guard against a double-click double-firing the
  resolve request): a disposable test Change Set was created, then a genuine concurrent conflict
  was constructed (forking the real document into a fake peer file plus an independent edit via
  the real production `change-drafts` core, so both sides diverge from one real shared ancestor,
  unlike a plain sequential edit which just fast-forwards with no conflict) -- "Sync now" reported
  "1 new conflict(s)", the conflict card rendered both competing values, clicking "Use this
  version" on the local device's value produced the confirm dialog, and after confirming, a direct
  read of the on-disk `.automerge` file confirmed the chosen value was written and the conflict
  fully cleared; the Merge tab's list and the sidebar badge both correctly returned to empty after
  the next poll cycle. Zero console errors. Test artifacts (the fake peer file, the disposable
  Change Set) were deleted/rejected afterward.
- **CD7 — CLI/MCP/API surface migration. DONE, 2026-09-22** (confirmation + one dead-code
  cleanup; no functional change was needed). CD2's own cutover (`changesets/index.ts` wiring
  `createAutomergeBackedChangeSetStoreAdapter()`) already meant every existing reader/writer of
  `change_sets`/`changes` was re-pointed at the new service layer automatically -- CLI, MCP, and
  every API route all go through `createChangeSetCore()`/`changesets/services.ts`, never `db.ts`
  directly. A full audit (grepping every call site of `db.ts`'s `createChangeSetWithChanges`/
  `updateStoredChangeSetStatus`/`updateStoredChange`/`bulkUpdateStoredChanges`) confirmed: the
  only production writer left is `change-drafts/adapters/sql-projection.ts` (via the newer
  `upsertStoredChangeSet`/`upsertStoredChange`, a distinct pair from the four audited functions);
  `src/lib/batches/`'s own `changeSetStore` adapter (`batches/adapters/store.ts`) is read-only
  (`getStoredChangeById` only, for its own narrow AC-BATCH-03 payload-integrity re-check) and
  never writes to these tables. One real finding: `src/lib/changesets/adapters/store.ts` still
  defined and wired up the OLD pre-cutover direct-SQL `createChangeSetStoreAdapter()` (all four
  audited functions), but it had zero callers anywhere in `src/` since `changesets/index.ts` was
  cut over to the Automerge-backed adapter -- confirmed dead code, deleted along with its
  now-unused imports (the file now only exports the still-live `createChangeSetChannelStoreAdapter`/
  `createIdGenerator`). That deletion made `db.ts`'s own `updateStoredChangeSetStatus`/
  `updateStoredChange`/`bulkUpdateStoredChanges` themselves unreachable (advisor review caught
  this second-order effect before commit) -- also deleted, along with the doc comment above
  `upsertStoredChangeSet` that used to contrast against them. `createChangeSetWithChanges`
  (the fourth audited function) was kept: `change-drafts/adapters/sql-source.test.ts` still calls
  it directly to seed real SQLite for a read-path test, a legitimate use unrelated to any
  production write path. `npm test` unchanged (690/690) after both rounds of removal, confirming
  nothing depended on any of it.

Ordering and exact boundaries between these are a judgment call for whoever scopes each slice at
assignment time — this list establishes the shape and dependencies (CD4 must land before CD3 can
go live on an existing install; CD5's continuous sync loop must exist before CD6 has any real
conflicts to display; CD7 depends on CD2 existing), not a fixed schedule.

## 7. Acceptance criteria (categories — final wording written at implementation time, per `AGENTS.md` §L, derived from this plan's requirements, never from a draft implementation)

- **AC-CRDT-01:** two devices independently edit *different* fields of the same change while
  offline; after sync, both edits are present — neither is lost.
- **AC-CRDT-02:** two devices independently edit the *same* field of the same change while
  offline; after sync, the conflict is surfaced to a human with both values visible — never
  silently resolved by picking one and discarding the other.
- **AC-CRDT-03:** migrating existing local `change_sets`/`changes` data into the initial Automerge
  document loses zero information — every row's every column is present and reconstructible from
  the migrated document.
- **AC-CRDT-04:** the SQL read-projection always reflects the current merged Automerge state after
  any local edit or remote merge — no existing UI/API/MCP/CLI caller needs any code change to keep
  working correctly against it.
- **AC-CRDT-05:** the full existing `docs/acceptance/PHASE_5_ACCEPTANCE.md` suite still passes
  unchanged — this migration provably does not affect the YouTube-write pipeline.
- **AC-CRDT-06:** `write-context.assertWriteChannel` remains the sole authority for write-channel
  identity decisions; no code path in the new sync/CRDT layer can influence which channel a real
  write targets.
- **AC-CRDT-07** (added 2026-09-21, CD5's continuous-sync revision): a conflict introduced by the
  background merge loop (not just a manually-triggered one) is detected and recorded within one
  sync cycle, without requiring the operator to open the Merge tab to trigger detection.
- **AC-CRDT-08** (added 2026-09-21, CD6's revision): the header's conflict-count indicator
  accurately reflects the number of unresolved conflicts at all times a value is displayed, and is
  visibly distinct from the separate "a newer snapshot is available" bell
  (`DEVICE_HANDOFF_AUTO_SYNC_PLAN.md` §3.3) — a reader must never confuse the two signals.

## 8. Required owner decisions — resolved 2026-09-21 (Telegram)

1. **Transport — DECIDED: file-based, over the existing operator-configured Syncthing folder.**
   ("Можно пока использовать Syncthing.") No live sync-relay server for this plan's scope; the
   known cost this accepts (Syncthing has no awareness of Automerge's binary format, so "two
   independently-changed Automerge files with the same name" is the same generic file-conflict
   problem Syncthing already has generically) still needs its own explicit handling in CD5, just
   not a different transport.
2. **Rollout strategy — DECIDED: direct cutover, not dual-write-then-cutover.** ("Вариант Б, мы
   пока только строим систему и можем себе это позволить.") No parallel dual-write period; §6's
   CD2 is now a single slice doing both the service-layer build and the cutover together. This
   accepts more risk during the transition window in exchange for materially less total
   engineering work — an explicit, informed tradeoff, not an oversight.
3. **Priority — DECIDED: now**, ahead of/alongside other open work rather than deferred.
4. **Permanent scope boundary or phase-1 boundary? — DEFERRED, not decided yet.** ("Ок, согласен
   [с рекомендацией пока ограничиться черновиками]. Можем вернуться к более детальному
   обсуждению позже, т.к. пока не до конца понимаю.") This plan's recommendation (draft layer
   only, indefinitely) stands as the working assumption for CD1-CD7, but is explicitly not a
   final, closed decision — revisit once the owner has more context, likely after CD1-CD2 give a
   concrete feel for how the new layer actually behaves.

## 9. Where this is recorded

`docs/decisions/0006-automerge-for-draft-layer.md` records the architecture direction itself.
`docs/roadmap/BACKLOG.md` (BL-049) points at this document as BL-006's follow-up — status `done`
means "the requested plan was produced," exactly as `docs/roadmap/plans/DEVICE_HANDOFF_AUTO_SYNC_PLAN.md`
(BL-029) and `FUTURE_DIRECTIONS_RESEARCH.md` (BL-006 itself) already established as the convention
for this kind of deliverable — it does **not** mean any slice above is authorized to begin.
`docs/roadmap/plans/FUTURE_DIRECTIONS_RESEARCH.md`'s BL-006 section should be read alongside this
plan as the research this plan builds on, not superseded or duplicated by it.
