# Sync Gateway Plan — consolidating Device-Handoff + Automerge into one module

Produced 2026-09-22, per the project owner's Telegram request, after being walked through exactly
which tables the whole-database Device-Handoff snapshot mechanism still carries beyond the
already-migrated draft layer (`change_sets`/`changes`, `docs/decisions/0006-automerge-for-draft-
layer.md`, CD1-CD7, `AUTOMERGE_MIGRATION_PLAN.md`). Owner's own words, first draft: *"Правила
авто-добавления в плейлисты — можно удалить. Все остальное думаю можно перевести на новую систему
миграции. Разработай план."*

**This is a plan, not an implementation.** Nothing here is authorized to run until its own
explicit assignment (`AGENTS.md` §C). It also does not relitigate or touch CD1-CD7's already-
shipped logic — only where that logic *lives* (§4 below).

## 1. What this is not

- **Not every remaining table needs CRDT machinery.** Two of the candidate tables
  (`channels`/`videos`) turn out, on inspection, to need no migration work of the "add Automerge
  support" kind at all — see §2, Category A.
- **Not a removal of the write-safety pipeline's rigor.** The identity → validation → backup →
  diff → approval → dry-run → audit → verification sequence (`AGENTS.md` §G,
  `docs/PROJECT_SPEC.md` §21/§27/§30) is unaffected by *where* the write pipeline's own bookkeeping
  is stored — this plan only proposes changing the storage/sync layer underneath it, never the
  sequence of checks a write goes through.
- **Not a Gate B or Live-writes change.** Nothing here touches whether a real YouTube write is
  authorized; `assertLiveWritesAuthorized` and the two-layer barrier are entirely orthogonal to how
  the *record* of a write later syncs between devices.
- **Not a permanent commitment to Syncthing.** Per §4, transport is deliberately factored out as
  its own replaceable piece — Syncthing is today's implementation, not an assumption baked into the
  rest of the design.

## 2. Scope: the tables beyond `change_sets`/`changes`, grouped by what they actually need

Found by reading the actual code (`src/lib/db.ts`, `src/lib/snapshot/contracts.ts`,
`src/lib/device-handoff/`, `src/lib/change-drafts/contracts.ts`) rather than assumed from table
names alone. **Confirmed by the owner 2026-09-22 ("а. Ок").**

### Category A — pure external caches: `channels`, `videos`

**Finding:** `upsertChannel`/`upsertVideos` (`src/lib/db.ts`) are always a fresh keyed upsert run
by a real `channel_sync`/"Sync now" action against the live YouTube API. There is no local-only
write path for either table — every row's true source of truth is YouTube itself, not this
device's edits.

**Decision: do not migrate these into the sync gateway at all.** Drop them from cross-device
transfer entirely. A new or second device "onboards" this data by signing in and clicking
"Sync now" — functionally identical to refreshing a stale cache, at the cost of one API round-trip
nobody was avoiding anyway.

### Category B — operator-authored config, same shape as the already-proven draft layer:
`channel_editorial_profiles`, `ai_connections` (config fields only)

Mutable, occasionally-revised, human-edited settings — structurally identical to the
`change_sets`/`changes` documents CD1/CD2 already built and tested (a plain `Record<id, T>` map of
scalar fields, LWW/field-conflict semantics via `Automerge.getConflicts`). Least new engineering of
any category: same primitive, same conflict-detection pattern.

**`ai_connections`' encrypted credential stays exactly where it is today** — device-local, never
synced, same reasoning as `users`/`cloud_connection` (`AGENTS.md` §F). Only the non-secret config
fields (display name, base URL, model id, adapter type) are candidates here.

### Category C — append-only provenance tied to drafts: `ai_localization_generation_provenance`

Already a satellite of a change proposal (records which AI generation produced which draft). Folds
naturally into the same per-channel document as `change_sets`/`changes` rather than needing a
document of its own.

