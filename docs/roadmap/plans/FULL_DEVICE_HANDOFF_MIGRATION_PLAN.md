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

**Reopened and confirmed by the owner 2026-09-22** (see §4) on the strength of three findings that
change the risk picture from when 0006 was decided:

1. **These tables are structurally append-only and immutable once written, uniquely keyed by a
   generated UUID.** A device only ever creates *new* rows for its own batch/attempt/audit entry —
   it never edits a row another device wrote. Automerge's field-level conflict machinery exists for
   *repeatedly revised* values (a title two people both edit); there is no realistic scenario where
   two devices write the *same* id with *different* content here. In CRDT terms this is a **lower-
   risk shape** than what's already shipped for `change_sets`, not a harder one.
2. **No cross-device concurrency guard exists today, for anything.** `assertDeviceAvailableForMutation`
   (`src/lib/device-handoff/services.ts`) only checks this device's own operation lock and its own
   recovery-mode state — it never reads another device's status. "One active device at a time" is an
   **operator convention**, not an enforced distributed lock, and was already true before this plan.
3. **An independent, non-CRDT-enthusiasm motivation.** `docs/TECHNICAL_DEBT.md`'s RISK-29 (fixed)
   and RISK-33 (partially fixed) are both about real, already-hit fragility in the *current*
   whole-table-replace-on-import mechanism specifically striking `batch_ledger_rows` (positional-
   column corruption across schema versions; `FOREIGN KEY` failures needing `PRAGMA
   foreign_keys=OFF` bracketing). This fragility class disappears entirely once these tables move
   off whole-table SQL replace-on-import.

**On the distributed-execution-claim question (§4(b) of the first draft):** the owner's answer —
*"Если нет конфликтов то не страшно"* ("if there are no conflicts, it's not a problem") — accepts
finding #1's reasoning and does **not** ask for a new `executingDeviceId`/lease mechanism. The
existing informal one-device-at-a-time convention for batch *execution* is carried forward
unchanged; this plan only changes how the *record* of a batch/attempt/audit event propagates
between devices, never the execution-time safety story, which stays exactly as it is today.

## 3. Confirmed: the old whole-DB Device-Handoff mechanism is retired, not kept in parallel

Owner, 2026-09-22: *"с. Да, старый механизм я бы удалил."* — decision 4(c) from the first draft is
resolved: once every category above is off it, `src/lib/device-handoff/` and `src/lib/snapshot/`
(whole-SQLite-copy export/import, checksum/lineage verification, the exclusive app-wide lock +
`VACUUM`) are deleted outright, not kept running as a parallel backup. `schema_meta`'s only reason
to travel cross-device (letting a snapshot importer apply the sender's migrations) disappears with
it. This **fully resolves `BL-027`** (the periodic-auto-export cost/interval question) by
eliminating the need for periodic export altogether, rather than by answering its interval
question — there is nothing left to export that the sync gateway (§4) doesn't already propagate
continuously and far more cheaply.

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
- **M5 — catalog `batches`/`batch_ledger_rows`/`batch_attempts`/`audit_events`** as an append-only
  replicated log through the gateway (Category D) — execution-time safety is unchanged (§2).
- **M6 — delete `src/lib/device-handoff/` and `src/lib/snapshot/`** once M2-M5 are live and proven
  (§3); this is where `BL-027` closes as moot rather than merely answered.

M1 gates everything else and should be assigned first. M2-M4 have no unresolved open design
questions once M1 lands. M5 is the most safety-sensitive slice and should get its own acceptance-
test pass per `AGENTS.md` §L before merging, mirroring Phase 5's own acceptance discipline. M6 is
only safe once M2-M5 are each independently verified live.

## 6. What doesn't change, under any slice above

`users`, `ai_connection_credentials`, `cloud_connection` — device-local secrets/grants, never
synced by any mechanism, exactly as today (`AGENTS.md` §F, `docs/decisions/0006`'s own precedent
for `users`/`ai_connection_credentials`). Live-writes/Gate B, and every check in `AGENTS.md` §G's
identity → validation → backup → diff → approval → dry-run → audit → verification sequence, are
unaffected by any slice in this plan.
