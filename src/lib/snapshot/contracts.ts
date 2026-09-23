import type { SqlExecutor } from "@/lib/db-backup/contracts";

export type { SqlExecutor };

/**
 * Explicit allowlist of tables that travel in a snapshot (decision 2/2a of this task's plan).
 * Anything NOT in this list is dropped from the scrubbed copy, fail-safe by construction --
 * a future new table is excluded by default unless a reviewer deliberately adds it here (see
 * the acceptance contract's adversarial-review checklist, which specifically calls out this
 * allowlist-vs-denylist choice).
 *
 * Never listed here, and never transferred, under any circumstance:
 *   - `users` (device-local OAuth identity/tokens; re-established per device via sign-in --
 *     see docs/decisions/0002-additive-schema-versioning.md's companion plan, decision 6);
 *   - `ai_connection_credentials` (device-local encrypted secrets, key is per-device);
 *   - `video_execution_locks` / `app_operation_locks` (runtime-only, meaningless off-device);
 *   - `handoff_log` / `recovery_acknowledgements` (this device's own operational bookkeeping);
 *   - `video_metrics_daily` (Phase 8, `docs/roadmap/plans/PHASE_8_PLAN.md` §6 slice 2) -- an
 *     accepted, documented limitation (`docs/ARCHITECTURE.md` §14.7), not an oversight:
 *     collected metrics stay device-local and do not travel with a snapshot/handoff.
 *   - `cloud_connection` (`docs/decisions/0008-cloud-connection.md`) -- device-local encrypted
 *     Google Cloud OAuth grant, same reasoning as `users`/`ai_connection_credentials`: never
 *     handed off, re-established per device via its own Connect flow.
 *   - `rules` (auto-add-to-playlist rules, upstream TubeMaster baseline) -- this feature's own
 *     Drizzle definition/UI/API routes were already removed 2026-09-20 (see `src/lib/db.ts`'s
 *     `initializeDatabase` comment); the `CREATE TABLE IF NOT EXISTS rules` statement is
 *     deliberately kept rather than dropped (a subtractive schema change needs its own ADR per
 *     `docs/decisions/0001-additive-idempotent-schema-strategy.md`), but it should never have
 *     kept traveling in a snapshot for a feature that no longer exists -- removed from this list
 *     2026-09-22 (owner instruction, "Правила авто-добавления в плейлисты — можно удалить"),
 *     which also closes RISK-33's `rules.user_id REFERENCES users(id)` scrub hazard
 *     (`docs/TECHNICAL_DEBT.md`).
 *   - `channels` / `videos` -- removed from this list 2026-09-22
 *     (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2 Category A, M2). Both are
 *     pure caches of the real YouTube API: `upsertChannel`/`upsertVideos` (`src/lib/db.ts`) are
 *     always a fresh keyed upsert from a real `channel_sync`/"Sync now" call -- there is no
 *     local-only write path for either table, so every row's true source of truth is YouTube
 *     itself, never this device's own edits. A new or second device "onboards" this data by
 *     signing in and clicking "Sync now" instead of receiving a copy of it -- functionally
 *     identical to refreshing a stale cache, at the cost of one API round-trip nobody was
 *     avoiding anyway. No CRDT/sync-gateway work needed for either table.
 *   - `change_sets` / `changes` / `channel_editorial_profiles` /
 *     `ai_localization_generation_provenance` / `ai_connections` -- removed from this list
 *     2026-09-23 (M6, `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2 Categories
 *     B/C). All four now propagate continuously via `src/lib/sync-gateway/` (M1/M3/M4) instead of
 *     through an occasional whole-DB snapshot -- keeping them here too would mean two disagreeing
 *     transfer mechanisms for the same data. `ai_connections`' credential half
 *     (`ai_connection_credentials`) was never transferred either way, per the entry above.
 *
 * What remains here after M6 is deliberately narrow: only `schema_meta` (see below) plus the
 * four Category D write-pipeline tables (`batches`/`batch_ledger_rows`/`batch_attempts`/
 * `audit_events`), which CANNOT move to `sync-gateway` -- `docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`
 * found they depend on SQL compare-and-set/UNIQUE-constraint primitives (concurrency safety) and
 * an `AUTOINCREMENT` rowid (exact audit ordering), neither of which has a CRDT equivalent. This
 * mechanism's own "explicit, human-decided, atomic whole-copy handoff" shape -- never a live
 * merge -- is exactly the industry-standard answer for a single-writer subsystem that must still
 * move between machines (the same shape LiteFS/Litestream use for SQLite primary failover, and
 * that distributed job schedulers use for lease-based worker handoff): ownership transfers
 * explicitly and atomically, it is never concurrently written from two places at once. Kept
 * deliberately, not by inertia -- see `docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`'s
 * follow-up note.
 *
 * `schema_meta` IS included -- the receiving device needs to know what schema version the
 * snapshot's data.db is actually at in order to safely apply migrations to the staged copy
 * before merging (it is not a secret).
 */
export const SNAPSHOT_TRANSFERRED_TABLES = [
  "schema_meta",
  "batches",
  "batch_ledger_rows",
  "batch_attempts",
  "audit_events",
] as const;

/**
 * Of the transferred tables, these import as a table-level replace (the incoming snapshot is
 * authoritative for application state under Variant A's single-active-device model).
 */
export const SNAPSHOT_REPLACE_ON_IMPORT_TABLES = SNAPSHOT_TRANSFERRED_TABLES.filter((table) => table !== "schema_meta");

export type SnapshotFileEntry = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type SnapshotManifest = {
  formatVersion: 1;
  snapshotId: string;
  parentSnapshotId: string | null;
  sourceDeviceId: string;
  generation: number;
  schemaVersion: number;
  createdAt: string;
  files: SnapshotFileEntry[];
  /** Written last, after every file is finalized -- see AC-SNAP-01. */
  complete: boolean;
};

export class SnapshotError extends Error {
  code:
    | "snapshot_incomplete"
    | "snapshot_checksum_mismatch"
    | "snapshot_file_missing"
    | "snapshot_divergent_lineage"
    | "snapshot_manifest_invalid"
    | "snapshot_already_exists";
  details?: Record<string, unknown>;

  constructor(code: SnapshotError["code"], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    this.details = details;
  }
}