### Category D — the safety-critical write pipeline: `batches`, `batch_ledger_rows`,
`batch_attempts`, `audit_events`

This is the one category ADR 0006 explicitly excluded:

> "The safety-critical send pipeline (`batches`/`batch_ledger_rows`/`batch_attempts`/
> `audit_events`) is extensively tested against `docs/acceptance/PHASE_5_ACCEPTANCE.md` and is not
> the part of the system that actually needs concurrent multi-device editing... \[it] remain\[s]
> exactly as \[it is] today: relational SQLite... the part of the system with the least tolerance
> for a new failure mode... stays outside the blast radius of this migration entirely."

**Reopening confirmed by the owner 2026-09-22** on the strength of three findings in the plan's
first draft — but **finding #1 below was wrong, corrected 2026-09-22 after a dedicated research
pass immediately before implementing M5** (`AGENTS.md` §L: derive expected behavior from the
actual code, not from an assumption written down before reading it):

1. **~~These tables are structurally append-only~~ -- FALSE for three of the four.** Only
   `audit_events` is genuinely insert-only (`src/lib/db.ts`'s own comment: "Never updated or
   deleted"). `batches` (`PENDING → RUNNING → COMPLETED/ABORTED`), `batch_ledger_rows` (`status`
   and `active_attempt_id`, mutated repeatedly per video across
   `PENDING → APPLYING → SUCCESS/FAILED/CONFLICT/UNKNOWN`), and `batch_attempts` (`phase`,
   `INTENDED → RESULT_RECORDED`) are real state machines, each row UPDATEd in place multiple times
   during one video's processing — not a shape where "two devices only ever create new ids" holds.
