# Full Device-Handoff → Automerge Migration Plan

Produced 2026-09-22, per the project owner's Telegram request, after being walked through exactly
which tables the whole-database Device-Handoff snapshot mechanism still carries beyond the
already-migrated draft layer (`change_sets`/`changes`, `docs/decisions/0006-automerge-for-draft-
layer.md`, CD1-CD7, `AUTOMERGE_MIGRATION_PLAN.md`). Owner's own words: *"Правила авто-добавления в
плейлисты — можно удалить. Все остальное думаю можно перевести на новую систему миграции.
Разработай план."* ("The playlist auto-add rules can be deleted. I think everything else can be
moved onto the new [Automerge] sync system. Develop a plan.")

**This is a plan, not an implementation.** Nothing here is authorized to run until its own
explicit assignment (`AGENTS.md` §C). It also does not relitigate or touch CD1-CD7, which are
already shipped and unaffected by anything below.

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
- **Not an automatic reopening of ADR 0006's scope decision.** That ADR is "Accepted" and explicitly
  excluded `batches`/`batch_ledger_rows`/`batch_attempts`/`audit_events` with stated reasoning.
  §4 below treats revisiting that exclusion as its own explicit decision the owner needs to confirm,
  not something this plan quietly assumes on the strength of "everything else."

## 2. Scope: the tables beyond `change_sets`/`changes`, grouped by what they actually need

The owner's "everything else" spans four structurally different categories, found by reading the
actual code (`src/lib/db.ts`, `src/lib/snapshot/contracts.ts`, `src/lib/device-handoff/`,
`src/lib/change-drafts/contracts.ts`) rather than assumed from the table names alone.

### Category A — pure external caches: `channels`, `videos`

**Finding:** `upsertChannel`/`upsertVideos` (`src/lib/db.ts`) are always a fresh keyed upsert run
by a real `channel_sync`/"Sync now" action against the live YouTube API. There is no local-only
write path for either table — every row's true source of truth is YouTube itself, not this
device's edits.

**Proposal: do not migrate these to Automerge at all.** Drop them from cross-device transfer
entirely. A new or second device "onboards" this data by signing in and clicking "Sync now" —
functionally identical to refreshing a stale cache, at the cost of one API round-trip nobody was
avoiding anyway. This is the smallest possible slice (a deletion from an allowlist plus a doc
update), not a CRDT migration.

### Category B — operator-authored config, same shape as the already-proven draft layer:
`channel_editorial_profiles`, `ai_connections` (config fields only)

These are mutable, occasionally-revised, human-edited settings — structurally identical to the
`change_sets`/`changes` documents CD1/CD2 already built and tested (a plain `Record<id, T>` map of
scalar fields, LWW/field-conflict semantics via `Automerge.getConflicts`). This is the least new
engineering of any category: the same primitive, same conflict-detection pattern, same
`change-drafts`/`change-drafts-sync` machinery, just a new document (or a new field group inside
the existing per-channel one).

**`ai_connections`' encrypted credential stays exactly where it is today** — device-local,
never synced, same reasoning as `users`/`cloud_connection` (`AGENTS.md` §F). Only the
non-secret config fields (display name, base URL, model id, adapter type) are candidates here.

### Category C — append-only provenance tied to drafts: `ai_localization_generation_provenance`

This is already a satellite of a change proposal (records which AI generation produced which
draft). It folds naturally into the same per-channel Automerge document as `change_sets`/`changes`
rather than needing a document of its own — likely the smallest slice of the four categories.

### Category D — the safety-critical write pipeline: `batches`, `batch_ledger_rows`,
`batch_attempts`, `audit_events`

This is the one category ADR 0006 explicitly excluded:

> "The safety-critical send pipeline (`batches`/`batch_ledger_rows`/`batch_attempts`/
> `audit_events`) is extensively tested against `docs/acceptance/PHASE_5_ACCEPTANCE.md` and is not
> the part of the system that actually needs concurrent multi-device editing... \[it] remain\[s]
> exactly as \[it is] today: relational SQLite... the part of the system with the least tolerance
> for a new failure mode... stays outside the blast radius of this migration entirely."

