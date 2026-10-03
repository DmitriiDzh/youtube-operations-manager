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
 *   - `creative_assets` (Phase 7 slice D, `docs/AGENT_OPERATIONS_INTERFACE.md` §4c) -- same
 *     reasoning as `video_metrics_daily`: a deliberate, accepted, documented limitation
 *     (`docs/TECHNICAL_DEBT.md` RISK-52), not an oversight. A registered asset stays device-local
 *     for now; it does not travel with a snapshot/handoff.
 *   - `cloud_connection` (`docs/decisions/0008-cloud-connection.md`) -- device-local encrypted
 *     Google Cloud OAuth grant, same reasoning as `users`/`ai_connection_credentials`: never
 *     handed off, re-established per device via its own Connect flow.
 *   - `channel_workspaces` (Phase 11, `docs/roadmap/plans/PHASE_11_PLAN.md` §1) -- a per-device,
 *     per-channel LOCAL filesystem path, meaningless on any other machine. Deliberately
 *     device-local by owner-approved design (`docs/roadmap/FUTURE_PHASES.md` §11: "device-local,
 *     never synced"), NOT a RISK-52-style omission -- do not "fix" it by adding it here the way
 *     the Phase 9/10 tables were. Rows are also keyed on the bootstrap `deviceId`, so a row from
 *     another device is invisible even if it arrived some other way.
 *   - `agent_channel_tokens` (Phase 12, `docs/roadmap/plans/PHASE_12_PLAN.md` 12.1) -- per-machine
 *     agent credentials (hashes), device-local by design like `agent_connections`; never a
 *     RISK-52-style omission.
 *   - `rules` (auto-add-to-playlist rules, from the project's original pre-rewrite baseline) -- this feature's own
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
 *     B/C). All five now propagate continuously via `src/lib/sync-gateway/` (M1/M3/M4) instead of
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
  // Phase 9 (Market Intelligence) tables -- owner decision, Telegram 2026-09-26, verbatim "Да, я
  // бы объединял" ("yes, I would merge/combine them"), recorded in
  // docs/roadmap/plans/PHASE_9_PLAN.md §12 point 5 as RESOLVED the same day, closing this specific
  // instance of RISK-52 (docs/TECHNICAL_DEBT.md): this data must travel with device handoff, not
  // stay device-local, since owner spec §38's "historical public data that is not collected today
  // often cannot be reconstructed later" makes losing it on a device switch a real data-preservation
  // gap, not a cosmetic one. Never implemented until now -- every Phase 9 slice from 9A onward added
  // its own new table without adding it here, silently inheriting the old omit-by-default behavior
  // this list's own fail-safe-by-construction design was meant to prevent (found by advisor review,
  // 2026-09-27, while planning slice 9H part A).
  "research_channels",
  "research_evidence",
  "market_channel_snapshots",
  "market_video_snapshots",
  "market_intelligence_collection_runs",
  "market_discovery_candidates",
  "market_discovery_runs",
  "market_topics",
  "market_topic_assignments",
  "market_trend_candidates",
  "market_trend_evidence",
  "market_research_requests",
  // Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md §5a) -- Decision & Experiment
  // Engine record-keeping. Added from this module's own first commit, not as a later fix pass --
  // RISK-52/RISK-79 already showed every Phase 9 slice from 9A onward repeated this same gap
  // (a new table shipped without being added here) until a dedicated pass caught up. Decision/
  // experiment history is exactly the kind of "cannot be reconstructed later" record that gap's
  // own reasoning applies to. FK order: hypotheses -> experiments -> experiment_outcomes.
  "hypotheses",
  "experiments",
  "experiment_outcomes",
  // Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §6) -- structured evidence
  // references, added from this table's own first commit for the same RISK-52-avoidance reason.
  // FK order: after hypotheses (its own parent), which is already above.
  "hypothesis_evidence",
  // Phase 10 slice 4 (docs/roadmap/plans/PHASE_10_SLICE_4_PLAN.md §4) -- AI-generation provenance,
  // same RISK-52-avoidance reason, same FK order rule (after its own parent, hypotheses).
  "hypothesis_generation_provenance",
  // Phase 12 slice 12.4 (docs/roadmap/plans/PHASE_12_PLAN.md, owner decision D1) -- per-channel
  // assignment of the Phase 9 market records above. Business data, added from its own first commit
  // (the RISK-52 lesson); no FK, so order is irrelevant.
  "channel_record_assignments",
  // Architecture audit 2026-10-01 (M6): the audit trail of real single-video "Details" writes.
  // Previously unclassified and therefore silently dropped on handoff, while the Batch write trail
  // (`audit_events`, above) travels -- the two write audit trails must be treated alike. No FK.
  "video_edit_audit_events",
  // Phase 13 slice 13.8: which Wikipedia articles a topic follows is business data, like the topics
  // themselves (its FK target, market_topics, is above). The page views are a re-fetchable cache.
  "topic_wikipedia_articles",
] as const;

