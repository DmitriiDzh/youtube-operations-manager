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

- **CD1 — Spike** (§3). Throwaway, no production wiring. Answers whether Automerge's real
  conflict behavior matches this plan's assumptions for this project's actual data shape.
- **CD2 — Automerge-backed service + SQL read-projection, direct cutover.** The new service layer
  becomes the source of truth for reads and writes in one step (no parallel dual-write period);
  the SQL tables become a read-only projection, regenerated on every local edit and every merge.
- **CD4 — One-time data migration.** Every existing local `change_sets`/`changes` row converts
  into an initial per-channel Automerge document, with an explicit lossless-conversion acceptance
  test (AC-CRDT-03 below) before this can run against any real installation's data. Must land
  before CD2's cutover goes live on an existing installation, precisely because there is no
  dual-write safety net this time.
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
  decision, not a blocker to building the mechanism itself.
- **CD6 — Rename the "Devices" tab and make it the conflict-resolution surface (revised
  2026-09-21, owner instruction).** The tab currently called "Device" (`device-handoff-panel.tsx`)
  is renamed — **"Merge"** is this plan's working name (the owner suggested "Merge" or "Data
  Transfer"; either is a cheap, reversible cosmetic choice, not worth blocking on). This screen
  becomes where every detected conflict (from CD5's continuous merge loop, not only from a
  manual action) is tracked and presented for a human decision — reusing this codebase's existing
  diff/review UI patterns (`change-set-review.tsx`) rather than inventing a new visual language.
  The existing top-right header icon area (`app-shell.tsx`, already home to the active-channel/
  switch-channel/sign-out controls, and the planned "newer snapshot available" bell from
  `DEVICE_HANDOFF_AUTO_SYNC_PLAN.md` §3.3) gains a second, distinct signal: a badge/indicator for
  "N conflicts awaiting your decision," separate from that plan's "an update is available" bell,
  since they mean different things and both may need to be true at once.
- **CD7 — CLI/MCP/API surface migration.** Every existing reader/writer of `change_sets`/`changes`
  is re-pointed at the new service layer instead of the SQL tables directly.

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
