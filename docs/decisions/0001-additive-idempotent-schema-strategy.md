# 0001. Keep additive idempotent schema initialization instead of Drizzle Kit migrations

Status: Accepted (retrospective)

> **This ADR is retrospectively reconstructed in Phase 4.5.** The decision itself was made and documented inline during Phase 2 and re-confirmed during Phase 4 (`docs/ARCHITECTURE.md` §7.2, formerly §5.2/§6.2). No new information was invented here — this file restates that existing reasoning in the standard ADR format established by `docs/decisions/README.md`, and updates the "current state" to include Phase 4's `change_sets`/`changes` tables.

## Context

`src/lib/db.ts` boots the local SQLite (libSQL) database with a `CREATE TABLE IF NOT EXISTS` block plus a couple of try/catch `ALTER TABLE ADD COLUMN` statements inside `initializeDatabase()`, run once at process start. `drizzle-kit` is an installed devDependency but no migration files exist under version control. Every schema change so far (Phase 2's `channels`/`videos`, Phase 4's `change_sets`/`changes`, plus the original `selected_channel_id`/`oauth_scope` columns on `users`) has been purely additive: new tables, or new nullable columns on existing tables — never a column type change, a `NOT NULL` backfill, a data transformation, or a change requiring multi-step ordering.

## Problem

Should the project adopt Drizzle Kit (or another formal migration tool) now, or continue with the boot-time idempotent pattern?

## Alternatives

1. **Continue with idempotent boot-time `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE`.** Zero new tooling, zero new files to keep in sync, works identically against an empty DB and an existing one (verified for Phase 4 — see `docs/ARCHITECTURE.md` §6.10).
2. **Adopt Drizzle Kit migrations now.** Gives explicit up/down migration files, a migration history table, and a real rollback story — but requires generating and committing migration files for every future schema change, and retrofitting migration files for the schema history that already exists only as inline `CREATE TABLE` statements.

## Decision

Keep the additive idempotent boot-time pattern. Do not introduce Drizzle Kit migrations in Phase 2, Phase 3, Phase 4, or Phase 4.5.

## Rationale

- Every schema change to date has been purely additive — the idempotent pattern already handles this exact case correctly, and this was re-verified for Phase 4 by booting against both an empty database file and an existing Phase 2/3 database file.
- `AGENTS.md`/`docs/PROJECT_SPEC.md` require avoiding broad rewrites and explaining *why* before changing database architecture (Rule 5) — introducing a migration framework with no destructive schema change to justify it would be exactly the kind of premature architectural change the project rules ask to avoid.
- This is a single local SQLite file per operator (`docs/PROJECT_SPEC.md` §37) — there is no multi-environment migration-ordering problem, no team-coordination requirement, and no production database to protect from a bad migration today.

## Consequences

- Easier: adding a new additive table or nullable column stays a one-line change to `initializeDatabase()`, with no separate migration-file bookkeeping.
- Harder: there is no formal rollback mechanism, and the pattern will become error-prone as more tables accumulate without a real migration history (flagged as a known risk during the project's original architecture review — tracked as `docs/TECHNICAL_DEBT.md` RISK 08).

## Compatibility / migration impact

None to date — every change has preserved existing tables and columns unchanged. The trigger for revisiting this decision is explicit and unchanged since Phase 2: **the first schema change that is not purely additive** (a column type change, a `NOT NULL` backfill, a data transformation, or a multi-step migration ordering requirement). At that point, write a new ADR proposing Drizzle Kit migrations — do not switch silently.
