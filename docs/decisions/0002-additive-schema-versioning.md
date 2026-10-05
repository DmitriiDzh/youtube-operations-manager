# 0002. Layer explicit schema versioning on top of the additive idempotent boot pattern

Status: Accepted

## Context

`docs/decisions/0001-additive-idempotent-schema-strategy.md` keeps `src/lib/db.ts`'s boot-time
`CREATE TABLE IF NOT EXISTS`/`ALTER TABLE ADD COLUMN` pattern, with an explicit revisit trigger: "the
first schema change that is not purely additive." Every schema change since (Phase 2 through Phase 6)
has in fact stayed additive, so that trigger has still never fired.

The Pre-Release Cross-Platform Persistence task needs something ADR 0001 never addressed at all: a
way to know *which* version of the schema a given database file is at, so that (a) an older database
can be safely upgraded across skipped versions, (b) a database produced by a *newer* build than the
one currently running can be rejected instead of silently opened and possibly corrupted, and (c) an
imported snapshot's database can be validated for compatibility before being applied. None of this
requires abandoning the additive pattern — it requires adding a version *label* to it.

## Problem

How does the app know a database's schema version, reject an incompatible (newer) one, and apply
skipped-version upgrades safely, without triggering ADR 0001's revisit condition (i.e., without any
non-additive change)?

## Alternatives

1. **Do nothing — keep relying on `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` alone.** This has no way
   to reject a newer/incompatible database (it would just silently run its own `CREATE TABLE IF NOT
   EXISTS` statements against tables that already exist in a possibly-different, newer shape,
   swallowing `ALTER TABLE` errors via the existing try/catch) and no way to express an upgrade that
   isn't "make these idempotent statements true," which stops working the moment a future migration
   needs a genuinely non-additive step. Rejected — this task explicitly requires "reject unsupported
   newer schemas," which this alternative cannot do at all.
2. **Adopt Drizzle Kit migrations now.** This is exactly ADR 0001's own revisit trigger, and that
   trigger — a non-additive schema change — still has not fired here either; every migration this
   task introduces (a new `schema_meta` table, a new `app_operation_locks` table, a new
   `handoff_log`/`recovery_acknowledgement` table) is purely additive. Introducing Drizzle Kit now
   would be exactly the premature architectural change `AGENTS.md` §C and ADR 0001's own rationale
   warn against — new tooling with no destructive change to justify it.
3. **Add a `schema_meta` table (key/value, holding an integer `schema_version`) plus an ordered,
   idempotent migration list that runs strictly after the existing baseline block, with an
   explicit reject-if-newer check that runs *before* any schema mutation.** This is purely additive
   (one new table), keeps every byte of the existing, working boot pattern, and adds exactly the
   three capabilities the task needs: a version label, ordered skipped-version upgrades, and a
   fail-closed newer-version rejection.

## Decision

Adopt alternative 3. `src/lib/db.ts`'s boot sequence becomes: PRAGMAs → read-only check of
`schema_meta.schema_version` (tolerating its absence — a pre-versioning database) → reject
immediately, with zero mutation, if a newer-than-supported version is found → the existing baseline
`CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` block (idempotent, safe up to and including the baseline
version) → any registered migrations strictly newer than the current stamped version, applied in
order, each stamping `schema_meta.schema_version` only after its own statements succeed. A
pre-versioning database is stamped at the baseline version once the baseline block completes
successfully (not before).

Do not introduce Drizzle Kit migrations as part of this task.

## Rationale

- Satisfies the task's explicit requirements (skipped-version upgrades, reject-newer, backup-before-
  migrate) that the pure ADR 0001 pattern structurally cannot express.
- Every change is additive — ADR 0001's own revisit trigger is not hit, so ADR 0001 itself is not
  superseded, only extended. `docs/DEVELOPMENT_PLAYBOOK.md` §6.3's existing "add a new
  `sqliteTable(...)`, add the matching `CREATE TABLE IF NOT EXISTS`, add it to the schema object,
  write flat persistence functions" recipe still applies unchanged to `schema_meta` itself and to
  every future additive migration this mechanism will carry.
- No new tooling, no new devDependency, no migration-file bookkeeping — a `schema_meta` row and an
  ordered in-code list of migration steps is the smallest mechanism that satisfies the requirement.
- Reject-before-mutate (rather than reject-after-attempting) is the only way to honestly guarantee "a
  rejected database is left byte-for-byte unchanged," which the task's data-loss-avoidance framing
  requires.

## Consequences

- Easier: every future additive schema change gets a version number and a documented upgrade path,
  closing the part of `docs/TECHNICAL_DEBT.md` RISK-08 that worried about "no way to know what shape
  an existing database is in."
- Harder: a genuinely non-additive change (a column type change, a `NOT NULL` backfill, a
  multi-step-ordering requirement) still cannot be expressed by this mechanism any more than by ADR
  0001's original pattern — RISK-08's underlying trigger condition is unchanged by this ADR. When
  that trigger fires, write a new ADR proposing Drizzle Kit migrations then, informed by the version
  history this mechanism will have already accumulated (a strict improvement over migrating from a
  completely unversioned baseline).

## Compatibility / migration impact

Every existing table shape (through Phase 6) becomes schema version 1 by definition — no column or
table changes to any of them. An existing, currently-deployed `data/playlist-manager.db` boots once
under the new code, gets a `schema_meta` table created and stamped at version 1 (or whatever the
current baseline is defined as at merge time), and is otherwise untouched. `docs/TECHNICAL_DEBT.md`
RISK-08 is cross-referenced, not resolved, by this ADR.