Revisiting that exclusion is a real, separate decision (§4) — but three findings from re-reading
the actual code change the risk picture from when 0006 was decided, and are worth the owner's
attention before deciding:

1. **These tables are structurally append-only and immutable once written, uniquely keyed by a
   generated UUID.** A device only ever creates *new* rows for its own batch/attempt/audit entry —
   it never edits a row another device wrote. Automerge's field-level conflict machinery exists for
   *repeatedly revised* values (a title two people both edit); there is no realistic scenario where
   two devices write the *same* id with *different* content here. In CRDT terms this is a **lower-
   risk shape** than what's already shipped for `change_sets` (which genuinely does need per-field
   conflict resolution), not a harder one.
2. **No cross-device concurrency guard exists today, for anything.** `assertDeviceAvailableForMutation`
   (`src/lib/device-handoff/services.ts`) only checks this device's own operation lock and its own
   recovery-mode state — it never reads another device's status. "One active device at a time" is
   an **operator convention**, not an enforced distributed lock, and was already true before this
   plan. Migrating these tables to Automerge would not remove a safety mechanism that exists today;
   it would *add* cross-device visibility (every device sees a batch/attempt/audit event as soon as
   it happens) on top of the same informal convention.
3. **There is an independent, non-CRDT-enthusiasm motivation.** `docs/TECHNICAL_DEBT.md`'s RISK-29
   (fixed) and RISK-33 (partially fixed) are both about real, already-hit fragility in the
   *current* whole-table-replace-on-import mechanism specifically striking `batch_ledger_rows`
   (positional-column corruption across schema versions; `FOREIGN KEY` failures needing
   `PRAGMA foreign_keys=OFF` bracketing). That entire fragility class disappears if these tables
   move to CRDT merge instead of whole-table SQL replace-on-import.