/**
 * Architecture audit 2026-10-01 (M6): EVERY table the schema creates must be classified -- either
 * transferred (`SNAPSHOT_TRANSFERRED_TABLES`) or deliberately device-local (this list, with the
 * reason). A test fails the suite on any table in neither list, so a new table can never again be
 * dropped from handoff by accident (the RISK-52 pattern) or leak by accident.
 */
export const SNAPSHOT_DEVICE_LOCAL_TABLES: Readonly<Record<string, string>> = Object.freeze({
  users: "OAuth identities/tokens -- re-established per device by signing in",
  ai_connection_credentials: "encrypted secrets; the key is per device",
  cloud_connection: "encrypted Google Cloud grant; re-connected per device",
  video_execution_locks: "runtime-only execution locks",
  app_operation_locks: "runtime-only operation lock",
  handoff_log: "this device's own handoff bookkeeping",
  recovery_acknowledgements: "this device's own recovery bookkeeping",
  snapshot_lineage: "this device's own snapshot lineage state",
  video_metrics_daily: "accepted limitation (RISK-52, ARCHITECTURE §14.7): collected metrics stay local",
  analytics_collection_runs: "collection bookkeeping for the local metrics above",
  analytics_weekly_reports: "rebuilt from the device's own local metrics",
  creative_assets: "accepted limitation (RISK-52)",
  content_proposals: "accepted limitation (RISK-52)",
  content_proposal_artifacts: "accepted limitation (RISK-52), child of content_proposals",
  rules: "retired feature, table kept inert",
  channels: "cache of YouTube; re-synced per device",
  videos: "cache of YouTube; re-synced per device",
  change_sets: "propagated continuously by sync-gateway instead",
  changes: "propagated continuously by sync-gateway instead",
  channel_editorial_profiles: "propagated continuously by sync-gateway instead",
  ai_localization_generation_provenance: "propagated continuously by sync-gateway instead",
  ai_connections: "propagated continuously by sync-gateway instead",
  channel_workspaces: "per-device local filesystem paths (Phase 11)",
  agent_channel_tokens: "per-machine agent credentials (Phase 12)",
  agent_connections: "retired (ADR 0011), table kept inert",
  agent_capability_zones: "retired (ADR 0011), table kept inert",
  app_settings: "per-device settings and toggles (Live writes, MCP, reads, ...)",
  gateway_call_events: "per-device traffic counters",
  sync_family_status: "this device's own sync-gateway status",
  wikipedia_pageviews_daily: "re-fetchable cache of Wikimedia page views (Phase 13.8)",
  reporting_jobs: "Reporting API job bookkeeping for this device (BL-114); Google is the source of truth",
  reporting_report_files: "ledger of Reporting API files this device downloaded (BL-114)",
  reporting_sync_attempts: "last Reporting API sync attempt of this device (BL-114): time, outcome, error text",
  channel_reach_daily: "accepted limitation (RISK-52, same as video_metrics_daily): collected impressions/CTR stay local (BL-114)",
});

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
    | "snapshot_already_exists"
    | "snapshot_local_changed_during_import"
    | "snapshot_execution_in_flight";
  details?: Record<string, unknown>;

  constructor(code: SnapshotError["code"], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    this.details = details;
  }
}