2. **The load-bearing safety mechanism has no Automerge equivalent.** `docs/acceptance/
   PHASE_5_ACCEPTANCE.md`'s AC-CONCURRENCY-01/02/03 and AC-RESUME-01/AC-CRASH-01 (bounded
   concurrency, no double-apply, no two batches racing the same video, crash-safe resume) are
   enforced by **guarded compare-and-set UPDATEs** (`db.ts`'s `beginAttemptIntent`/
   `transitionLedgerRowStatus`: `UPDATE ... WHERE status = 'PENDING'` etc., paired with
   `.returning()` to detect a zero-rows-affected precondition failure) and a real UNIQUE-constraint
   claim (`acquireVideoExecutionLock`'s `onConflictDoNothing`) -- deliberately chosen over
   `db.transaction(...)` after that was found to deadlock/serialize more aggressively across libSQL
   connections (`db.ts`'s own comment on `beginAttemptIntent`). **Automerge has no compare-and-set
   or mutual-exclusion primitive** -- a merge always accepts both sides' writes and resolves via
   LWW/conflict-recording; it cannot *refuse* a write the way `WHERE status = 'PENDING'` refusing to
   match a row can. This is a structural incompatibility, not an engineering inconvenience to work
   around.
3. **The recovery-mode gate reads live SQL directly, not a projection.**
   `scanForUnresolvedExecutionState` (`src/lib/snapshot/services.ts`) runs
   `SELECT ... FROM batch_ledger_rows WHERE status IN ('APPLYING','UNKNOWN')` against the *current*
   connection, and `isDeviceInRecoveryMode`/`assertNotInRecoveryMode` use it as a real-time,
   fail-closed safety gate before handoff and at other choke points. Every other family in this
   plan (editorial-profile, ai-connections-catalog) deliberately lets its SQL projection **lag**
   on a transient write failure (logged, never rethrown -- a stale projection is an acceptable,
   recoverable degradation for those). Reused verbatim here, that same lag would make the recovery
   gate **fail open**: a real unresolved `APPLYING`/`UNKNOWN` row could stop being visible to SQL
   the moment a projection write happened to fail, and `assertDeviceAvailableForMutation` would
   then wrongly allow a mutation exactly when it must not.

(The original finding #2 -- "no cross-device concurrency guard exists today, for anything,
'one device at a time' is a convention not a lock" -- and finding #3 -- RISK-29/RISK-33's
whole-table-replace fragility -- were confirmed accurate and still stand.)

**A fourth finding, discovered while scoping `audit_events` as the one seemingly-safe survivor,
rules it out too:** `audit_events.id` is a SQLite `AUTOINCREMENT` rowid, and its own schema
comment states this is deliberate -- it is what makes a ledger row's full event sequence
reconstructable in *exact* order (AC-AUDIT-01/04), never `occurred_at` (`unixepoch()`, second
granularity, against 14+ audit inserts per video during real execution -- same-second collisions
are the norm, not an edge case). An Automerge document has no rowid-equivalent ordering primitive:
keying entries by a generated UUID and letting the SQL projection assign a fresh `AUTOINCREMENT`
id on insert makes the projected order equal to *local insertion order*, which is wrong the moment
a peer's events are merged in after later local ones -- exactly the scenario cross-device sync
exists to handle. Recovering true order needs an explicit, origin-assigned ordering key (e.g. a
per-ledger-row monotonic sequence plus an actor tiebreak) threaded through `audit/services.ts`'s
`listForLedgerRow`/`listForBatch`, and AC-AUDIT-01/04 re-derived against that new ordering
contract -- a real, separately-scoped design task with its own `AGENTS.md` §L pass, not something
to land at the tail of this plan.

**Decision, 2026-09-22, following both corrections: all four Category D tables stay in
relational SQLite, unmigrated.** ADR 0006's original exclusion of the write pipeline is
reinstated for `batches`/`batch_ledger_rows`/`batch_attempts` (compare-and-set/UNIQUE-constraint
primitives with no CRDT equivalent, plus the recovery-gate fail-open risk) and now also for
`audit_events` (rowid-derived ordering with no CRDT equivalent). See
`docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md` for the durable record of
this reversal and its one named follow-up (the audit-ordering design). See §5 for what this means
for M5/M6.

**On the distributed-execution-claim question (§4(b) of the first draft):** moot -- nothing in
Category D is migrating, so the existing informal one-device-at-a-time convention for batch
*execution*, and the real compare-and-set locks underneath it, are entirely unchanged by this
plan.

## 3. The old whole-DB Device-Handoff mechanism: retirement reopened by §2's Category D correction

Owner, 2026-09-22: *"с. Да, старый механизм я бы удалил."* — decision 4(c) from the first draft
was resolved on the premise that *every* category above moves off whole-DB transfer. §2's
Category D correction breaks that premise: **all four** tables (`batches`, `batch_ledger_rows`,
`batch_attempts`, `audit_events`) are not migrating, so something must still decide whether they
retain any cross-device continuity at all, and that decision determines whether
`src/lib/device-handoff/`/`src/lib/snapshot/` can truly be deleted outright or only mostly
retired.

**This grew from three tables to four while scoping M5** -- worth stating plainly rather than
letting the owner answer a narrower question than the one that now exists. Under option (a)
below, "no cross-device continuity" now also means the *audit trail itself* stops transferring
between devices, not just in-flight execution state. Losing visibility into what a batch actually
did on another device is a materially different thing to accept than losing continuity for
in-progress execution state (which arguably was never a coherent handoff scenario to begin with,
per recovery-mode's own local-device-only design) -- the audit-trail half is the part most worth
thinking about before choosing.

**Two live options, needing the owner's explicit choice (not decided by this plan):**

- **(a) These four tables get no cross-device continuity going forward.** A batch is created,
  executed, and audited on one device. Accept this as a documented limitation, and
  `device-handoff`/`snapshot` are deleted in full, exactly as originally planned.
- **(b) Keep a small, scoped-down whole-table transfer just for these four tables** (not the
  general-purpose snapshot/handoff machinery, which has no other job left) -- e.g. reusing
  `src/lib/snapshot/`'s existing scrub/verify/merge primitives against a four-table allowlist,
  or a simpler dedicated mechanism. `BL-027`'s periodic-export cost question would then partially
  re-apply, scoped to a much smaller allowlist than today's.
- Separately, and not mutually exclusive with either option: the audit-ordering design work
  named in §2's fourth finding could later make `audit_events` migratable on its own, at which
  point only `batches`/`batch_ledger_rows`/`batch_attempts` would remain under whichever of
  (a)/(b) is chosen today.

Whichever is chosen, `schema_meta`'s cross-device role only disappears entirely under option (a).
See M6 in §5 for how this gates that slice.

## 4. New: one module — the Sync Gateway — owns all of this

Owner, 2026-09-22, extending this project's existing single-gateway-per-domain principle
(`docs/decisions/0005-youtube-write-gateway.md`, `0007-youtube-read-gateway.md`) to this domain:

> "Так же используем так же правило 1 модуля и шлюза. Объединяем весь этот функционал в отдельный
> модуль. Он отвечает за отслеживание изменений, каталогизировать это отправлять на перенос.
> Транспортом пока занимается syncthing. До тех пор пока не придумаем собственное решение."

This changes the plan's shape: rather than bolting each category B/C/D onto the existing
`change-drafts`/`change-drafts-sync` pair piecemeal, **all of it consolidates into one new module**
(proposed name: `src/lib/sync-gateway/`, open to the owner's own naming preference) with exactly
three responsibilities, mirroring the read/write gateways' own barrel-plus-adapters shape
(`AGENTS.md` §M cites that pair as precisely this project's model for a shared capability multiple
higher-level features depend on):

1. **Change tracking** — detecting that something a category B/C/D table holds has changed and
   needs to propagate (today's `change-drafts` already does this for `change_sets`/`changes`;
   generalizes to cover editorial profiles, AI-connection config, provenance, and — per §2
   Category D — batches/ledger/attempts/audit).
2. **Cataloging** — representing tracked changes as the actual synced documents (today's per-
   channel Automerge document, `Automerge.change`/`saveDocument`), including the conflict-detection
   semantics already proven in CD1-CD7. This is the module's core, reused across every category
   rather than reimplemented per table.
3. **Transport dispatch** — handing a cataloged document off to whatever moves bytes between
   devices. **Deliberately abstracted behind one interface, not hardcoded to Syncthing** — the
   owner was explicit that Syncthing is a stand-in ("пока", "до тех пор пока не придумаем
   собственное решение") until a custom transport exists. Today's only implementation is a
   `SyncthingFolderTransport` adapter (what `change-drafts-sync` already does: each device writes
   its own `<deviceId>.automerge` file into an operator-configured shared folder, reads/merges every
   peer's file). A future transport (e.g. a small relay service, direct device-to-device) becomes a
   second adapter behind the same interface — tracking and cataloging never need to change for that
   swap, exactly the point of factoring it out now rather than after a second transport is needed.

**What this absorbs:** `src/lib/change-drafts/` and `src/lib/change-drafts-sync/` move into this
new module (their proven logic is preserved, not rewritten — this is a module-boundary/location
change, validated with the same rigor as any refactor of already-shipped, safety-adjacent code,
`AGENTS.md` §D/§E), plus the new cataloging logic for categories B/C/D. Once Category D and the
whole-DB retirement (§3) are both live, `src/lib/device-handoff/` and `src/lib/snapshot/` have no
remaining job and are deleted, not merged in — there is nothing left in them worth preserving as a
"transport" once every table they used to carry has its own gateway-native path.

**Naming and exact internal file layout are proposed, not fixed** — `contracts/schemas/services/
adapters` per this project's own domain-module convention (`docs/DEVELOPMENT_PLAYBOOK.md` §6.2)
is the natural fit (a `TransportAdapter` interface in `contracts.ts`, `adapters/syncthing-
transport.ts` as its one implementation today), but the owner should confirm the module name before
any branch is opened.

## 5. Proposed slices, once assigned

- **M0 — drop `rules` from `SNAPSHOT_TRANSFERRED_TABLES`** (its feature surface was already removed
  2026-09-20; only the empty table itself remains). Independent of every other slice; already
  approved by the owner (twice); also removes RISK-33's `rules.user_id` FK scrub hazard. Actually
  dropping the empty table is a separate, optional, lower-priority follow-up needing its own small
  ADR per `docs/decisions/0001`.
- **M1 — stand up `src/lib/sync-gateway/`**: move `change-drafts`/`change-drafts-sync` into it
  unchanged in behavior, extract the `TransportAdapter` interface, and re-home the existing
  Syncthing logic as its first adapter. Pure refactor, no new sync behavior — proves the new module
  boundary against CD1-CD7's existing test suite before anything new is added to it. Foundational;
  every slice below depends on this one.
- **M2 — drop `channels`/`videos`** from cross-device transfer entirely (Category A); document that
  a new/second device re-syncs this data from YouTube directly.
- **M3 — catalog `channel_editorial_profiles` + `ai_connections` (config fields only)** through the
  gateway (Category B), reusing the moved CD1/CD2 pattern.
- **M4 — catalog `ai_localization_generation_provenance`** alongside `change_sets`/`changes`
  (Category C).
- **M5 — CANCELLED, 2026-09-22 (Category D deferred in full).** Neither `batches`/
  `batch_ledger_rows`/`batch_attempts` (compare-and-set/UNIQUE-constraint primitives, no Automerge
  equivalent) nor `audit_events` (rowid-derived ordering, no Automerge equivalent) migrate. See
  `docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`. The audit-ordering design
  work that could later make `audit_events` alone migratable is its own separate, future task,
  not part of this plan.
- **M6 — DONE, 2026-09-23. Owner chose option (b)** (Telegram: after a web-research pass found
  that the industry-standard answer for a single-writer subsystem that must still move between
  machines is an explicit, atomic ownership handoff -- never a live CRDT merge -- exactly LiteFS/
  Litestream's primary-failover shape and distributed job schedulers' lease-based worker handoff,
  the owner confirmed: *"'CRDT для драфтов/настроек + явная передача владения для конвейера
  записи' ок, тогда так и делай"*). `src/lib/device-handoff/`/`src/lib/snapshot/` are NOT deleted
  -- `SNAPSHOT_TRANSFERRED_TABLES` (`src/lib/snapshot/contracts.ts`) is narrowed to exactly
  `schema_meta` plus the four Category D tables (`batches`/`batch_ledger_rows`/`batch_attempts`/
  `audit_events`); `change_sets`/`changes`/`channel_editorial_profiles`/
  `ai_localization_generation_provenance`/`ai_connections` are removed from it (all five now
  propagate continuously via `sync-gateway` instead). `ai_connections`' own upsert-by-id special
  case in `applySnapshotToDatabase` (`src/lib/snapshot/services.ts`) is deleted along with it --
  the plain table-replace path now handles every remaining transferred table uniformly. Tests
  across `src/lib/snapshot/services.test.ts` and `src/lib/device-handoff/services.test.ts` that
  used `change_sets`/`ai_connections` as their "some application-state table" example were
  rewritten against `batches`/`batch_ledger_rows` instead (same shape: `id` + `channel_id` FK).

M1 gates everything else and should be assigned first. M2-M4 have no unresolved open design
questions once M1 lands, and are the plan's actual remaining implementation surface.

## 6. What doesn't change, under any slice above

`users`, `ai_connection_credentials`, `cloud_connection` — device-local secrets/grants, never
synced by any mechanism, exactly as today (`AGENTS.md` §F, `docs/decisions/0006`'s own precedent
for `users`/`ai_connection_credentials`). Live-writes/Gate B, and every check in `AGENTS.md` §G's
identity → validation → backup → diff → approval → dry-run → audit → verification sequence, are
unaffected by any slice in this plan.
