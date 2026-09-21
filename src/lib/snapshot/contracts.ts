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
 *     accepted, documented limitation (`docs/ARCHITECTURE.md` §14.4), not an oversight:
 *     collected metrics stay device-local and do not travel with a snapshot/handoff.
 *
 * `schema_meta` IS included -- the receiving device needs to know what schema version the
 * snapshot's data.db is actually at in order to safely apply migrations to the staged copy
 * before merging (it is not a secret).
 */
export const SNAPSHOT_TRANSFERRED_TABLES = [
  "schema_meta",
  "channels",
  "videos",
  "change_sets",
  "changes",
  "channel_editorial_profiles",
  "ai_localization_generation_provenance",
  "ai_connections",
  "batches",
  "batch_ledger_rows",
  "batch_attempts",
  "audit_events",
  "rules",
] as const;

/**
 * Of the transferred tables, these import as a table-level replace (the incoming snapshot is
 * authoritative for application state under Variant A's single-active-device model).
 * `ai_connections` is handled separately (upsert by id, see services.ts) so that a locally
 * stored credential keyed by the same connection id survives untouched.
 */
export const SNAPSHOT_REPLACE_ON_IMPORT_TABLES = SNAPSHOT_TRANSFERRED_TABLES.filter(
  (table) => table !== "ai_connections" && table !== "schema_meta"
);

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