**What genuinely stays hard, and is not assumed away by the above:** *executing* a batch (a real
Live-writes call) is a mutating action with a real external side effect — even if the *record* of
what happened merges safely as an append-only log, the *act* of executing must still never happen
twice for the same batch from two devices. Today nothing prevents that except the same informal
"one device at a time" convention finding #2 above already describes. This migration doesn't make
that better or worse by itself, but near-real-time sync (instead of "next whole-DB handoff, maybe
hours later") means two devices could act on a stale ledger state *faster* than before. Whether
that warrants a real distributed execution claim (e.g. `executingDeviceId` + a lease/expiry,
written into the same shared document, checked before `createLiveWriteExecutorIfEnabled` proceeds)
or is an acceptable, unchanged risk to carry forward is decision 4(b) below — not something this
plan resolves on its own.

## 3. `schema_meta` and the whole-DB snapshot mechanism's own fate

`schema_meta` exists in `SNAPSHOT_TRANSFERRED_TABLES` for exactly one reason: so a snapshot
*importer* knows which schema version the *sender's* copy was built from, in order to safely apply
migrations to the staged copy before merging. Once categories A-D above no longer need whole-DB
snapshot transfer, `schema_meta`'s cross-device role is meaningless — there's nothing left to
import.

**Proposal (the plan's natural end state, not an immediate step):** once A-D are migrated and
proven live, retire the whole-database Device-Handoff snapshot/export mechanism
(`src/lib/device-handoff/`, `src/lib/snapshot/`) entirely, not just empty its table allowlist. This
would also **fully resolve `BL-027`** (the periodic-auto-export cost/interval question) by
eliminating the need for periodic export altogether, rather than by answering its interval
question — there would be nothing left worth exporting that Automerge doesn't already sync
continuously and far more cheaply (no exclusive app-wide lock, no `VACUUM`). This is presented as
the plan's overall direction, not a decision to make today — see 4(c).

## 4. Explicit decisions needed from the owner before any slice is assigned

- **(a) Confirm the four-category grouping in §2**, especially: (i) dropping `channels`/`videos`
  from cross-device transfer entirely rather than "migrating" them — no CRDT work is proposed for
  them at all; (ii) reopening ADR 0006's exclusion of `batches`/`batch_ledger_rows`/
  `batch_attempts`/`audit_events` specifically for CRDT-based sync — this revises a decision already
  recorded as "Accepted" and needs its own explicit yes, not an inference from "everything else."
- **(b) For Category D specifically:** does batch *execution* need a real distributed claim
  mechanism now that sync would be near-real-time, or is the existing informal one-device-at-a-time
  convention still acceptable to carry forward unchanged? (Shipping visibility-only sync now, and
  deferring the execution-claim question, is a legitimate answer — but it should be a deliberate
  one, not a silent omission.)
- **(c) Whether retiring the whole-DB Device-Handoff snapshot mechanism (§3) is the intended end
  state**, or whether it should keep running indefinitely in parallel as a belt-and-suspenders full
  backup regardless of what else migrates.
- **(d) `rules` table — already decided by the owner, and simpler than it looks.** Its feature
  surface (Drizzle definition, UI, API routes) was already removed on 2026-09-20, per the owner's
  own prior instruction ("давай удалим их, т.к. пока не вижу им применения") — only a harmless,
  permanently-empty `CREATE TABLE IF NOT EXISTS rules` statement remains (`src/lib/db.ts` around
  line 863), deliberately kept rather than dropped, per `docs/decisions/0001-additive-idempotent-
  schema-strategy.md`'s rule that a *subtractive* schema change needs its own ADR first. What the
  owner's new "можно удалить" actually resolves is narrower than a fresh feature removal: just
  drop `rules` from `SNAPSHOT_TRANSFERRED_TABLES` (it should never have kept traveling in a
  snapshot for a feature that no longer exists), which also fully resolves the `rules.user_id
  REFERENCES users(id)` foreign-key hazard `docs/TECHNICAL_DEBT.md`'s RISK-33 already flagged as a
  scrub complication. Actually dropping the empty table itself is optional and lower priority —
  it needs the small subtractive-migration ADR ADR-0001 calls for, whereas removing it from the
  snapshot allowlist does not.

## 5. Proposed slices, once assigned

- **M0 — drop `rules` from `SNAPSHOT_TRANSFERRED_TABLES`** (its feature surface was already removed
  2026-09-20; only the empty table itself remains, see 4(d)). Independent of every other slice
  below; already approved by the owner (twice); also removes RISK-33's `rules.user_id` FK scrub
  hazard. Actually dropping the empty table is a separate, optional, lower-priority follow-up that
  needs its own small ADR per `docs/decisions/0001`.
- **M1 — drop `channels`/`videos` from `SNAPSHOT_TRANSFERRED_TABLES`**, and document that a new or
  second device re-syncs this data from YouTube directly rather than receiving a copy of it. No new
  CRDT code.
- **M2 — migrate `channel_editorial_profiles` + `ai_connections` (config fields only) onto
  Automerge**, reusing CD1-CD4's exact proven document/conflict pattern.
- **M3 — fold `ai_localization_generation_provenance` into the existing per-channel Automerge
  document** alongside `change_sets`/`changes`.
- **M4 (needs decision 4a/4b first) — migrate `batches`/`batch_ledger_rows`/`batch_attempts`/
  `audit_events`** onto Automerge as an append-only replicated log; resolve the execution-claim
  question from 4(b) as part of this slice's own design, not deferred silently.
- **M5 (needs decision 4c) — retire the whole-database Device-Handoff snapshot/export mechanism**
  once M1-M4 are live and proven; this is where `BL-027` closes as moot rather than merely
  answered.

M0-M3 have no unresolved open design questions blocking them once 4(a)'s grouping is confirmed
(the design choices in §2 are the resolutions); M4 needs 4(a)/4(b) answered, and M5 needs 4(c),
before either can be scoped precisely — mirroring how `AUTOMERGE_MIGRATION_PLAN.md` §4 left its own
D5 slice unscoped pending a single owner decision.

## 6. What doesn't change, under any slice above

`users`, `ai_connection_credentials`, `cloud_connection` — device-local secrets/grants, never
synced by any mechanism, exactly as today (`AGENTS.md` §F, `docs/decisions/0006`'s own precedent
for `users`/`ai_connection_credentials`).
