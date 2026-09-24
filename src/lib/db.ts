import { chmodSync, existsSync, mkdirSync } from "fs";
import { readFile } from "fs/promises";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import path from "path";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { AttemptOutcome, AttemptPhase, LedgerStatus } from "@/lib/batches/ledger-state";
import { getProductionAppPaths, isRunningUnderTestRunner, resolveLegacyDbPath } from "@/lib/platform-paths";
import { copyDatabaseConsistently, isMissingTableError } from "@/lib/db-backup";
import {
  assertSupportedSchemaVersion,
  runSchemaMigrations,
  type SchemaMigration,
} from "@/lib/schema-versioning";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";

// Platform-aware app-data location (docs/decisions/0002-additive-schema-versioning.md's
// companion task, "Pre-Release Cross-Platform Persistence"). getProductionAppPaths() is the
// single shared implementation of "resolve the real app-data location, but redirect to an
// isolated temp directory under Node's own test runner" -- src/lib/cli-auth/storage.ts and
// src/lib/backup/adapters/filesystem-store.ts use the exact same function for their own
// defaults, so this test-runner guard exists in one place, not three (AGENTS.md §D).
const appPaths = getProductionAppPaths();

export { appPaths as appDataPaths };

// The local libSQL/SQLite driver does not create intermediate directories itself -- ensure
// the app-data directory exists before the client ever tries to open a file inside it.
mkdirSync(appPaths.appDataDir, { recursive: true });
// RISK-24 (docs/TECHNICAL_DEBT.md): this directory holds the DB file that stores plaintext
// OAuth tokens (RISK-07's accepted tradeoff assumes directory-level protection). Previously
// this chmod only happened as a side effect of src/lib/atomic-json-file's CLI-auth-only writes
// -- a Web-UI-only install (no CLI login ever run) never got it. Apply it unconditionally here,
// on every boot, matching the same 0700 mode atomic-json-file already uses for the same reason.
chmodSync(appPaths.appDataDir, 0o700);

// Captured *before* `createClient()` below -- verified empirically that `@libsql/client`'s
// `createClient()` synchronously creates an empty file at the given path as a side effect of
// construction, before any query runs. An earlier version of this file checked
// `existsSync(appPaths.dbPath)` *after* calling `createClient()`, which made that check always
// true and silently skipped every legacy migration forever -- a real, previously-shipped bug,
// found and fixed via independent review. This flag is the one piece of truth that check
// needed; everything below is ordered around preserving it correctly.
const dbAlreadyExistedAtModuleLoad = existsSync(appPaths.dbPath);

const rawClient = createClient({
  url: `file:${appPaths.dbPath}`,
});

/**
 * The testable core: copies every table from `legacyDbPath` into `destClient`'s already-open
 * database via `ATTACH DATABASE` (mirroring `src/lib/snapshot/services.ts`'s
 * `applySnapshotToDatabase` pattern) rather than `copyDatabaseConsistently`'s `VACUUM INTO` --
 * `VACUUM INTO` requires an *absent* destination file, which is never true for `destClient`'s
 * own already-open file. Recreates each legacy table from its own `sqlite_master.sql` (not the
 * current baseline's `CREATE TABLE` statements), preserving whatever additive shape the legacy
 * file actually has, exactly as if it were opened in place -- the normal
 * `initializeDatabaseSchema` version-check/migration pipeline that runs immediately after this
 * (see `initializeDatabase` below) then treats the result exactly like any other existing
 * database. Exported so this real, previously entirely-untested logic has a direct unit test
 * (`db.test.ts`) independent of the singleton wiring around it.
 */
export async function copyLegacyDatabaseInto(
  destClient: Client,
  legacyDbPath: string
): Promise<void> {
  await destClient.execute({ sql: "ATTACH DATABASE ? AS legacy", args: [legacyDbPath] });
  try {
    // RISK-25 (docs/TECHNICAL_DEBT.md): the whole copy is one transaction -- a failure
    // partway (disk full, a corrupt legacy page) leaves the destination exactly as it was
    // before this call, never a partially-populated mix of some tables copied and others not.
    // Each table is also made idempotent (safe to redo after a previous crash -- see
    // migrateLegacyDatabaseIfNeeded's own retry marker below) via CREATE-catching-"already
    // exists" + DELETE, deliberately NOT `DROP TABLE [IF EXISTS]`: empirically verified against
    // this exact @libsql/client build that a `DROP TABLE` statement -- even as a no-op "IF
    // EXISTS" against a table that was never created -- permanently breaks this *connection's*
    // ability to see any ATTACHed database's schema afterward (`no such table: legacy.<name>`
    // on every later reference, session-wide, not just inside this transaction; reproduced in
    // isolation). `CREATE TABLE` alone and `DELETE FROM` do not have this problem.
    await destClient.execute("BEGIN IMMEDIATE");
    try {
      const tables = await destClient.execute(
        "SELECT name, sql FROM legacy.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      );
      for (const row of tables.rows) {
        const createTableSql = row.sql;
        if (typeof createTableSql !== "string") continue;
        const tableName = String(row.name);
        try {
          await destClient.execute(createTableSql);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already exists/i.test(message)) throw error;
        }
        await destClient.execute(`DELETE FROM "${tableName}"`);
        await destClient.execute(`INSERT INTO "${tableName}" SELECT * FROM legacy."${tableName}"`);
      }
      await destClient.execute("COMMIT");
    } catch (error) {
      await destClient.execute("ROLLBACK");
      throw error;
    }
  } finally {
    await destClient.execute("DETACH DATABASE legacy");
  }
}

/**
 * One-time, explicit, non-destructive migration from the pre-this-task location
 * (`<repo>/data/playlist-manager.db`) into the new platform-appropriate app-data location --
 * only when nothing already existed at the new location before this module loaded (never
 * overwrites populated data, AC-PATH-06, using `dbAlreadyExistedAtModuleLoad` above rather than
 * re-checking `existsSync` here, which would now always see `rawClient`'s own empty stub file --
 * see that flag's own doc comment for the real bug this guards against) and only when a legacy
 * database actually exists (AC-PATH-05). The legacy file itself is never moved, renamed, or
 * deleted. Never runs under the test runner (see `isRunningUnderTestRunner` above) -- it must
 * never even *read* the operator's real legacy database as a side effect of `npm test`.
 */
// RISK-25 (docs/TECHNICAL_DEBT.md): `dbAlreadyExistedAtModuleLoad` alone cannot distinguish
// "this destination already has genuine, unrelated pre-existing data" from "this destination
// is wreckage a previous boot's crashed migration attempt left behind" -- both look identical
// (a file exists). A persisted marker, written *before* the copy starts and only ever advanced
// to "completed" *after* it commits, makes that distinction explicit: a boot that finds
// "in_progress" (not "completed") knows this is its own prior attempt to resume, not someone
// else's data to protect.
const legacyMigrationMarkerPath = path.join(appPaths.appDataDir, "legacy-migration-status.json");

type LegacyMigrationMarker = { status: "in_progress" | "completed" };

async function readLegacyMigrationMarker(): Promise<LegacyMigrationMarker | null> {
  try {
    const raw = await readFile(legacyMigrationMarkerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LegacyMigrationMarker>;
    return parsed.status === "in_progress" || parsed.status === "completed" ? { status: parsed.status } : null;
  } catch {
    return null;
  }
}

async function migrateLegacyDatabaseIfNeeded(): Promise<{ migrated: boolean }> {
  if (isRunningUnderTestRunner()) return { migrated: false };

  const legacyDbPath = resolveLegacyDbPath(process.cwd());
  if (!existsSync(legacyDbPath)) return { migrated: false };

  const marker = await readLegacyMigrationMarker();
  if (marker?.status === "completed") return { migrated: false };

  // No marker at all, and the destination already had something before this process ever
  // started: this predates the marker mechanism, or is genuinely unrelated data -- preserve
  // the original safety property (never overwrite populated data) rather than guess.
  if (marker === null && dbAlreadyExistedAtModuleLoad) return { migrated: false };

  await writeJsonFileAtomic(legacyMigrationMarkerPath, { status: "in_progress" });
  await copyLegacyDatabaseInto(rawClient, legacyDbPath);
  await writeJsonFileAtomic(legacyMigrationMarkerPath, { status: "completed" });
  return { migrated: true };
}

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull(),
  image: text("image"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiry: integer("token_expiry"),
  oauthScope: text("oauth_scope"),
  selectedChannelId: text("selected_channel_id"),
});

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  uploadsPlaylistId: text("uploads_playlist_id").notNull(),
  connectedUserId: text("connected_user_id"),
  connectedAt: integer("connected_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  // Additive, SCHEMA_MIGRATIONS version 6 -- a JSON array of language codes the operator wants
  // tracked as Languages-tab columns even before any video has a real translation in them
  // (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2/E5, owner instruction 2026-09-21).
  // NULL means "none explicitly tracked yet", never backfilled to "[]" (RISK-02/RISK-33's "never
  // silently create a fact that isn't true").
  targetLanguagesJson: text("target_languages_json"),
  // Additive, SCHEMA_MIGRATIONS version 9 (BL-059, docs/roadmap/plans/PHASE_8_PLAN.md §10 items
  // 3-5). Mirrors `lastSyncedAt` exactly, but for the daily auto-collection check specifically --
  // deliberately NOT derived from MAX(video_metrics_daily.collected_at), since that column is a
  // per-row last-write time (a manual re-collection of an old date range would bump it without
  // today's actual auto-collection ever having run) -- see the analytics staleness check's own
  // doc comment. Written BEFORE a collection run starts, not after, so two concurrent triggers
  // (e.g. two open browser tabs) never both run a full collection (src/lib/analytics/staleness.ts).
  analyticsLastAutoCollectedAt: integer("analytics_last_auto_collected_at", { mode: "timestamp" }),
});

export const videos = sqliteTable("videos", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  publishedAt: text("published_at").notNull(),
  privacyStatus: text("privacy_status").notNull(),
  defaultLanguage: text("default_language"),
  defaultAudioLanguage: text("default_audio_language"),
  thumbnailsJson: text("thumbnails_json").notNull(),
  localizationsJson: text("localizations_json").notNull(),
  etag: text("etag"),
  // Additive, schema version 4 (docs/decisions/0002-additive-schema-versioning.md) -- nullable
  // because a row synced before this column existed has no value until its next re-sync, never
  // backfilled with a fake 0 (RISK-02/RISK-33's "never silently create a fact that isn't true").
  viewCount: integer("view_count"),
  commentCount: integer("comment_count"),
  likeCount: integer("like_count"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const changeSets = sqliteTable("change_sets", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id),
  source: text("source").notNull(),
  status: text("status").notNull(),
  importedFilename: text("imported_filename"),
  schemaVersion: text("schema_version"),
  exportedAt: text("exported_at"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const changes = sqliteTable("changes", {
  id: text("id").primaryKey(),
  changeSetId: text("change_set_id")
    .notNull()
    .references(() => changeSets.id),
  videoId: text("video_id").notNull(),
  language: text("language").notNull(),
  field: text("field").notNull(),
  baselineValue: text("baseline_value").notNull(),
  proposedValue: text("proposed_value").notNull(),
  changeType: text("change_type").notNull(),
  validationStatus: text("validation_status").notNull(),
  validationError: text("validation_error"),
  conflictStatus: text("conflict_status").notNull(),
  approvalStatus: text("approval_status").notNull().default("pending"),
  approvedValue: text("approved_value"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Phase 6, Channel Editorial Profiles. Purely additive (ADR 0001), owned entirely by
// src/lib/ai-localization/ -- no existing table/column changes, no other domain module
// reads these two tables. One row per channel (channelId is the primary key); `version`
// increments on every save so a generation can record which version produced it
// (docs/acceptance/PHASE_6_ACCEPTANCE.md AC-PROFILE-*). Never stores credentials/secrets
// (AGENTS.md §F) -- every column here is free-text editorial guidance only.
export const channelEditorialProfiles = sqliteTable("channel_editorial_profiles", {
  channelId: text("channel_id")
    .primaryKey()
    .references(() => channels.id),
  version: integer("version").notNull().default(1),
  targetAudience: text("target_audience"),
  toneNotes: text("tone_notes"),
  terminologyNotes: text("terminology_notes"),
  titleConstraints: text("title_constraints"),
  descriptionConstraints: text("description_constraints"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Write-once in spirit, one row unconditionally recorded per successful
// `createChangeSetFromGeneration` call (see that function's own doc comment), recording exactly
// which profile version and/or per-request editorialBrief actually produced that Change Set's
// proposals -- so editing or deleting the profile afterward never loses this record (the
// reproducibility requirement).
// Its CONTENT never changes after insert through this application's own API, but the SQL row
// itself CAN be rewritten by a later re-projection of the same CRDT document (e.g. to backfill
// columns added by a later app version) -- see `setStoredGenerationProvenanceRow`'s own doc
// comment below for why that update path exists.
export const aiLocalizationGenerationProvenance = sqliteTable("ai_localization_generation_provenance", {
  id: text("id").primaryKey(),
  changeSetId: text("change_set_id")
    .notNull()
    .unique()
    .references(() => changeSets.id),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id),
  profileVersion: integer("profile_version"),
  effectiveContextJson: text("effective_context_json"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Phase 7 slice F (SCHEMA_MIGRATIONS version 16) -- additive columns on this same baseline
  // table via `ALTER TABLE ... ADD COLUMN`. See `DraftProvenance`'s own doc comment
  // (`src/lib/sync-gateway/change-drafts/contracts.ts`) for what each field means.
  evidenceJson: text("evidence_json"),
  rationale: text("rationale"),
  createdVia: text("created_via"),
  agentApiVersion: text("agent_api_version"),
});

// Phase 6, AI Connections (provider-agnostic). Purely additive (ADR 0001), owned
// entirely by src/lib/ai-connections/. `ai_connections` never stores a credential
// itself (only `hasCredential` is derivable from whether a row exists in
// `ai_connection_credentials`) -- the credential lives in its own table, encrypted
// (AES-256-GCM, key from AI_CONNECTIONS_ENCRYPTION_KEY, never in this repository),
// so a query/export of the connections table alone can never leak a secret.
export const aiConnections = sqliteTable("ai_connections", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  adapterType: text("adapter_type").notNull(),
  baseUrl: text("base_url"),
  modelId: text("model_id").notNull(),
  localInferenceMode: integer("local_inference_mode", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull().default("unknown"),
  statusMessage: text("status_message"),
  statusCheckedAt: integer("status_checked_at", { mode: "timestamp" }),
  capabilitiesJson: text("capabilities_json").notNull(),
  assignedTasksJson: text("assigned_tasks_json").notNull().default('["ai_localization"]'),
  pricingJson: text("pricing_json"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const aiConnectionCredentials = sqliteTable("ai_connection_credentials", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => aiConnections.id),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Phase 5, Slice 1 (foundation). See docs/acceptance/PHASE_5_ACCEPTANCE.md and
// docs/decisions/0001-additive-idempotent-schema-strategy.md -- these four tables are
// purely additive, no existing table/column is changed.
export const batches = sqliteTable("batches", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id),
  status: text("status").notNull(), // 'PENDING' | 'RUNNING' | 'COMPLETED' | 'ABORTED'
  concurrency: integer("concurrency").notNull().default(1),
  dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(true),
  runId: text("run_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

// One row per video per batch (DEC-OQ-1). Membership (batchId + videoId + changeIds) is
// fixed at insert time and never mutated afterward -- see AC-BATCH-01/02.
export const batchLedgerRows = sqliteTable("batch_ledger_rows", {
  id: text("id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => batches.id),
  videoId: text("video_id").notNull(),
  changeIdsJson: text("change_ids_json").notNull(),
  status: text("status").notNull(), // see LedgerStatus in batches/contracts.ts
  error: text("error"),
  verificationResultJson: text("verification_result_json"),
  // Points at the currently unresolved (INTENDED-phase) batch_attempts row for this
  // ledger row, if any -- NULL means no attempt is currently active. This is the single
  // persistent, transactionally-guarded exclusivity mechanism for "at most one active
  // attempt per ledger row at a time" (see beginAttemptIntent/recordAttemptResult below).
  // It doubles as the recovery pointer to "the attempt a crashed process left in flight".
  activeAttemptId: text("active_attempt_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Zero-to-many per ledger row (§0.C two-phase durable model: INTENDED committed before
// the network call, RESULT_RECORDED written after it returns or reconciliation concludes).
export const batchAttempts = sqliteTable("batch_attempts", {
  id: text("id").primaryKey(),
  ledgerRowId: text("ledger_row_id")
    .notNull()
    .references(() => batchLedgerRows.id),
  attemptNumber: integer("attempt_number").notNull(),
  phase: text("phase").notNull(), // 'INTENDED' | 'RESULT_RECORDED'
  payloadSnapshotJson: text("payload_snapshot_json").notNull(),
  requestedAt: integer("requested_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  outcome: text("outcome"), // 'SUCCESS' | 'FAILED' | 'UNKNOWN', set only in RESULT_RECORDED
  outcomeDetail: text("outcome_detail"),
  resultAt: integer("result_at", { mode: "timestamp" }),
});

// Cross-batch exclusive lock on a single video (AC-CONCURRENCY-01): the PRIMARY KEY on
// video_id makes acquisition an atomic, race-safe operation at the SQLite level.
export const videoExecutionLocks = sqliteTable("video_execution_locks", {
  videoId: text("video_id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => batches.id),
  ledgerRowId: text("ledger_row_id")
    .notNull()
    .references(() => batchLedgerRows.id),
  lockedAt: integer("locked_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Phase 5, Slice 3 (RECOVERY AND AUDIT). Durable audit trail -- see
// docs/acceptance/PHASE_5_ACCEPTANCE.md AC-AUDIT-01..05. `id` is an autoincrementing
// integer (SQLite rowid alias), not a UUID like other tables' ids: it is what makes a
// ledger row's event sequence strictly, unambiguously orderable (see the CREATE TABLE
// comment above).
export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: text("batch_id")
    .notNull()
    .references(() => batches.id),
  ledgerRowId: text("ledger_row_id")
    .notNull()
    .references(() => batchLedgerRows.id),
  videoId: text("video_id").notNull(),
  eventType: text("event_type").notNull(), // see AuditEventType in batches/contracts.ts (re-exported by audit/contracts.ts)
  detailJson: text("detail_json").notNull(),
  occurredAt: integer("occurred_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * `src/lib/video-details/`'s OWN audit trail (SCHEMA_MIGRATIONS version 5, 2026-09-20) --
 * deliberately a SECOND, separate table from `audit_events` above, not a reuse of it. Reason:
 * `audit_events.batch_id`/`ledger_row_id` are NOT NULL foreign keys into `batches`/
 * `batch_ledger_rows` -- a single-video Studio-parity "Details" edit is not a Batch and has
 * neither id, so satisfying those FKs would mean fabricating fake Batch/ledger rows for
 * something that isn't one (and polluting the Batches tab), or loosening two NOT NULL FK
 * constraints on Phase 5's tested audit trail, which is exactly the "first non-additive schema
 * change" docs/decisions/0001-additive-idempotent-schema-strategy.md says needs its own new ADR
 * before happening at all. This table has no foreign keys on purpose (an append-only audit log
 * should outlive the row it describes, and every new FK edge is one more thing
 * applySnapshotToDatabase/scrubDatabaseCopy have to keep surviving under RISK-33's
 * foreign_keys=ON default) -- `channelId`/`videoId` are plain TEXT.
 */
export const videoEditAuditEvents = sqliteTable("video_edit_audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: text("channel_id").notNull(),
  videoId: text("video_id").notNull(),
  eventType: text("event_type").notNull(), // see VideoEditAuditEventType in video-details/contracts.ts
  detailJson: text("detail_json").notNull(),
  occurredAt: integer("occurred_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Generic key/value app settings (SCHEMA_MIGRATIONS version 7) -- currently backs the Gate B
// "live writes" toggle and the MCP restricted-mode toggle (owner instruction, 2026-09-21,
// Settings tab). Deliberately a plain key/value table rather than one dedicated column per
// setting, since these two toggles are the first of what is expected to be several small,
// independent app-wide flags -- see `getAppSetting`/`setAppSetting` below.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * SCHEMA_MIGRATIONS version 10 (owner instruction, 2026-09-22, Telegram, refined after an
 * initial cumulative-counter design: "Я думаю лучше выводить 1. Сколько было попыток пройти
 * через шлюз за последние сутки 2. Сколько попыток пройти через шлюз увенчались успехом за
 * последние сутки"). One row per real call (`category`, `outcome`, `occurredAt`), not one
 * running-total row per category -- a rolling 24h window needs per-event timestamps to know
 * which calls are still "in the window," which a simple incrementing counter can never answer
 * once time has passed. See `getGatewayTrafficLast24h` below for the windowed read and
 * `pruneOldGatewayCallEvents` for why this table does not grow unboundedly forever.
 * `mcp_tool_calls` never records a `blocked` outcome: when MCP connection is off, a tool is
 * never registered at all, so there is no failed call to log, only an absent one.
 *
 * `cloud_monitoring_reads` (added 2026-09-22, owner instruction, Telegram, after being told
 * checking Google Cloud's own quota numbers is itself a real API call: "в таком случае на него
 * нам нужно повесить такие же счетчики, как на другие API") -- every real call
 * `src/lib/cloud-quotas/adapters/monitoring-client.ts` makes to the Cloud Monitoring API. Also
 * never records `blocked`: there is no enable/disable toggle for this category (unlike
 * `data_api_reads`/`analytics_reads`), so every attempt is, by definition, allowed.
 */
export const gatewayCallEvents = sqliteTable("gateway_call_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  outcome: text("outcome").notNull(),
  occurredAt: integer("occurred_at").notNull(),
});

/**
 * SCHEMA_MIGRATIONS version 12 -- one row per sync-gateway document family
 * (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4), recording the outcome of its
 * most recent sync cycle. Added for the Merge-tab redesign (owner instruction, 2026-09-23,
 * after a web-research pass on sync-status UX patterns: a one-off toast-style summary that
 * disappears on reload can't distinguish "synced moments ago" from "unreachable for days" --
 * exactly the failure mode that research found common). Always upserted (one row per family,
 * `family` is the primary key), never appended -- unlike `gateway_call_events` above, this is
 * current status, not a rolling-window log.
 */
export const syncFamilyStatus = sqliteTable("sync_family_status", {
  family: text("family").primaryKey(),
  lastSyncedAt: integer("last_synced_at"),
  lastSyncOk: integer("last_sync_ok", { mode: "boolean" }),
  lastError: text("last_error"),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Math.floor(Date.now() / 1000)),
});

/**
 * SCHEMA_MIGRATIONS version 11. A single, device-persistent Google Cloud OAuth grant, entirely
 * decoupled from the per-channel YouTube login in `users` (owner instruction, 2026-09-22,
 * Telegram: "право получать эту информацию не должно отзываться при смене аккаунта / логина...
 * пока я сам не отзову это право - этот компьютер должен в любой сессии иметь возможность
 * получить эту информацию"). Feeds `src/lib/cloud-quotas/`'s real Cloud Monitoring API calls
 * (`docs/decisions/0008-cloud-connection.md`, `docs/ARCHITECTURE.md` §16) -- no Cloud Quotas API
 * call exists anywhere in this codebase (a live spike found it unnecessary).
 *
 * A true singleton: exactly zero or one row, always keyed `id = "default"`, since this app
 * tracks at most one Cloud-level grant regardless of how many YouTube channels/logins it has
 * synced. `accessToken`/`refreshToken`/`tokenExpiry` are stored as one encrypted JSON blob
 * (AES-256-GCM, `src/lib/cloud-connection/crypto.ts`, key from `CLOUD_CONNECTION_ENCRYPTION_KEY`)
 * -- a DELIBERATELY SEPARATE key from `AI_CONNECTIONS_ENCRYPTION_KEY` (`docs/AGENTS.md` §M,
 * feature-module independence: the Cloud-quota feature must not fail closed just because the
 * unrelated AI-localization module's key is absent, or vice versa). Encrypted, unlike `users`'
 * plaintext tokens (`docs/TECHNICAL_DEBT.md` RISK-07), because this is still a real Google Cloud
 * grant (`monitoring.read`, narrowed 2026-09-22 from the originally-requested full `cloud-platform`
 * once the Cloud Quotas API that justified the broader scope turned out to be unnecessary) rather
 * than a YouTube-scoped token if the database file were ever read by someone else.
 *
 * `connectedEmail`/`scope`/`connectedAt` are plaintext (not secrets, shown as-is in Settings).
 *
 * **Deliberately NOT added to `SNAPSHOT_TRANSFERRED_TABLES`** (`src/lib/snapshot/contracts.ts`)
 * -- device-local, same reasoning as `users` and `ai_connection_credentials`: a Cloud grant is
 * re-established per device via its own Connect flow, never handed off with a snapshot.
 */
export const cloudConnection = sqliteTable("cloud_connection", {
  id: text("id").primaryKey(),
  connectedEmail: text("connected_email"),
  scope: text("scope"),
  ciphertext: text("ciphertext"),
  iv: text("iv"),
  authTag: text("auth_tag"),
  connectedAt: integer("connected_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Phase 8 (Intelligence Foundation, `docs/roadmap/plans/PHASE_8_PLAN.md` §5/§6 slice 2),
 * SCHEMA_MIGRATIONS version 8. Historical time-series metrics, additive alongside `videos`
 * (a "current snapshot" table, never a history) -- `docs/PROJECT_SPEC.md` §33's canonical
 * linkage is `channelId`/`videoId`/`date`, so `channelId` is stored directly here rather than
 * requiring every reader to join through `videos` to scope a query to a channel. `metricName`
 * (rather than one column per metric, e.g. `views`/`watchTimeMinutes`) keeps adding a future
 * metric purely additive -- no migration needed, consistent with
 * `docs/decisions/0002-additive-schema-versioning.md`.
 *
 * **`videoId` has a foreign key on `videos.id`**, matching `PHASE_8_PLAN.md` §5's own DDL
 * exactly. An earlier draft of this table omitted it, citing the `video_edit_audit_events` no-FK
 * precedent above and claiming an FK here would add a new table-ordering constraint to
 * `applySnapshotToDatabase`/`scrubDatabaseCopy` (`src/lib/snapshot/`) under RISK-33's
 * `foreign_keys=ON` default -- an independent review caught that this claim doesn't survive
 * reading those two functions: both already wrap their *entire* drop/replace sequence in
 * `PRAGMA foreign_keys = OFF` ... `ON` regardless of any relationship, so an FK here adds no new
 * ordering constraint to either. Unlike `video_edit_audit_events` (an audit trail that must
 * genuinely outlive the row it describes), this table has no such requirement, so there is no
 * remaining reason to deviate from the plan's own explicit schema. `channelId` stays a plain,
 * non-FK column -- a denormalized convenience for cheap per-channel filtering, never an
 * identity/authorization boundary (`write-context.assertWriteChannel` remains that).
 *
 * **Deliberately NOT added to `SNAPSHOT_TRANSFERRED_TABLES`** (`src/lib/snapshot/contracts.ts`)
 * in this slice -- collected metrics stay device-local and do not travel with a device
 * handoff/snapshot import. Accepted limitation, parallel in kind to RISK-33's own `rules.user_id`
 * orphan case: a snapshot-import replace of `videos` can leave a local `video_metrics_daily` row
 * referencing a `videoId` no longer present in the receiving device's `videos` table after import
 * (FK enforcement is disabled for that whole operation, so this never crashes, it just leaves a
 * stale row). See `docs/ARCHITECTURE.md` §14.7.
 *
 * Composite primary key `(videoId, metricDate, metricName)` mirrors the plan's own DDL exactly:
 * one row per video/day/metric, so re-collecting an already-collected date is a natural upsert,
 * not a duplicate-row bug (see `upsertVideoMetric` below).
 *
 * **`metricValue` is `REAL`, not `INTEGER`** (owner decision 2026-09-22, `PHASE_8_PLAN.md` §10
 * item 2 -- collect every metric `yt-analytics.readonly` covers, not `views` alone). Several of
 * those metrics are inherently fractional (e.g. `averageViewPercentage`,
 * `annotationClickThroughRate`) while others are integer counts (`views`, `likes`) -- `REAL`
 * represents both exactly (SQLite/JS doubles are exact for integers well beyond any realistic
 * view count) without a second, metric-type-dependent column. Changed here, before this table
 * ever merged to `dev` or shipped to a real database -- a genuinely non-additive column-type
 * change after that point would need its own ADR per
 * `docs/decisions/0001-additive-idempotent-schema-strategy.md`.
 */
export const videoMetricsDaily = sqliteTable(
  "video_metrics_daily",
  {
    channelId: text("channel_id").notNull(),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id),
    metricDate: text("metric_date").notNull(), // ISO date (YYYY-MM-DD), the Analytics API's own reporting-day granularity
    metricName: text("metric_name").notNull(), // e.g. "views" -- never a bag of untyped columns
    metricValue: real("metric_value").notNull(),
    collectedAt: integer("collected_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.metricDate, table.metricName] }),
    index("video_metrics_daily_channel_id_idx").on(table.channelId),
  ]
);

/**
 * SCHEMA_MIGRATIONS version 13 -- Phase 8 follow-up, data-quality diagnostics
 * (docs/roadmap/FUTURE_PHASES.md §4's "data-quality/missing-data diagnostics"). One row per
 * `collectMetrics` invocation (append-only, like `gatewayCallEvents` above, never updated) --
 * the ground truth for "was collection actually attempted for this channel/date range" and
 * "which videos failed," neither of which `video_metrics_daily` alone can answer: the Analytics
 * API silently OMITS a day with genuinely zero activity from its response (live-verified
 * 2026-09-23 against a real low-traffic video -- interior zero-view days never appear as rows at
 * all), so an absent `video_metrics_daily` row is ambiguous between "never collected" and
 * "collected, zero activity that day" without this table to disambiguate.
 */
export const analyticsCollectionRuns = sqliteTable(
  "analytics_collection_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id").notNull(),
    requestedStartDate: text("requested_start_date").notNull(),
    requestedEndDate: text("requested_end_date").notNull(),
    videoCount: integer("video_count").notNull(),
    upsertsIssued: integer("upserts_issued").notNull(),
    skippedVideoIdsJson: text("skipped_video_ids_json").notNull(),
    ranAt: integer("ran_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("analytics_collection_runs_channel_id_idx").on(table.channelId)]
);

/**
 * SCHEMA_MIGRATIONS version 14 -- Phase 8 follow-up, slice 4 (docs/roadmap/FUTURE_PHASES.md §4's
 * "analytical reports and weekly channel reviews"). One row per channel per Monday-Sunday week --
 * `reportJson` holds the full `WeeklyReportContent` (`src/lib/analytics/weekly-report.ts`), a
 * frozen, reproducible snapshot computed entirely from already-collected local data, never a live
 * YouTube call. `UNIQUE(channel_id, week_start_date)` prevents two concurrent dashboard-mount
 * triggers (e.g. two open tabs) from ever creating two rows for the same week; the application
 * layer (`runWeeklyReportIfDue`), not this table, enforces that a `status: "final"` row is never
 * overwritten by a later `upsertWeeklyReport` call for the same week.
 *
 * **Deliberately NOT added to `SNAPSHOT_TRANSFERRED_TABLES`** -- derived, re-computable data, the
 * same reasoning as `video_metrics_daily`/`analytics_collection_runs` above (docs/ARCHITECTURE.md
 * §14.7/§14.9): a snapshot report can always be regenerated locally from the data that IS
 * transferred, so it does not need to travel with a device handoff.
 */
export const analyticsWeeklyReports = sqliteTable(
  "analytics_weekly_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id").notNull(),
    weekStartDate: text("week_start_date").notNull(),
    weekEndDate: text("week_end_date").notNull(),
    status: text("status").notNull(), // "final" | "provisional"
    reportJson: text("report_json").notNull(),
    generatedAt: integer("generated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("analytics_weekly_reports_channel_week_idx").on(table.channelId, table.weekStartDate),
    index("analytics_weekly_reports_channel_id_idx").on(table.channelId),
  ]
);

/**
 * Phase 7 slice D (`src/lib/asset-catalog/`) -- a portable metadata catalog for pre-existing
 * production files (owner spec §15: "The agent needs access to files previously used in
 * production... Do not necessarily copy large binary files into API/MCP responses. Expose
 * metadata plus controlled file/resource handles."). `referenceValue` is stored and returned as
 * an opaque string only -- this module never reads/fetches it (no path-traversal/filesystem-
 * exposure surface, since the value is never resolved to an actual file).
 *
 * **Not in `SNAPSHOT_TRANSFERRED_TABLES`** (`src/lib/snapshot/contracts.ts`) as of this slice --
 * a registered asset stays device-local and does not travel with a device handoff/snapshot,
 * the same accepted limitation `video_metrics_daily` already has (`docs/ARCHITECTURE.md` §14.7).
 * Tracked in `docs/TECHNICAL_DEBT.md`.
 */
export const creativeAssets = sqliteTable(
  "creative_assets",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    assetType: text("asset_type").notNull(),
    referenceKind: text("reference_kind").notNull(),
    referenceValue: text("reference_value").notNull(),
    title: text("title"),
    description: text("description"),
    linkedVideoId: text("linked_video_id").references(() => videos.id),
    provenanceJson: text("provenance_json"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("creative_assets_channel_id_idx").on(table.channelId)]
);

/**
 * Phase 7 slice G (`src/lib/content-proposals/`) -- a structured Content Proposal (owner spec
 * §18): "Codex should be able to create a structured Content Proposal using application
 * context... The application does not need to generate every resulting asset." Write-once
 * (create/get/list only through this module's own API) -- there is no update/status/approval
 * concept for this domain (see `content-proposals/contracts.ts`'s own doc comment for why one
 * was deliberately not invented).
 *
 * `evidence_json`/`brief_json`/`reference_video_ids_json`/`reference_asset_ids_json` are bounded,
 * `.strict()`-validated JSON at the application layer (`content-proposals/schemas.ts`) -- the
 * heterogeneous remainder of owner spec §18's field list (title/thumbnail/visual/audio direction,
 * duration, publication hypothesis, localization strategy, experiment design, expected metrics,
 * required production outputs) is collapsed into `brief_json` rather than ~10 speculative
 * dedicated columns, since none of those fields is queried structurally anywhere in this
 * codebase yet.
 *
 * `created_via` is NOT NULL from creation (unlike `ai_localization_generation_provenance`'s own
 * nullable column) -- this is a brand-new table with no pre-existing rows created before this
 * field existed, so there is no backward-compatibility case to accommodate (owner spec §22,
 * SERVER-STAMPED, never taken from caller input).
 *
 * **Not in `SNAPSHOT_TRANSFERRED_TABLES`** (`src/lib/snapshot/contracts.ts`) -- same accepted,
 * device-local limitation `creative_assets` already has (`docs/TECHNICAL_DEBT.md` RISK-52).
 */
export const contentProposals = sqliteTable(
  "content_proposals",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    objective: text("objective"),
    topicConcept: text("topic_concept"),
    rationale: text("rationale"),
    evidenceJson: text("evidence_json"),
    briefJson: text("brief_json"),
    referenceVideoIdsJson: text("reference_video_ids_json"),
    referenceAssetIdsJson: text("reference_asset_ids_json"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdVia: text("created_via").notNull(),
    agentApiVersion: text("agent_api_version"),
  },
  (table) => [index("content_proposals_channel_id_idx").on(table.channelId)]
);

/**
 * Phase 7 slice G2 (`src/lib/content-proposals/`) -- links an externally-produced artifact
 * (registered via `asset-catalog`'s own `registerAsset`, AGENTS.md §D: never a second, parallel
 * asset-insert path) back to the Content Proposal that requested it (owner spec §19: "register
 * the artifact; associate it with a proposal/channel/video; record provenance; make it available
 * as future agent context"). Owned by `content-proposals`, not `asset-catalog` -- `creative_assets`
 * itself gained no new column for this; disabling/removing `content-proposals` leaves
 * `asset-catalog`'s own schema and code completely untouched (`AGENTS.md` §M).
 *
 * `created_via` is NOT NULL from creation, same reasoning as `content_proposals` above -- a
 * brand-new table with no pre-existing rows.
 *
 * **Not in `SNAPSHOT_TRANSFERRED_TABLES`** -- same accepted, device-local limitation as
 * `content_proposals`/`creative_assets` (`docs/TECHNICAL_DEBT.md` RISK-52).
 */
export const contentProposalArtifacts = sqliteTable(
  "content_proposal_artifacts",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => contentProposals.id),
    assetId: text("asset_id")
      .notNull()
      .references(() => creativeAssets.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdVia: text("created_via").notNull(),
    agentApiVersion: text("agent_api_version"),
  },
  (table) => [index("content_proposal_artifacts_proposal_id_idx").on(table.proposalId)]
);

// docs/decisions/0002-additive-schema-versioning.md: every table this baseline block creates
// is retroactively "schema version 1". A version newer than this is applied via
// SCHEMA_MIGRATIONS below, never by editing the statements inside this block.
export const SCHEMA_BASELINE_VERSION = 1;

// RISK-33 (docs/TECHNICAL_DEBT.md): shared by the legacy baseline's own idempotent ALTER TABLEs
// and by any SCHEMA_MIGRATIONS entry that adds a column -- a migration can be re-applied against
// a database that was previously initialized without a `schema_meta` stamp (see
// initializeDatabaseSchema's pre-versioning-database handling below), so `ALTER TABLE ADD COLUMN`
// must tolerate "already exists" as its one expected, legitimate failure. Any other error (disk
// I/O, corruption, a genuinely malformed statement) still propagates.
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}

export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: 2,
    description: "app_operation_locks -- local device-scoped export/import/migration lock",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS app_operation_locks (" +
          "id TEXT PRIMARY KEY, " +
          "operation_type TEXT NOT NULL, " +
          "holder_pid INTEGER NOT NULL, " +
          "acquired_at TEXT NOT NULL)"
      );
    },
  },
  {
    version: 3,
    description:
      "snapshot_lineage, handoff_log, recovery_acknowledgements -- device-local snapshot/handoff bookkeeping",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS snapshot_lineage (" +
          "id TEXT PRIMARY KEY, " +
          "last_snapshot_id TEXT, " +
          "last_generation INTEGER NOT NULL DEFAULT 0)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS handoff_log (" +
          "id TEXT PRIMARY KEY, " +
          "direction TEXT NOT NULL, " +
          "snapshot_id TEXT NOT NULL, " +
          "recorded_at TEXT NOT NULL, " +
          "detail_json TEXT NOT NULL)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS recovery_acknowledgements (" +
          "id TEXT PRIMARY KEY, " +
          "acknowledged_at TEXT NOT NULL, " +
          "affected_batches_json TEXT NOT NULL, " +
          "note TEXT)"
      );
    },
  },
  {
    version: 4,
    description:
      "videos.view_count/comment_count/like_count -- Studio-parity Content tab (docs/roadmap/plans/STUDIO_PARITY_PLAN.md Slice S1)",
    apply: async (client) => {
      for (const column of ["view_count", "comment_count", "like_count"]) {
        try {
          await client.execute(`ALTER TABLE videos ADD COLUMN ${column} INTEGER`);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 5,
    description:
      "video_edit_audit_events -- src/lib/video-details/'s own audit trail, separate from audit_events (see the comment above the table definition for why); no foreign keys",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS video_edit_audit_events (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "channel_id TEXT NOT NULL, " +
          "video_id TEXT NOT NULL, " +
          "event_type TEXT NOT NULL, " +
          "detail_json TEXT NOT NULL, " +
          "occurred_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS video_edit_audit_events_video_id_idx ON video_edit_audit_events(video_id)"
      );
    },
  },
  {
    version: 6,
    description:
      "channels.target_languages_json -- Languages tab tracked-language columns (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2/E5, owner instruction 2026-09-21)",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE channels ADD COLUMN target_languages_json TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 7,
    description:
      "app_settings -- generic key/value app-wide settings (Settings tab: live-writes/MCP-restricted-mode toggles, owner instruction 2026-09-21)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
      );
    },
  },
  {
    version: 8,
    description:
      "video_metrics_daily -- Phase 8 historical metrics time-series (docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 2); video_id has a foreign key on videos(id), see the table's own comment above for why",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS video_metrics_daily (" +
          "channel_id TEXT NOT NULL, " +
          "video_id TEXT NOT NULL REFERENCES videos(id), " +
          "metric_date TEXT NOT NULL, " +
          "metric_name TEXT NOT NULL, " +
          "metric_value REAL NOT NULL, " +
          "collected_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "PRIMARY KEY (video_id, metric_date, metric_name))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS video_metrics_daily_channel_id_idx ON video_metrics_daily(channel_id)"
      );
    },
  },
  {
    version: 9,
    description:
      "channels.analytics_last_auto_collected_at -- Phase 8 daily auto-collection staleness check (docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5)",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE channels ADD COLUMN analytics_last_auto_collected_at INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 10,
    description:
      "gateway_call_events -- per-call event log for the Settings tab's rolling 24h traffic stats (owner instruction, 2026-09-22, Telegram: \"сколько было попыток пройти через шлюз за последние сутки... сколько попыток... увенчались успехом\")",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS gateway_call_events (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "category TEXT NOT NULL, " +
          "outcome TEXT NOT NULL, " +
          "occurred_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS gateway_call_events_category_occurred_at_idx ON gateway_call_events(category, occurred_at)"
      );
    },
  },
  {
    version: 11,
    description:
      "cloud_connection -- single device-persistent Google Cloud OAuth grant, decoupled from channel login (owner instruction, 2026-09-22, Telegram, docs/decisions/0008-cloud-connection.md)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS cloud_connection (" +
          "id TEXT PRIMARY KEY, " +
          "connected_email TEXT, " +
          "scope TEXT, " +
          "ciphertext TEXT, " +
          "iv TEXT, " +
          "auth_tag TEXT, " +
          "connected_at INTEGER, " +
          "updated_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
    },
  },
  {
    version: 12,
    description:
      "sync_family_status -- persistent last-sync-outcome per sync-gateway document family, Merge-tab redesign (owner instruction, 2026-09-23)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS sync_family_status (" +
          "family TEXT PRIMARY KEY, " +
          "last_synced_at INTEGER, " +
          "last_sync_ok INTEGER, " +
          "last_error TEXT, " +
          "updated_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
    },
  },
  {
    version: 13,
    description:
      "analytics_collection_runs -- append-only log of each collectMetrics run, for data-quality diagnostics (docs/roadmap/FUTURE_PHASES.md §4)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS analytics_collection_runs (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "channel_id TEXT NOT NULL, " +
          "requested_start_date TEXT NOT NULL, " +
          "requested_end_date TEXT NOT NULL, " +
          "video_count INTEGER NOT NULL, " +
          "upserts_issued INTEGER NOT NULL, " +
          "skipped_video_ids_json TEXT NOT NULL, " +
          "ran_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS analytics_collection_runs_channel_id_idx ON analytics_collection_runs(channel_id)"
      );
    },
  },
  {
    version: 14,
    description:
      "analytics_weekly_reports -- reproducible weekly analytics snapshots, Phase 8 follow-up slice 4 (docs/roadmap/FUTURE_PHASES.md §4)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS analytics_weekly_reports (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "channel_id TEXT NOT NULL, " +
          "week_start_date TEXT NOT NULL, " +
          "week_end_date TEXT NOT NULL, " +
          "status TEXT NOT NULL, " +
          "report_json TEXT NOT NULL, " +
          "generated_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS analytics_weekly_reports_channel_week_idx ON analytics_weekly_reports(channel_id, week_start_date)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS analytics_weekly_reports_channel_id_idx ON analytics_weekly_reports(channel_id)"
      );
    },
  },
  {
    version: 15,
    description:
      "creative_assets -- portable metadata catalog for pre-existing production files, Phase 7 slice D (docs/AGENT_OPERATIONS_INTERFACE.md §4c)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS creative_assets (" +
          "id TEXT PRIMARY KEY, " +
          "channel_id TEXT NOT NULL REFERENCES channels(id), " +
          "asset_type TEXT NOT NULL, " +
          "reference_kind TEXT NOT NULL, " +
          "reference_value TEXT NOT NULL, " +
          "title TEXT, " +
          "description TEXT, " +
          "linked_video_id TEXT REFERENCES videos(id), " +
          "provenance_json TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS creative_assets_channel_id_idx ON creative_assets(channel_id)"
      );
    },
  },
  {
    version: 16,
    description:
      "ai_localization_generation_provenance -- additive evidence/rationale/createdVia/agentApiVersion columns, Phase 7 slice F (docs/AGENT_OPERATIONS_INTERFACE.md §4e, owner spec §12/§13/§22)",
    apply: async (client) => {
      // SQLite only supports one column per ALTER TABLE ... ADD COLUMN statement -- four
      // separate calls, each additive and nullable (no backfill needed/possible for existing
      // rows, which simply have no evidence/rationale/creator-identity recorded, same "never
      // fabricate" discipline this codebase already applies elsewhere). Each wrapped in the same
      // isDuplicateColumnError tolerance as every other ADD-COLUMN migration above (RISK-33) --
      // required here too, since a pre-versioning database can already carry these columns.
      for (const column of ["evidence_json", "rationale", "created_via", "agent_api_version"]) {
        try {
          await client.execute(`ALTER TABLE ai_localization_generation_provenance ADD COLUMN ${column} TEXT`);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 17,
    description:
      "content_proposals -- structured Content Proposal records, Phase 7 slice G (docs/AGENT_OPERATIONS_INTERFACE.md §4f, owner spec §18/§19/§20)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS content_proposals (" +
          "id TEXT PRIMARY KEY, " +
          "channel_id TEXT NOT NULL REFERENCES channels(id), " +
          "objective TEXT, " +
          "topic_concept TEXT, " +
          "rationale TEXT, " +
          "evidence_json TEXT, " +
          "brief_json TEXT, " +
          "reference_video_ids_json TEXT, " +
          "reference_asset_ids_json TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "created_via TEXT NOT NULL, " +
          "agent_api_version TEXT)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS content_proposals_channel_id_idx ON content_proposals(channel_id)"
      );
    },
  },
  {
    version: 18,
    description:
      "content_proposal_artifacts -- link table for externally-produced artifacts registered against a Content Proposal, Phase 7 slice G2 (docs/AGENT_OPERATIONS_INTERFACE.md §4f, owner spec §19)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS content_proposal_artifacts (" +
          "id TEXT PRIMARY KEY, " +
          "proposal_id TEXT NOT NULL REFERENCES content_proposals(id), " +
          "asset_id TEXT NOT NULL REFERENCES creative_assets(id), " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "created_via TEXT NOT NULL, " +
          "agent_api_version TEXT)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS content_proposal_artifacts_proposal_id_idx ON content_proposal_artifacts(proposal_id)"
      );
    },
  },
];

export const SCHEMA_CURRENT_VERSION =
  SCHEMA_MIGRATIONS.length > 0
    ? Math.max(...SCHEMA_MIGRATIONS.map((m) => m.version))
    : SCHEMA_BASELINE_VERSION;

// Exported so schema-initialization tests can point a throwaway libSQL client at an
// isolated temporary database file (per docs/DEVELOPMENT_PLAYBOOK.md §6.11) instead of
// touching data/playlist-manager.db. Behavior is identical to the singleton path below.
//
// Boot order (decision 8, docs/decisions/0002-additive-schema-versioning.md): PRAGMAs (never
// schema-mutating) -> read-only version check, rejecting a newer-than-supported database
// before any CREATE/ALTER/INSERT runs -> the existing additive baseline block, unchanged ->
// any migrations strictly newer than the stamped version, each committing its own version
// bump only on success.
export async function initializeDatabaseSchema(
  client: Client,
  options?: {
    /** Called once, only when at least one migration beyond the baseline is about to run --
     * the singleton boot path below uses this to take a pre-migration backup
     * (AC-SCHEMA-08). Isolated test clients may omit it; no backup is taken in that case. */
    beforeMigrations?: (context: {
      fromVersion: number;
      pendingMigrations: SchemaMigration[];
    }) => Promise<void>;
  }
): Promise<void> {
  // Without this, a transaction opened on one connection (e.g. beginAttemptIntent's or
  // recordAttemptResult's guarded claim-then-write) makes any concurrent transaction on
  // a DIFFERENT connection to the same file fail immediately with SQLITE_BUSY instead of
  // waiting -- observed directly while testing genuine concurrent attempt claims. This
  // makes SQLite retry internally for up to 5s before giving up, which is what turns a
  // correct atomic transaction into one that also behaves correctly under real
  // concurrent access from more than one connection.
  await client.execute("PRAGMA busy_timeout = 5000");
  // WAL allows one writer and many concurrent readers without them blocking each other
  // at the file-lock level, which is what makes two separate connections' transactions
  // interleave safely instead of racing for the same exclusive rollback-journal lock.
  await client.execute("PRAGMA journal_mode = WAL");

  // Reject a database reporting a version newer than this build supports *before* any
  // schema-mutating statement below runs (AC-SCHEMA-04) -- assertSupportedSchemaVersion only
  // ever performs a read.
  const foundVersion = await assertSupportedSchemaVersion(client, SCHEMA_CURRENT_VERSION);

  // The `rules` table (auto-playlisting engine, upstream TubeMaster baseline) is retired as of
  // 2026-09-20 -- its Drizzle definition, UI, and API routes are removed, per the project
  // owner's explicit instruction ("давай удалим их, т.к. пока не вижу им применения"). This
  // CREATE TABLE statement is deliberately left in place rather than replaced with a DROP TABLE
  // migration: per docs/decisions/0001-additive-idempotent-schema-strategy.md, a subtractive
  // schema change needs its own new ADR before this project's migration strategy changes, and
  // there is no operational need to force one for a table nothing reads or writes anymore -- an
  // existing local database's `rules` rows (if any) are simply left untouched and orphaned, and
  // a fresh install gets a harmless, permanently-empty table. Revisit only if that ADR is written.
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL,
      image TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry INTEGER,
      oauth_scope TEXT,
      selected_channel_id TEXT
    );
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      match_field TEXT NOT NULL,
      match_type TEXT NOT NULL,
      match_value TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      playlist_title TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      thumbnail_url TEXT,
      uploads_playlist_id TEXT NOT NULL,
      connected_user_id TEXT,
      connected_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_synced_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      published_at TEXT NOT NULL,
      privacy_status TEXT NOT NULL,
      default_language TEXT,
      default_audio_language TEXT,
      thumbnails_json TEXT NOT NULL,
      localizations_json TEXT NOT NULL,
      etag TEXT,
      last_synced_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS videos_channel_id_idx ON videos(channel_id);
    CREATE TABLE IF NOT EXISTS change_sets (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      imported_filename TEXT,
      schema_version TEXT,
      exported_at TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS change_sets_channel_id_idx ON change_sets(channel_id);
    CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY,
      change_set_id TEXT NOT NULL REFERENCES change_sets(id),
      video_id TEXT NOT NULL,
      language TEXT NOT NULL,
      field TEXT NOT NULL,
      baseline_value TEXT NOT NULL,
      proposed_value TEXT NOT NULL,
      change_type TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      validation_error TEXT,
      conflict_status TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      approved_value TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS changes_change_set_id_idx ON changes(change_set_id);
    CREATE INDEX IF NOT EXISTS changes_video_id_idx ON changes(video_id);
    CREATE TABLE IF NOT EXISTS channel_editorial_profiles (
      channel_id TEXT PRIMARY KEY REFERENCES channels(id),
      version INTEGER NOT NULL DEFAULT 1,
      target_audience TEXT,
      tone_notes TEXT,
      terminology_notes TEXT,
      title_constraints TEXT,
      description_constraints TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS ai_localization_generation_provenance (
      id TEXT PRIMARY KEY,
      change_set_id TEXT NOT NULL UNIQUE REFERENCES change_sets(id),
      channel_id TEXT NOT NULL REFERENCES channels(id),
      profile_version INTEGER,
      effective_context_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS ai_localization_generation_provenance_channel_id_idx ON ai_localization_generation_provenance(channel_id);
    CREATE TABLE IF NOT EXISTS ai_connections (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      base_url TEXT,
      model_id TEXT NOT NULL,
      local_inference_mode INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_message TEXT,
      status_checked_at INTEGER,
      capabilities_json TEXT NOT NULL,
      assigned_tasks_json TEXT NOT NULL DEFAULT '["ai_localization"]',
      pricing_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS ai_connection_credentials (
      connection_id TEXT PRIMARY KEY REFERENCES ai_connections(id),
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      status TEXT NOT NULL,
      concurrency INTEGER NOT NULL DEFAULT 1,
      dry_run INTEGER NOT NULL DEFAULT 1,
      run_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS batches_channel_id_idx ON batches(channel_id);
    CREATE TABLE IF NOT EXISTS batch_ledger_rows (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      video_id TEXT NOT NULL,
      change_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      verification_result_json TEXT,
      active_attempt_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (batch_id, video_id)
    );
    CREATE INDEX IF NOT EXISTS batch_ledger_rows_batch_id_idx ON batch_ledger_rows(batch_id);
    CREATE TABLE IF NOT EXISTS batch_attempts (
      id TEXT PRIMARY KEY,
      ledger_row_id TEXT NOT NULL REFERENCES batch_ledger_rows(id),
      attempt_number INTEGER NOT NULL,
      phase TEXT NOT NULL,
      payload_snapshot_json TEXT NOT NULL,
      requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
      outcome TEXT,
      outcome_detail TEXT,
      result_at INTEGER,
      UNIQUE (ledger_row_id, attempt_number)
    );
    CREATE INDEX IF NOT EXISTS batch_attempts_ledger_row_id_idx ON batch_attempts(ledger_row_id);
    CREATE TABLE IF NOT EXISTS video_execution_locks (
      video_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      ledger_row_id TEXT NOT NULL REFERENCES batch_ledger_rows(id),
      locked_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      -- INTEGER PRIMARY KEY aliases to SQLite's rowid, which is strictly increasing on
      -- insert -- this is what makes a ledger row's full event sequence reconstructable
      -- in exact order (AC-AUDIT-01/04) even when two events share the same occurred_at
      -- millisecond.
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      ledger_row_id TEXT NOT NULL REFERENCES batch_ledger_rows(id),
      video_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS audit_events_ledger_row_id_idx ON audit_events(ledger_row_id);
    CREATE INDEX IF NOT EXISTS audit_events_batch_id_idx ON audit_events(batch_id);
  `);

  // Migration: add selected_channel_id if missing (idempotent)
  try {
    await client.execute("ALTER TABLE users ADD COLUMN selected_channel_id TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }

  // Migration: add oauth_scope if missing (idempotent)
  try {
    await client.execute("ALTER TABLE users ADD COLUMN oauth_scope TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }

  // Migration: add active_attempt_id if missing (idempotent) -- for a database file that
  // already has batch_ledger_rows from before this column was added to CREATE TABLE.
  try {
    await client.execute("ALTER TABLE batch_ledger_rows ADD COLUMN active_attempt_id TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }

  // Everything above this point is the pre-existing, unchanged additive baseline (schema
  // version 1, docs/decisions/0001-additive-idempotent-schema-strategy.md). From here,
  // schema versioning (docs/decisions/0002-additive-schema-versioning.md) takes over for
  // anything beyond it.
  const stampedBeforeMigrations = foundVersion ?? SCHEMA_BASELINE_VERSION;
  const pendingMigrations = SCHEMA_MIGRATIONS.filter(
    (migration) => migration.version > stampedBeforeMigrations
  );

  if (pendingMigrations.length > 0 && options?.beforeMigrations) {
    await options.beforeMigrations({
      fromVersion: stampedBeforeMigrations,
      pendingMigrations,
    });
  }

  await runSchemaMigrations(client, {
    migrations: SCHEMA_MIGRATIONS,
    currentVersion: foundVersion,
    baselineVersion: SCHEMA_BASELINE_VERSION,
  });
}

async function initializeDatabase() {
  await migrateLegacyDatabaseIfNeeded();

  // RISK-20 (docs/TECHNICAL_DEBT.md): serialize boot-time schema migration against export/
  // import and a concurrent second process (CLI + web app, or two app instances) starting
  // against the same DB file -- the same operation lock those already use via
  // withOperationLock. One narrow, unavoidable exception: app_operation_locks itself is
  // created BY this migration path (SCHEMA_MIGRATIONS version 2) -- on a database still below
  // that version, the lock table doesn't exist yet, so there is structurally nothing to lock
  // with. That one bootstrap-to-v2 step proceeds unlocked (a low-risk, one-time, idempotent
  // CREATE TABLE); every later boot, once the lock table exists, is properly serialized.
  let lockAcquired = false;
  try {
    await acquireOperationLock(rawClient, "migration");
    lockAcquired = true;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  try {
    await initializeDatabaseSchema(rawClient, {
      beforeMigrations: async () => {
        const destPath = path.join(
          appPaths.migrationBackupsDir,
          `pre-migration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
        );
        await copyDatabaseConsistently(rawClient, destPath);
      },
    });
  } finally {
    if (lockAcquired) await releaseOperationLock(rawClient);
  }

  // Gate B toggle (owner instruction, 2026-09-21): "по дефолту при запуске сессии он выключен"
  // -- unconditionally forced back to false on every process boot (Web app, MCP server, or CLI
  // command, whichever imports this module first), regardless of what was last saved. This is
  // what makes "off by default each session" hold even though the flag itself is durably
  // persisted (required for multiple processes/workers to agree on its value while a session is
  // actually running) rather than an in-memory variable.
  //
  // Deliberately `rawClient.execute` here, NOT `setLiveWritesEnabled`/the guarded `db` object:
  // this function's own promise IS `databaseInitialization`, so the guarded client's "await
  // databaseInitialization first" wrapper would deadlock waiting for this very call to finish.
  await rawClient.execute({
    sql: "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: ["live_writes_enabled", "false"],
  });

  // The read-side toggles (`data_api_reads_enabled`/`analytics_reads_enabled`, see
  // `getDataApiReadsEnabled`/`getAnalyticsReadsEnabled` below) are deliberately NOT reset here,
  // unlike `live_writes_enabled` above -- they persist across restarts by design (see their own
  // doc comment for why). Do not add them to this per-boot reset without re-reading that
  // reasoning first.
}

export const databaseInitialization = initializeDatabase().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  throw new Error(`Database initialization failed: ${message}`);
});

const client = new Proxy(rawClient, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);

    if (typeof value !== "function") {
      return value;
    }

    if (
      property === "execute" ||
      property === "batch" ||
      property === "transaction" ||
      property === "executeMultiple"
    ) {
      return async (...args: unknown[]) => {
        await databaseInitialization;
        return Reflect.apply(value, target, args);
      };
    }

    return value.bind(target);
  },
});

/**
 * The same initialization-guarded client `db` (below) is built on, exposed directly for
 * modules that need raw SQL access rather than Drizzle's query builder -- src/lib/snapshot/
 * and src/lib/device-handoff/ (ATTACH/VACUUM/PRAGMA are not expressible through Drizzle),
 * and src/proxy.ts / CLI / MCP choke points calling `assertDeviceAvailableForMutation`.
 * Every call still waits for `databaseInitialization` first, exactly like `db` does.
 */
export const rawSqlClient: Client = client;

const dbSchema = {
  users,
  channels,
  videos,
  changeSets,
  changes,
  channelEditorialProfiles,
  aiLocalizationGenerationProvenance,
  aiConnections,
  aiConnectionCredentials,
  batches,
  batchLedgerRows,
  batchAttempts,
  videoExecutionLocks,
  auditEvents,
  videoEditAuditEvents,
  videoMetricsDaily,
};

export const db = drizzle(client, { schema: dbSchema });

export type AppDb = typeof db;

/**
 * For tests only (docs/DEVELOPMENT_PLAYBOOK.md §6.11): builds a drizzle instance bound to
 * an isolated client (e.g. a temp libSQL file under os.tmpdir()) with the exact same
 * schema as the production singleton above. Never point this at data/playlist-manager.db.
 */
export function createIsolatedDb(isolatedClient: Client): AppDb {
  return drizzle(isolatedClient, { schema: dbSchema }) as AppDb;
}

export type StoredOAuthToken = {
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: number | null;
  scope: string | null;
};

export async function getUserOAuthTokens(
  userId: string
): Promise<StoredOAuthToken | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row) return null;

  return {
    userId: row.id,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    tokenExpiry: row.tokenExpiry,
    scope: row.oauthScope,
  };
}

export async function saveUserOAuthTokens(
  userId: string,
  patch: Partial<Omit<StoredOAuthToken, "userId">>
) {
  await db
    .update(users)
    .set({
      accessToken: patch.accessToken,
      refreshToken: patch.refreshToken,
      tokenExpiry: patch.tokenExpiry,
      oauthScope: patch.scope,
    })
    .where(eq(users.id, userId));
}

type UpsertUserOAuthOnSignInInput = {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: number | null;
  scope: string | null;
};

export async function upsertUserOAuthOnSignIn(
  input: UpsertUserOAuthOnSignInInput
) {
  const existing = await getUserOAuthTokens(input.userId);

  if (existing) {
    await db
      .update(users)
      .set({
        name: input.name,
        email: input.email,
        image: input.image,
        accessToken: input.accessToken ?? existing.accessToken,
        refreshToken: input.refreshToken ?? existing.refreshToken,
        tokenExpiry: input.tokenExpiry,
        oauthScope: input.scope ?? existing.scope,
      })
      .where(eq(users.id, input.userId));
    return;
  }

  await db.insert(users).values({
    id: input.userId,
    name: input.name,
    email: input.email,
    image: input.image,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenExpiry: input.tokenExpiry,
    oauthScope: input.scope,
  });
}

export type UpsertOAuthUserFromCliInput = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiry: number | null;
  scope: string | null;
};

export type OAuthUserSummary = {
  userId: string;
  email: string;
  name: string | null;
  tokenExpiry: number | null;
  hasRefreshToken: boolean;
};

export async function upsertOAuthUserFromCli(input: UpsertOAuthUserFromCliInput) {
  const [existing] = await db.select().from(users).where(eq(users.id, input.userId));

  if (existing) {
    await db
      .update(users)
      .set({
        email: input.email,
        name: input.name,
        image: input.image,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? existing.refreshToken,
        tokenExpiry: input.tokenExpiry,
        oauthScope: input.scope ?? existing.oauthScope,
      })
      .where(eq(users.id, input.userId));

    return;
  }

  await db.insert(users).values({
    id: input.userId,
    email: input.email,
    name: input.name,
    image: input.image,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenExpiry: input.tokenExpiry,
    oauthScope: input.scope,
  });
}

export async function listOAuthUsers(): Promise<OAuthUserSummary[]> {
  const rows = await db.select().from(users);

  return rows
    .map((row) => ({
      userId: row.id,
      email: row.email,
      name: row.name,
      tokenExpiry: row.tokenExpiry,
      hasRefreshToken: !!row.refreshToken,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function getOAuthUserSummary(
  userId: string
): Promise<OAuthUserSummary | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row) return null;

  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    tokenExpiry: row.tokenExpiry,
    hasRefreshToken: !!row.refreshToken,
  };
}

// `docs/decisions/0010-persistent-channel-connections.md` -- narrow, single-purpose read for the
// new channel-connections module (AGENTS.md §D: doesn't reuse `OAuthUserSummary`, which is a CLI
// concept lacking `image` and never needing an "is there a usable access token" flag).
export type UserProfileForActivation = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  hasAccessToken: boolean;
};

export async function getUserProfileForActivation(
  userId: string
): Promise<UserProfileForActivation | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row) return null;

  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    hasAccessToken: !!row.accessToken,
  };
}

export async function clearUserOAuthTokens(userId: string) {
  await db
    .update(users)
    .set({
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      oauthScope: null,
    })
    .where(eq(users.id, userId));
}

export async function getSelectedChannelId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ selectedChannelId: users.selectedChannelId })
    .from(users)
    .where(eq(users.id, userId));

  return row?.selectedChannelId ?? null;
}

export async function setSelectedChannelId(userId: string, channelId: string): Promise<void> {
  await db
    .update(users)
    .set({ selectedChannelId: channelId })
    .where(eq(users.id, userId));
}

export type ThumbnailInfo = {
  url: string;
  width: number | null;
  height: number | null;
};

export type LocaleMetadataRecord = {
  title: string;
  description: string;
};

export type StoredChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  connectedUserId: string | null;
  connectedAt: Date;
  lastSyncedAt: Date | null;
  analyticsLastAutoCollectedAt: Date | null;
};

export type StoredVideo = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, ThumbnailInfo>;
  existingLocalizations: Record<string, LocaleMetadataRecord>;
  etag: string | null;
  viewCount: number | null;
  commentCount: number | null;
  likeCount: number | null;
  lastSyncedAt: Date;
};

function mapStoredChannel(row: typeof channels.$inferSelect): StoredChannel {
  return {
    channelId: row.id,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    uploadsPlaylistId: row.uploadsPlaylistId,
    connectedUserId: row.connectedUserId,
    connectedAt: row.connectedAt,
    lastSyncedAt: row.lastSyncedAt,
    analyticsLastAutoCollectedAt: row.analyticsLastAutoCollectedAt,
  };
}

function mapStoredVideo(row: typeof videos.$inferSelect): StoredVideo {
  return {
    videoId: row.id,
    channelId: row.channelId,
    title: row.title,
    description: row.description,
    publishedAt: row.publishedAt,
    privacyStatus: row.privacyStatus,
    defaultLanguage: row.defaultLanguage,
    defaultAudioLanguage: row.defaultAudioLanguage,
    thumbnails: JSON.parse(row.thumbnailsJson) as Record<string, ThumbnailInfo>,
    existingLocalizations: JSON.parse(row.localizationsJson) as Record<
      string,
      LocaleMetadataRecord
    >,
    etag: row.etag,
    viewCount: row.viewCount,
    commentCount: row.commentCount,
    likeCount: row.likeCount,
    lastSyncedAt: row.lastSyncedAt,
  };
}

export async function upsertChannel(input: {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  connectedUserId: string | null;
}): Promise<void> {
  await db
    .insert(channels)
    .values({
      id: input.channelId,
      title: input.title,
      thumbnailUrl: input.thumbnailUrl,
      uploadsPlaylistId: input.uploadsPlaylistId,
      connectedUserId: input.connectedUserId,
    })
    .onConflictDoUpdate({
      target: channels.id,
      set: {
        title: input.title,
        thumbnailUrl: input.thumbnailUrl,
        uploadsPlaylistId: input.uploadsPlaylistId,
        connectedUserId: input.connectedUserId,
      },
    });
}

export async function markChannelSynced(channelId: string, syncedAt: Date): Promise<void> {
  await db.update(channels).set({ lastSyncedAt: syncedAt }).where(eq(channels.id, channelId));
}

// `docs/decisions/0010-persistent-channel-connections.md` -- disconnecting a channel connection
// clears the link without touching the channel's own cached metadata (title/thumbnail/etc.),
// which stays visible to the rest of the app even after disconnecting its OAuth identity.
export async function setChannelConnectedUserId(
  channelId: string,
  connectedUserId: string | null
): Promise<void> {
  await db.update(channels).set({ connectedUserId }).where(eq(channels.id, channelId));
}

// BL-059 -- written BEFORE a collection run starts (mark-then-run), not after, so two concurrent
// triggers never both see "stale" and both run a full collection (src/lib/analytics/staleness.ts).
// Takes an injectable `database` (unlike the older markChannelSynced) so schema-initialization
// tests can exercise it against an isolated temp database (docs/DEVELOPMENT_PLAYBOOK.md §6.11)
// rather than the operator's real one.
export async function markAnalyticsAutoCollected(
  channelId: string,
  at: Date,
  database: AppDb = db
): Promise<void> {
  await database.update(channels).set({ analyticsLastAutoCollectedAt: at }).where(eq(channels.id, channelId));
}

export async function listStoredChannels(): Promise<StoredChannel[]> {
  const rows = await db.select().from(channels);
  return rows.map(mapStoredChannel);
}

export async function getStoredChannel(channelId: string): Promise<StoredChannel | null> {
  const [row] = await db.select().from(channels).where(eq(channels.id, channelId));
  return row ? mapStoredChannel(row) : null;
}

/** Deliberately separate from `StoredChannel`/`mapStoredChannel` -- almost nothing besides
 * `src/lib/localization/` needs the tracked-languages list, and every other consumer of
 * `StoredChannel` (channel-sync, changesets, ai-localization, batches) would otherwise have to
 * carry a field it never uses (AGENTS.md §D's "narrow, don't ripple" pattern, same reasoning as
 * `PendingChangeRecord`'s own narrow copy of `Change`). */
export async function getChannelTargetLanguages(channelId: string): Promise<string[]> {
  const [row] = await db
    .select({ targetLanguagesJson: channels.targetLanguagesJson })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!row?.targetLanguagesJson) return [];
  try {
    const parsed: unknown = JSON.parse(row.targetLanguagesJson);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export async function setChannelTargetLanguages(channelId: string, languages: string[]): Promise<void> {
  await db.update(channels).set({ targetLanguagesJson: JSON.stringify(languages) }).where(eq(channels.id, channelId));
}

async function getAppSetting(key: string, database: AppDb = db): Promise<string | null> {
  const [row] = await database.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  return row?.value ?? null;
}

async function setAppSetting(key: string, value: string, database: AppDb = db): Promise<void> {
  await database
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
}

const LIVE_WRITES_ENABLED_SETTING_KEY = "live_writes_enabled";
const MCP_CONNECTION_ENABLED_SETTING_KEY = "mcp_connection_enabled";

/**
 * The persisted half of the Gate B toggle (owner instruction, 2026-09-21, Settings tab) --
 * `src/lib/batches/adapters/write-executor.youtube.ts`'s `assertLiveWritesAuthorized()` reads
 * this at call time (not cached, not captured at construction) as the SECOND of two independent
 * layers: `src/lib/batches/index.ts` still only constructs a real `WriteExecutor` when this is
 * true (layer 1 -- no code path to `videos.update` exists at all otherwise), and this function
 * re-checks it again immediately before the write (layer 2). Persisted, not an in-memory module
 * variable, so every process that reads it (the Web app, a separately-spawned MCP process, the
 * CLI) agrees -- see `initializeDatabase()`'s unconditional reset to `false` on every process
 * boot for how "off by default each session" is actually achieved despite that.
 */
export async function getLiveWritesEnabled(): Promise<boolean> {
  return (await getAppSetting(LIVE_WRITES_ENABLED_SETTING_KEY)) === "true";
}

export async function setLiveWritesEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(LIVE_WRITES_ENABLED_SETTING_KEY, enabled ? "true" : "false");
}

/**
 * "MCP connection" toggle (owner instruction, 2026-09-21, Settings tab -- renamed and inverted
 * from the earlier "MCP restricted mode": *"По началу MCP / агент от всего отключен и получит
 * доступ только если я зайду в настройки и переключу этот тумблер... Все взаимодействия MCP /
 * агента должны идти через это переключение."*). Defaults to `false` (fully disconnected --
 * `createMcpServer` registers zero tools) when no value has ever been saved. Unlike
 * `getLiveWritesEnabled`, this is a one-time setup toggle, not reset on every process boot --
 * the project owner explicitly confirmed it should persist across sessions once turned on,
 * the opposite of Gate B's "off by default every session" model. There is deliberately no
 * environment-variable fallback (the prior `MCP_RESTRICTED_MODE` env var is removed) -- the
 * Settings-tab toggle is now the one and only way to grant an MCP client any access at all.
 * **Known limitation, stated rather than solved (an MCP server's tool set is fixed at
 * `createMcpServer()` construction time, standard SDK behavior, not something this app can
 * hot-swap):** a currently-running, long-lived MCP connection keeps whatever tool set it started
 * with; this setting takes effect the next time an MCP client spawns/reconnects the server
 * process (`startMcpServer()` reads it fresh on each boot), not instantly for an already-open
 * session.
 */
export async function getMcpConnectionEnabled(): Promise<boolean> {
  return (await getAppSetting(MCP_CONNECTION_ENABLED_SETTING_KEY)) === "true";
}

export async function setMcpConnectionEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(MCP_CONNECTION_ENABLED_SETTING_KEY, enabled ? "true" : "false");
}

const DATA_API_READS_ENABLED_SETTING_KEY = "data_api_reads_enabled";
const ANALYTICS_READS_ENABLED_SETTING_KEY = "analytics_reads_enabled";

/**
 * Per-category "reads enabled" toggles (owner instruction, 2026-09-22, Telegram -- "выведи
 * такие же тублеры в настройки по запросам API (теперь входящим). Делаем отдельный тумблер на
 * каждый модуль / шлюз API чтения"), Settings tab, one per `src/lib/youtube-read-gateway/`
 * child. Read by `assertDataApiReadsAuthorized`/`assertAnalyticsReadsAuthorized`
 * (`docs/decisions/0007-youtube-read-gateway.md`) immediately before that category's client is
 * constructed -- the read-side analog of `getLiveWritesEnabled`'s Gate B check, mechanically
 * enforced the same way (`read-gateway-inventory.test.ts`).
 *
 * **Deliberately the opposite default and persistence model from `getLiveWritesEnabled`:**
 * reads are not a safety-critical action needing an off-by-default, reset-every-boot posture --
 * disabling one is an intentional, occasional "pause this data source" action, so each toggle
 * defaults to **enabled** when never set, and persists across restarts once changed (matching
 * `getMcpConnectionEnabled`'s persistence model, not `getLiveWritesEnabled`'s per-boot reset).
 */
// Takes an injectable `database` (like `getAnalyticsSyncSettings`, unlike
// `getLiveWritesEnabled`/`getMcpConnectionEnabled`) so the default-true-when-unset inversion --
// the one genuinely regressable bit of this pair -- can be exercised against an isolated temp
// database (docs/DEVELOPMENT_PLAYBOOK.md §6.11) rather than asserted only by reasoning.
export async function getDataApiReadsEnabled(database: AppDb = db): Promise<boolean> {
  return (await getAppSetting(DATA_API_READS_ENABLED_SETTING_KEY, database)) !== "false";
}

export async function setDataApiReadsEnabled(enabled: boolean, database: AppDb = db): Promise<void> {
  await setAppSetting(DATA_API_READS_ENABLED_SETTING_KEY, enabled ? "true" : "false", database);
}

export async function getAnalyticsReadsEnabled(database: AppDb = db): Promise<boolean> {
  return (await getAppSetting(ANALYTICS_READS_ENABLED_SETTING_KEY, database)) !== "false";
}

export async function setAnalyticsReadsEnabled(enabled: boolean, database: AppDb = db): Promise<void> {
  await setAppSetting(ANALYTICS_READS_ENABLED_SETTING_KEY, enabled ? "true" : "false", database);
}

export type GatewayTrafficCategory =
  | "data_api_reads"
  | "analytics_reads"
  | "live_writes"
  | "mcp_tool_calls"
  | "cloud_monitoring_reads";

export type GatewayTrafficWindow = {
  category: GatewayTrafficCategory;
  /** Every real call attempt in the window, allowed or blocked. */
  totalAttempts: number;
  /** The subset of `totalAttempts` that succeeded (passed the gate). */
  succeeded: number;
};

const GATEWAY_TRAFFIC_CATEGORIES: readonly GatewayTrafficCategory[] = [
  "data_api_reads",
  "analytics_reads",
  "live_writes",
  "mcp_tool_calls",
  "cloud_monitoring_reads",
];

// Kept well past the 24h window this table exists to answer (owner instruction, 2026-09-22:
// "сколько было попыток пройти через шлюз за последние сутки") -- a few days of slack in case
// that window is ever widened, without ever letting this table grow unboundedly over the life
// of a long-running local install. Pruned opportunistically on every write (call volumes here
// are at most dozens per session, so a DELETE on every insert is not a real cost).
const GATEWAY_CALL_EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Records one real call outcome for the given gateway category -- called from inside the
 * gateway's own assert function (`assertDataApiReadsAuthorized`, etc.) or, for
 * `mcp_tool_calls`, from the MCP server's shared tool-dispatch wrapper. Appends one event row
 * (never an update-in-place -- see the table's own doc comment for why a rolling window needs
 * per-event timestamps) and opportunistically prunes anything older than the retention window.
 */
export async function recordGatewayCallOutcome(
  category: GatewayTrafficCategory,
  outcome: "allowed" | "blocked",
  database: AppDb = db
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await database.insert(gatewayCallEvents).values({ category, outcome, occurredAt: now });
  await database
    .delete(gatewayCallEvents)
    .where(sql`${gatewayCallEvents.occurredAt} < ${now - GATEWAY_CALL_EVENT_RETENTION_SECONDS}`);
}

/**
 * Returns one row per known category, always -- a category with zero calls in the window still
 * gets a `{totalAttempts: 0, succeeded: 0}` entry, rather than being silently absent (the
 * Settings UI displays all four gateways regardless of whether each has been exercised yet).
 * `windowSeconds` defaults to 24h (the owner's own stated window); callers needing a different
 * window (a future "last 7 days" view, say) can pass one without touching the retention policy.
 */
export async function getGatewayTrafficLast24h(
  database: AppDb = db,
  windowSeconds = 24 * 60 * 60
): Promise<GatewayTrafficWindow[]> {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const rows = await database
    .select({
      category: gatewayCallEvents.category,
      outcome: gatewayCallEvents.outcome,
      count: sql<number>`count(*)`,
    })
    .from(gatewayCallEvents)
    .where(sql`${gatewayCallEvents.occurredAt} >= ${since}`)
    .groupBy(gatewayCallEvents.category, gatewayCallEvents.outcome);

  const totals = new Map<GatewayTrafficCategory, { totalAttempts: number; succeeded: number }>();
  for (const row of rows) {
    const category = row.category as GatewayTrafficCategory;
    const entry = totals.get(category) ?? { totalAttempts: 0, succeeded: 0 };
    entry.totalAttempts += row.count;
    if (row.outcome === "allowed") entry.succeeded += row.count;
    totals.set(category, entry);
  }

  return GATEWAY_TRAFFIC_CATEGORIES.map((category) => ({
    category,
    totalAttempts: totals.get(category)?.totalAttempts ?? 0,
    succeeded: totals.get(category)?.succeeded ?? 0,
  }));
}

export type SyncFamily = "change_drafts" | "editorial_profile" | "ai_connections";

const SYNC_FAMILIES: readonly SyncFamily[] = ["change_drafts", "editorial_profile", "ai_connections"];

export type SyncFamilyStatusRow = {
  family: SyncFamily;
  /** `null` means this family has never completed a sync cycle on this device at all --
   * distinct from a cycle that ran and failed (`lastSyncOk: false`, `lastSyncedAt` still set to
   * when that failed attempt finished). */
  lastSyncedAt: Date | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
};

/**
 * Upserts the outcome of one just-finished sync cycle for a family (`docs/roadmap/plans/
 * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4's three families). Called once per family per
 * `POST /api/change-drafts/sync` cycle, regardless of whether that cycle's own per-channel
 * results included a push/merge failure -- `ok`/`error` here reflect whether the family's sync
 * runner completed at all, not whether every individual channel within it succeeded (that
 * detail stays in the cycle's own per-channel `pushError`/`peersSkipped`, already surfaced
 * separately in the Merge tab).
 */
export async function recordSyncFamilyResult(
  family: SyncFamily,
  outcome: { ok: boolean; error: string | null },
  database: AppDb = db
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await database
    .insert(syncFamilyStatus)
    .values({ family, lastSyncedAt: now, lastSyncOk: outcome.ok, lastError: outcome.error, updatedAt: now })
    .onConflictDoUpdate({
      target: syncFamilyStatus.family,
      set: { lastSyncedAt: now, lastSyncOk: outcome.ok, lastError: outcome.error, updatedAt: now },
    });
}

/** Returns one row per known family, always -- a family that has never synced yet still gets an
 * explicit `{lastSyncedAt: null, lastSyncOk: null, lastError: null}` entry rather than being
 * silently absent (mirrors `getGatewayTrafficLast24h`'s own "always all known categories" shape). */
export async function getSyncFamilyStatuses(database: AppDb = db): Promise<SyncFamilyStatusRow[]> {
  const rows = await database.select().from(syncFamilyStatus);
  const byFamily = new Map(rows.map((row) => [row.family as SyncFamily, row]));

  return SYNC_FAMILIES.map((family) => {
    const row = byFamily.get(family);
    return {
      family,
      lastSyncedAt: row?.lastSyncedAt ? new Date(row.lastSyncedAt * 1000) : null,
      lastSyncOk: row?.lastSyncOk ?? null,
      lastError: row?.lastError ?? null,
    };
  });
}

const ANALYTICS_SYNC_LOCAL_TIME_SETTING_KEY = "analytics_sync_local_time";
const ANALYTICS_SYNC_TIMEZONE_SETTING_KEY = "analytics_sync_timezone";
const DEFAULT_ANALYTICS_SYNC_LOCAL_TIME = "12:05";

/**
 * BL-059 (docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-4) -- the daily auto-collection
 * boundary. `timezone` defaults to this machine's own OS timezone (`Intl.DateTimeFormat().
 * resolvedOptions().timeZone`), detected once on first read and persisted immediately, never
 * re-detected on later reads -- so an explicit override the owner later saves in Settings is
 * never silently clobbered by a fresh OS read. This is safe specifically because this app's
 * server and the operator's browser are the same machine (the established "local-first
 * single-operator tool" model, AGENTS.md) -- the OS timezone genuinely is the operator's own.
 */
// Takes an injectable `database` (unlike getLiveWritesEnabled/getMcpConnectionEnabled) so the
// detect-and-persist-once behavior -- the one thing here with real, silently-regressable
// state -- can be exercised against an isolated temp database (docs/DEVELOPMENT_PLAYBOOK.md
// §6.11) rather than asserted only by reasoning.
export async function getAnalyticsSyncSettings(
  database: AppDb = db
): Promise<{ localTime: string; timezone: string }> {
  const localTime =
    (await getAppSetting(ANALYTICS_SYNC_LOCAL_TIME_SETTING_KEY, database)) ?? DEFAULT_ANALYTICS_SYNC_LOCAL_TIME;
  let timezone = await getAppSetting(ANALYTICS_SYNC_TIMEZONE_SETTING_KEY, database);
  if (!timezone) {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await setAppSetting(ANALYTICS_SYNC_TIMEZONE_SETTING_KEY, timezone, database);
  }
  return { localTime, timezone };
}

// Validation (valid HH:MM, valid IANA zone) is the caller's responsibility
// (src/lib/analytics/staleness.ts's isValidLocalTimeOfDay/isValidIanaTimezone) -- this function
// persists whatever it is given, same division of labor as every other setter in this file.
export async function setAnalyticsSyncSettings(
  input: { localTime?: string; timezone?: string },
  database: AppDb = db
): Promise<void> {
  if (input.localTime !== undefined) {
    await setAppSetting(ANALYTICS_SYNC_LOCAL_TIME_SETTING_KEY, input.localTime, database);
  }
  if (input.timezone !== undefined) {
    await setAppSetting(ANALYTICS_SYNC_TIMEZONE_SETTING_KEY, input.timezone, database);
  }
}

export async function upsertVideos(
  entries: Array<{
    videoId: string;
    channelId: string;
    title: string;
    description: string;
    publishedAt: string;
    privacyStatus: string;
    defaultLanguage: string | null;
    defaultAudioLanguage: string | null;
    thumbnails: Record<string, ThumbnailInfo>;
    existingLocalizations: Record<string, LocaleMetadataRecord>;
    etag: string | null;
    viewCount?: number | null;
    commentCount?: number | null;
    likeCount?: number | null;
  }>,
  syncedAt: Date
): Promise<void> {
  for (const entry of entries) {
    const values = {
      id: entry.videoId,
      channelId: entry.channelId,
      title: entry.title,
      description: entry.description,
      publishedAt: entry.publishedAt,
      privacyStatus: entry.privacyStatus,
      defaultLanguage: entry.defaultLanguage,
      defaultAudioLanguage: entry.defaultAudioLanguage,
      thumbnailsJson: JSON.stringify(entry.thumbnails),
      localizationsJson: JSON.stringify(entry.existingLocalizations),
      etag: entry.etag,
      viewCount: entry.viewCount ?? null,
      commentCount: entry.commentCount ?? null,
      likeCount: entry.likeCount ?? null,
      lastSyncedAt: syncedAt,
    };

    await db
      .insert(videos)
      .values(values)
      .onConflictDoUpdate({ target: videos.id, set: values });
  }
}

export async function listStoredVideosByChannel(channelId: string): Promise<StoredVideo[]> {
  const rows = await db
    .select()
    .from(videos)
    .where(eq(videos.channelId, channelId))
    .orderBy(videos.publishedAt);

  return rows.map(mapStoredVideo).reverse();
}

/** `src/lib/video-details/` (2026-09-20) needs a single stored video's current cached fields to
 * merge a live-write's freshly-verified values onto before re-upserting -- `upsertVideos` always
 * replaces every column of the row it's given, so a caller wanting to update only some columns
 * must first read the rest. `null` when the video was never synced locally at all. */
export async function getStoredVideo(channelId: string, videoId: string): Promise<StoredVideo | null> {
  const rows = await db
    .select()
    .from(videos)
    .where(and(eq(videos.channelId, channelId), eq(videos.id, videoId)))
    .limit(1);

  const row = rows[0];
  return row ? mapStoredVideo(row) : null;
}

export type ChangeField = "title" | "description";
export type ChangeType = "add" | "modify" | "unchanged" | "delete";
export type ChangeValidationStatus = "valid" | "invalid";
export type ChangeConflictStatus = "none" | "conflict";
export type ChangeApprovalStatus = "pending" | "approved" | "rejected";
export type ChangeSetStatus = "in_review" | "approved" | "partially_approved" | "rejected";

export type StoredChangeSet = {
  id: string;
  channelId: string;
  source: string;
  status: ChangeSetStatus;
  importedFilename: string | null;
  schemaVersion: string | null;
  exportedAt: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredChange = {
  id: string;
  changeSetId: string;
  videoId: string;
  language: string;
  field: ChangeField;
  baselineValue: string;
  proposedValue: string;
  changeType: ChangeType;
  validationStatus: ChangeValidationStatus;
  validationError: string | null;
  conflictStatus: ChangeConflictStatus;
  approvalStatus: ChangeApprovalStatus;
  approvedValue: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapStoredChangeSet(row: typeof changeSets.$inferSelect): StoredChangeSet {
  return {
    id: row.id,
    channelId: row.channelId,
    source: row.source,
    status: row.status as ChangeSetStatus,
    importedFilename: row.importedFilename,
    schemaVersion: row.schemaVersion,
    exportedAt: row.exportedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapStoredChange(row: typeof changes.$inferSelect): StoredChange {
  return {
    id: row.id,
    changeSetId: row.changeSetId,
    videoId: row.videoId,
    language: row.language,
    field: row.field as ChangeField,
    baselineValue: row.baselineValue,
    proposedValue: row.proposedValue,
    changeType: row.changeType as ChangeType,
    validationStatus: row.validationStatus as ChangeValidationStatus,
    validationError: row.validationError,
    conflictStatus: row.conflictStatus as ChangeConflictStatus,
    approvalStatus: row.approvalStatus as ChangeApprovalStatus,
    approvedValue: row.approvedValue,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createChangeSetWithChanges(input: {
  id: string;
  channelId: string;
  source: string;
  status: ChangeSetStatus;
  importedFilename: string | null;
  schemaVersion: string | null;
  exportedAt: string | null;
  changes: Array<{
    id: string;
    videoId: string;
    language: string;
    field: ChangeField;
    baselineValue: string;
    proposedValue: string;
    changeType: ChangeType;
    validationStatus: ChangeValidationStatus;
    validationError: string | null;
    conflictStatus: ChangeConflictStatus;
  }>;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(changeSets).values({
      id: input.id,
      channelId: input.channelId,
      source: input.source,
      status: input.status,
      importedFilename: input.importedFilename,
      schemaVersion: input.schemaVersion,
      exportedAt: input.exportedAt,
    });

    for (const change of input.changes) {
      await tx.insert(changes).values({
        id: change.id,
        changeSetId: input.id,
        videoId: change.videoId,
        language: change.language,
        field: change.field,
        baselineValue: change.baselineValue,
        proposedValue: change.proposedValue,
        changeType: change.changeType,
        validationStatus: change.validationStatus,
        validationError: change.validationError,
        conflictStatus: change.conflictStatus,
        approvalStatus: "pending",
        approvedValue: null,
      });
    }
  });
}

export async function listStoredChangeSetsByChannel(channelId: string): Promise<StoredChangeSet[]> {
  const rows = await db
    .select()
    .from(changeSets)
    .where(eq(changeSets.channelId, channelId))
    .orderBy(changeSets.createdAt);

  return rows.map(mapStoredChangeSet).reverse();
}

export async function getStoredChangeSet(changeSetId: string): Promise<StoredChangeSet | null> {
  const [row] = await db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
  return row ? mapStoredChangeSet(row) : null;
}

export async function listStoredChangesByChangeSet(changeSetId: string): Promise<StoredChange[]> {
  const rows = await db.select().from(changes).where(eq(changes.changeSetId, changeSetId));
  return rows.map(mapStoredChange);
}

export async function getStoredChangeById(
  changeId: string,
  database: AppDb = db
): Promise<StoredChange | null> {
  const [row] = await database.select().from(changes).where(eq(changes.id, changeId));
  return row ? mapStoredChange(row) : null;
}

/**
 * Full-row upsert (`src/lib/change-drafts/`'s SQL read-projection, AUTOMERGE_MIGRATION_PLAN.md
 * §6 CD2): writes every column and creates the row if it doesn't exist yet -- the Automerge
 * document is the source of truth once this projection is wired in, so a change set/change that
 * originated there (not from an XLSX import) may never have had a SQL row at all. This is the
 * ONLY writer of `changeSets`/`changes` rows after the CD2 cutover -- the old narrow-patch
 * functions this replaced (`updateStoredChangeSetStatus`/`updateStoredChange`/
 * `bulkUpdateStoredChanges`, which assumed the row already existed and only patched a few
 * columns) were deleted in CD7 after an audit confirmed zero remaining callers anywhere in the
 * repository (`AUTOMERGE_MIGRATION_PLAN.md` §6 CD7).
 */
export async function upsertStoredChangeSet(record: StoredChangeSet): Promise<void> {
  await db
    .insert(changeSets)
    .values({
      id: record.id,
      channelId: record.channelId,
      source: record.source,
      status: record.status,
      importedFilename: record.importedFilename,
      schemaVersion: record.schemaVersion,
      exportedAt: record.exportedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    .onConflictDoUpdate({
      target: changeSets.id,
      set: {
        channelId: record.channelId,
        source: record.source,
        status: record.status,
        importedFilename: record.importedFilename,
        schemaVersion: record.schemaVersion,
        exportedAt: record.exportedAt,
        updatedAt: record.updatedAt,
      },
    });
}

export async function upsertStoredChange(record: StoredChange): Promise<void> {
  await db
    .insert(changes)
    .values({
      id: record.id,
      changeSetId: record.changeSetId,
      videoId: record.videoId,
      language: record.language,
      field: record.field,
      baselineValue: record.baselineValue,
      proposedValue: record.proposedValue,
      changeType: record.changeType,
      validationStatus: record.validationStatus,
      validationError: record.validationError,
      conflictStatus: record.conflictStatus,
      approvalStatus: record.approvalStatus,
      approvedValue: record.approvedValue,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    .onConflictDoUpdate({
      target: changes.id,
      set: {
        changeSetId: record.changeSetId,
        videoId: record.videoId,
        language: record.language,
        field: record.field,
        baselineValue: record.baselineValue,
        proposedValue: record.proposedValue,
        changeType: record.changeType,
        validationStatus: record.validationStatus,
        validationError: record.validationError,
        conflictStatus: record.conflictStatus,
        approvalStatus: record.approvalStatus,
        approvedValue: record.approvedValue,
        updatedAt: record.updatedAt,
      },
    });
}

/**
 * RISK-46 (docs/TECHNICAL_DEBT.md): `upsertStoredChangeSet`/`upsertStoredChange` only ever add or
 * update a row -- they never remove one that no longer exists in the Automerge document. In
 * ordinary operation the document's own key set only ever grows (nothing in `change-drafts/`
 * deletes a change set/change), so this was never a gap -- until `discardLocalAndAdoptPeer`
 * (CD5/CD6's divergent-lineage resolution) added the one operation that can genuinely shrink it,
 * by wholesale-replacing the local document with a peer's. Without these, a change set/change
 * that existed only in the discarded document would remain forever in SQL, readable via
 * `listChangeSets`/`getChangeSet` but erroring `not_found` the moment anything tried to act on it
 * (found live -- an operator would see a real, permanently broken phantom row). Called only for
 * the specific ids the discard operation computes as removed, never as a bulk "clear channel"
 * operation.
 */
export async function deleteStoredChangeSet(changeSetId: string): Promise<void> {
  await db.delete(changeSets).where(eq(changeSets.id, changeSetId));
}

export async function deleteStoredChange(changeId: string): Promise<void> {
  await db.delete(changes).where(eq(changes.id, changeId));
}

// ---------------------------------------------------------------------------
// Phase 6 -- Channel Editorial Profiles + generation provenance persistence.
// ---------------------------------------------------------------------------

export type StoredEditorialProfile = {
  channelId: string;
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: Date;
};

function mapStoredEditorialProfile(row: typeof channelEditorialProfiles.$inferSelect): StoredEditorialProfile {
  return {
    channelId: row.channelId,
    version: row.version,
    targetAudience: row.targetAudience,
    toneNotes: row.toneNotes,
    terminologyNotes: row.terminologyNotes,
    titleConstraints: row.titleConstraints,
    descriptionConstraints: row.descriptionConstraints,
    updatedAt: row.updatedAt,
  };
}

export async function getStoredEditorialProfile(channelId: string): Promise<StoredEditorialProfile | null> {
  const [row] = await db.select().from(channelEditorialProfiles).where(eq(channelEditorialProfiles.channelId, channelId));
  return row ? mapStoredEditorialProfile(row) : null;
}

/**
 * Raw overwrite upsert -- writes exactly the row it is given, no `version` computation or
 * `undefined`-vs-`null` merge semantics of its own. Used only as the SQL read-projection target
 * for `src/lib/sync-gateway/editorial-profile/` (2026-09-22, `docs/roadmap/plans/
 * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M3) -- that module's Automerge document is now the
 * source of truth for versioning, mirroring `upsertStoredChangeSet`/`upsertStoredChange`'s
 * identical raw-overwrite shape for the draft layer. The old direct-SQL
 * `upsertStoredEditorialProfile`, which computed `version` itself, was deleted the same day once
 * its only caller was repointed at that module -- confirmed zero remaining callers anywhere in
 * `src/`, mirroring CD7's identical dead-code check for `createChangeSetStoreAdapter`.
 */
export async function setStoredEditorialProfileRow(record: StoredEditorialProfile): Promise<void> {
  await db
    .insert(channelEditorialProfiles)
    .values({
      channelId: record.channelId,
      version: record.version,
      targetAudience: record.targetAudience,
      toneNotes: record.toneNotes,
      terminologyNotes: record.terminologyNotes,
      titleConstraints: record.titleConstraints,
      descriptionConstraints: record.descriptionConstraints,
      updatedAt: record.updatedAt,
    })
    .onConflictDoUpdate({
      target: channelEditorialProfiles.channelId,
      set: {
        version: record.version,
        targetAudience: record.targetAudience,
        toneNotes: record.toneNotes,
        terminologyNotes: record.terminologyNotes,
        titleConstraints: record.titleConstraints,
        descriptionConstraints: record.descriptionConstraints,
        updatedAt: record.updatedAt,
      },
    });
}

export type StoredGenerationProvenance = {
  id: string;
  changeSetId: string;
  channelId: string;
  profileVersion: number | null;
  effectiveContextJson: string | null;
  createdAt: Date;
  evidenceJson: string | null;
  rationale: string | null;
  createdVia: string | null;
  agentApiVersion: string | null;
};

function mapStoredGenerationProvenance(
  row: typeof aiLocalizationGenerationProvenance.$inferSelect
): StoredGenerationProvenance {
  return {
    id: row.id,
    changeSetId: row.changeSetId,
    channelId: row.channelId,
    profileVersion: row.profileVersion,
    effectiveContextJson: row.effectiveContextJson,
    createdAt: row.createdAt,
    evidenceJson: row.evidenceJson,
    rationale: row.rationale,
    createdVia: row.createdVia,
    agentApiVersion: row.agentApiVersion,
  };
}

export async function getGenerationProvenanceByChangeSetId(
  changeSetId: string
): Promise<StoredGenerationProvenance | null> {
  const [row] = await db
    .select()
    .from(aiLocalizationGenerationProvenance)
    .where(eq(aiLocalizationGenerationProvenance.changeSetId, changeSetId));
  return row ? mapStoredGenerationProvenance(row) : null;
}

/**
 * Write-once-in-spirit upsert -- the CRDT document (`src/lib/sync-gateway/change-drafts/`) is the
 * real source of truth for provenance and never changes an entry's *content* after creation, but
 * this SQL projection itself must still be updateable: `projectToSql` re-projects the WHOLE
 * document (including every provenance entry) on every local save AND every remote merge, so a
 * stale or partially-written SQL row for a given `id` -- e.g. one inserted by an older app
 * version whose schema/entry shape predated Phase 7 slice F's evidence/rationale/createdVia/
 * agentApiVersion columns -- must be correctable by a LATER re-projection that writes the CRDT
 * entry's actual current values. `onConflictDoNothing()` would silently skip every later
 * re-projection attempt for that same `id` once a row already existed, permanently freezing it;
 * `onConflictDoUpdate` fixes this: re-writing a row on every re-projection is a safe no-op when
 * nothing actually changed, and a real correction whenever it did.
 * Used only as the SQL read-projection target for `src/lib/sync-gateway/change-drafts/`
 * (2026-09-22, `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M4) -- the old
 * direct-SQL `createGenerationProvenance` was deleted the same day once its only caller was
 * repointed at that module.
 */
export async function setStoredGenerationProvenanceRow(input: {
  id: string;
  changeSetId: string;
  channelId: string;
  profileVersion: number | null;
  effectiveContextJson: string | null;
  createdAt: Date;
  evidenceJson: string | null;
  rationale: string | null;
  createdVia: string | null;
  agentApiVersion: string | null;
}): Promise<void> {
  await db
    .insert(aiLocalizationGenerationProvenance)
    .values(input)
    .onConflictDoUpdate({
      target: aiLocalizationGenerationProvenance.id,
      set: {
        changeSetId: input.changeSetId,
        channelId: input.channelId,
        profileVersion: input.profileVersion,
        effectiveContextJson: input.effectiveContextJson,
        createdAt: input.createdAt,
        evidenceJson: input.evidenceJson,
        rationale: input.rationale,
        createdVia: input.createdVia,
        agentApiVersion: input.agentApiVersion,
      },
    });
}

/**
 * `ai_localization_generation_provenance.change_set_id` is `NOT NULL UNIQUE REFERENCES
 * change_sets(id)` with no `ON DELETE` clause, and this connection runs with `foreign_keys=ON`
 * (see `src/lib/snapshot/adapters/scrub.ts` for another call site that has to work around the
 * same default). `deleteStoredChangeSet` above has no FK-aware fallback, so any caller that might
 * delete a change set with a provenance row must delete this row first -- found live via
 * `src/lib/sync-gateway/change-drafts/services.ts`'s `discardLocalAndAdoptPeer`, which discards a
 * whole document (including any provenance entries it holds) and previously had no equivalent
 * cleanup for provenance at all.
 */
export async function deleteStoredGenerationProvenanceForChangeSet(changeSetId: string): Promise<void> {
  await db.delete(aiLocalizationGenerationProvenance).where(eq(aiLocalizationGenerationProvenance.changeSetId, changeSetId));
}

// ---------------------------------------------------------------------------
// Phase 6 -- AI Connections persistence. This file never encrypts/decrypts anything
// itself (src/lib/ai-connections/crypto.ts owns that) -- it only stores/retrieves
// whatever ciphertext/iv/authTag it is given, in a table separate from the
// connection's own row, so a plain listing of connections can never include one.
// ---------------------------------------------------------------------------

export type StoredAiConnection = {
  id: string;
  displayName: string;
  adapterType: string;
  baseUrl: string | null;
  modelId: string;
  localInferenceMode: boolean;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  statusCheckedAt: Date | null;
  capabilitiesJson: string;
  assignedTasksJson: string;
  pricingJson: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapStoredAiConnection(row: typeof aiConnections.$inferSelect): StoredAiConnection {
  return {
    id: row.id,
    displayName: row.displayName,
    adapterType: row.adapterType,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    localInferenceMode: row.localInferenceMode,
    enabled: row.enabled,
    status: row.status,
    statusMessage: row.statusMessage,
    statusCheckedAt: row.statusCheckedAt,
    capabilitiesJson: row.capabilitiesJson,
    assignedTasksJson: row.assignedTasksJson,
    pricingJson: row.pricingJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listStoredAiConnections(): Promise<StoredAiConnection[]> {
  const rows = await db.select().from(aiConnections).orderBy(desc(aiConnections.createdAt));
  return rows.map(mapStoredAiConnection);
}

export async function getStoredAiConnection(connectionId: string): Promise<StoredAiConnection | null> {
  const [row] = await db.select().from(aiConnections).where(eq(aiConnections.id, connectionId));
  return row ? mapStoredAiConnection(row) : null;
}

export async function deleteStoredAiConnection(connectionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(aiConnectionCredentials).where(eq(aiConnectionCredentials.connectionId, connectionId));
    await tx.delete(aiConnections).where(eq(aiConnections.id, connectionId));
  });
}

/**
 * Raw overwrite upsert -- writes exactly the row it is given, no defaulting or patch-merge logic
 * of its own. Used only as the SQL read-projection target for
 * `src/lib/sync-gateway/ai-connections-catalog/` (2026-09-22, `docs/roadmap/plans/
 * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M3) -- that module's single global Automerge document
 * is now the source of truth for every connection's non-secret config; `deleteStoredAiConnection`
 * above (unchanged) remains the target for a connection removed from the document entirely.
 */
export async function setStoredAiConnectionRow(record: StoredAiConnection): Promise<void> {
  await db
    .insert(aiConnections)
    .values({
      id: record.id,
      displayName: record.displayName,
      adapterType: record.adapterType,
      baseUrl: record.baseUrl,
      modelId: record.modelId,
      localInferenceMode: record.localInferenceMode,
      enabled: record.enabled,
      status: record.status,
      statusMessage: record.statusMessage,
      statusCheckedAt: record.statusCheckedAt,
      capabilitiesJson: record.capabilitiesJson,
      assignedTasksJson: record.assignedTasksJson,
      pricingJson: record.pricingJson,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    .onConflictDoUpdate({
      target: aiConnections.id,
      set: {
        displayName: record.displayName,
        adapterType: record.adapterType,
        baseUrl: record.baseUrl,
        modelId: record.modelId,
        localInferenceMode: record.localInferenceMode,
        enabled: record.enabled,
        status: record.status,
        statusMessage: record.statusMessage,
        statusCheckedAt: record.statusCheckedAt,
        capabilitiesJson: record.capabilitiesJson,
        assignedTasksJson: record.assignedTasksJson,
        pricingJson: record.pricingJson,
        updatedAt: record.updatedAt,
      },
    });
}

export type StoredAiConnectionCredential = {
  connectionId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
};

export async function upsertStoredAiConnectionCredential(input: StoredAiConnectionCredential): Promise<void> {
  const existing = await getStoredAiConnectionCredential(input.connectionId);
  const now = new Date();
  if (existing) {
    await db
      .update(aiConnectionCredentials)
      .set({ ciphertext: input.ciphertext, iv: input.iv, authTag: input.authTag, updatedAt: now })
      .where(eq(aiConnectionCredentials.connectionId, input.connectionId));
  } else {
    await db.insert(aiConnectionCredentials).values({ ...input, createdAt: now, updatedAt: now });
  }
}

export async function getStoredAiConnectionCredential(connectionId: string): Promise<StoredAiConnectionCredential | null> {
  const [row] = await db
    .select()
    .from(aiConnectionCredentials)
    .where(eq(aiConnectionCredentials.connectionId, connectionId));
  return row ? { connectionId: row.connectionId, ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag } : null;
}

export async function deleteStoredAiConnectionCredential(connectionId: string): Promise<void> {
  await db.delete(aiConnectionCredentials).where(eq(aiConnectionCredentials.connectionId, connectionId));
}

// ---------------------------------------------------------------------------
// Phase 5, Slice 1 (foundation) -- Batch / per-video ledger / attempt persistence.
// See docs/acceptance/PHASE_5_ACCEPTANCE.md and src/lib/batches/contracts.ts for the
// domain-level meaning of these states; this file only persists them.
// ---------------------------------------------------------------------------

export type BatchStatus = "PENDING" | "RUNNING" | "COMPLETED" | "ABORTED";
// RISK-10 fix (2026-09-18): LedgerStatus/AttemptPhase/AttemptOutcome used to be a
// hand-maintained copy here, which silently fell out of sync with
// src/lib/batches/contracts.ts's definitions (see docs/TECHNICAL_DEBT.md RISK-10 for the
// incident). Both files now import from the single canonical, import-free
// src/lib/batches/ledger-state.ts instead -- this file (the domain-agnostic persistence
// layer) imports only that leaf types module, never the batches domain's own
// contracts.ts, preserving the existing pattern of db.ts depending on no domain module.
export type { LedgerStatus, AttemptPhase, AttemptOutcome };

export type StoredBatch = {
  id: string;
  channelId: string;
  status: BatchStatus;
  concurrency: number;
  dryRun: boolean;
  runId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type StoredLedgerRow = {
  id: string;
  batchId: string;
  videoId: string;
  changeIds: string[];
  status: LedgerStatus;
  error: string | null;
  verificationResult: unknown | null;
  activeAttemptId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredAttempt = {
  id: string;
  ledgerRowId: string;
  attemptNumber: number;
  phase: AttemptPhase;
  payloadSnapshot: unknown;
  requestedAt: Date;
  outcome: AttemptOutcome | null;
  outcomeDetail: string | null;
  resultAt: Date | null;
};

function mapStoredBatch(row: typeof batches.$inferSelect): StoredBatch {
  return {
    id: row.id,
    channelId: row.channelId,
    status: row.status as BatchStatus,
    concurrency: row.concurrency,
    dryRun: row.dryRun,
    runId: row.runId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function mapStoredLedgerRow(row: typeof batchLedgerRows.$inferSelect): StoredLedgerRow {
  return {
    id: row.id,
    batchId: row.batchId,
    videoId: row.videoId,
    changeIds: JSON.parse(row.changeIdsJson) as string[],
    status: row.status as LedgerStatus,
    error: row.error,
    verificationResult: row.verificationResultJson ? JSON.parse(row.verificationResultJson) : null,
    activeAttemptId: row.activeAttemptId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapStoredAttempt(row: typeof batchAttempts.$inferSelect): StoredAttempt {
  return {
    id: row.id,
    ledgerRowId: row.ledgerRowId,
    attemptNumber: row.attemptNumber,
    phase: row.phase as AttemptPhase,
    payloadSnapshot: JSON.parse(row.payloadSnapshotJson) as unknown,
    requestedAt: row.requestedAt,
    outcome: row.outcome as AttemptOutcome | null,
    outcomeDetail: row.outcomeDetail,
    resultAt: row.resultAt,
  };
}

/**
 * Creates the batch row and every one of its per-video ledger rows in a single
 * transaction. Membership (which videoId/changeIds pairs exist) is fixed here and is
 * never mutated afterward by any other function in this file -- AC-BATCH-01/AC-BATCH-02.
 */
export async function createBatchWithLedger(
  input: {
    id: string;
    channelId: string;
    concurrency: number;
    dryRun: boolean;
    ledgerRows: Array<{ id: string; videoId: string; changeIds: string[] }>;
  },
  database: AppDb = db
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(batches).values({
      id: input.id,
      channelId: input.channelId,
      status: "PENDING",
      concurrency: input.concurrency,
      dryRun: input.dryRun,
    });

    for (const row of input.ledgerRows) {
      await tx.insert(batchLedgerRows).values({
        id: row.id,
        batchId: input.id,
        videoId: row.videoId,
        changeIdsJson: JSON.stringify(row.changeIds),
        status: "PENDING",
      });
    }
  });
}

export async function getStoredBatch(
  batchId: string,
  database: AppDb = db
): Promise<StoredBatch | null> {
  const [row] = await database.select().from(batches).where(eq(batches.id, batchId));
  return row ? mapStoredBatch(row) : null;
}

/** Newest first -- the natural order for a "your batches" list. */
export async function listStoredBatchesByChannel(
  channelId: string,
  database: AppDb = db
): Promise<StoredBatch[]> {
  const rows = await database
    .select()
    .from(batches)
    .where(eq(batches.channelId, channelId))
    .orderBy(desc(batches.createdAt));
  return rows.map(mapStoredBatch);
}

export async function listStoredLedgerRowsByBatch(
  batchId: string,
  database: AppDb = db
): Promise<StoredLedgerRow[]> {
  const rows = await database.select().from(batchLedgerRows).where(eq(batchLedgerRows.batchId, batchId));
  return rows.map(mapStoredLedgerRow);
}

export async function getStoredLedgerRow(
  ledgerRowId: string,
  database: AppDb = db
): Promise<StoredLedgerRow | null> {
  const [row] = await database.select().from(batchLedgerRows).where(eq(batchLedgerRows.id, ledgerRowId));
  return row ? mapStoredLedgerRow(row) : null;
}

/**
 * Atomic compare-and-set claim: succeeds only if the batch is currently PENDING.
 * Prevents the same batch from being executed twice concurrently (AC-CONCURRENCY-02/03).
 */
export async function claimBatchExecution(
  batchId: string,
  runId: string,
  database: AppDb = db
): Promise<boolean> {
  const result = await database
    .update(batches)
    .set({ status: "RUNNING", runId, startedAt: new Date() })
    .where(and(eq(batches.id, batchId), eq(batches.status, "PENDING")))
    .returning({ id: batches.id });

  return result.length > 0;
}

export async function markBatchTerminal(
  batchId: string,
  status: Extract<BatchStatus, "COMPLETED" | "ABORTED">,
  database: AppDb = db
): Promise<void> {
  await database
    .update(batches)
    .set({ status, completedAt: new Date() })
    .where(eq(batches.id, batchId));
}

/**
 * Atomic exclusive lock on a video across all batches, via the PRIMARY KEY on video_id:
 * only one INSERT can ever succeed for a given videoId at a time (AC-CONCURRENCY-01).
 *
 * Idempotent for the SAME owner (batchId + ledgerRowId): if that exact pair already holds
 * the lock, re-acquiring it succeeds as a no-op rather than reporting a conflict. This
 * does not weaken exclusivity against any OTHER batch/ledger row -- it only allows a
 * batch to safely re-request a lock it already holds, which matters for a future crash-
 * recovery/resume flow (Slice 3): a process that crashed after acquiring this lock but
 * before finishing its work must be able to resume ownership without first having to
 * explicitly detect and special-case "is this actually still mine?" at every call site.
 */
export async function acquireVideoExecutionLock(
  input: {
    videoId: string;
    batchId: string;
    ledgerRowId: string;
  },
  database: AppDb = db
): Promise<boolean> {
  const result = await database
    .insert(videoExecutionLocks)
    .values({ videoId: input.videoId, batchId: input.batchId, ledgerRowId: input.ledgerRowId })
    .onConflictDoNothing({ target: videoExecutionLocks.videoId })
    .returning({ videoId: videoExecutionLocks.videoId });

  if (result.length > 0) return true;

  const [existing] = await database
    .select()
    .from(videoExecutionLocks)
    .where(eq(videoExecutionLocks.videoId, input.videoId));

  return existing?.batchId === input.batchId && existing?.ledgerRowId === input.ledgerRowId;
}

export async function getVideoExecutionLockHolder(
  videoId: string,
  database: AppDb = db
): Promise<{ batchId: string; ledgerRowId: string; lockedAt: Date } | null> {
  const [row] = await database
    .select()
    .from(videoExecutionLocks)
    .where(eq(videoExecutionLocks.videoId, videoId));

  return row ? { batchId: row.batchId, ledgerRowId: row.ledgerRowId, lockedAt: row.lockedAt } : null;
}

/** Only the batch that holds the lock may release it. */
export async function releaseVideoExecutionLock(
  input: {
    videoId: string;
    batchId: string;
  },
  database: AppDb = db
): Promise<void> {
  await database
    .delete(videoExecutionLocks)
    .where(
      and(
        eq(videoExecutionLocks.videoId, input.videoId),
        eq(videoExecutionLocks.batchId, input.batchId)
      )
    );
}

/**
 * Guarded state transition: succeeds only if the ledger row's current status is one of
 * `from`. This is the single enforcement point for the ledger state machine -- no caller
 * updates `batch_ledger_rows.status` any other way, so an illegal transition can never
 * be written even under concurrent callers (the WHERE clause is evaluated atomically by
 * SQLite alongside the UPDATE).
 */
export async function transitionLedgerRowStatus(
  input: {
    ledgerRowId: string;
    from: LedgerStatus[];
    to: LedgerStatus;
    error?: string | null;
    verificationResult?: unknown;
  },
  database: AppDb = db
): Promise<boolean> {
  const patch: Partial<typeof batchLedgerRows.$inferInsert> = {
    status: input.to,
    updatedAt: new Date(),
  };
  if (input.error !== undefined) patch.error = input.error;
  if (input.verificationResult !== undefined) {
    patch.verificationResultJson = JSON.stringify(input.verificationResult);
  }

  const result = await database
    .update(batchLedgerRows)
    .set(patch)
    .where(
      and(
        eq(batchLedgerRows.id, input.ledgerRowId),
        inArray(batchLedgerRows.status, input.from)
      )
    )
    .returning({ id: batchLedgerRows.id });

  return result.length > 0;
}

/**
 * Claims the ledger row's single "active attempt" slot, THEN inserts the durable
 * INTENDED attempt record as a second statement. This is the enforcement point for the
 * invariant "at most one active (unresolved) attempt per ledger row at any time" -- it
 * does NOT rely on the UNIQUE(ledger_row_id, attempt_number) constraint to detect a race
 * after the fact (two concurrent callers could otherwise compute two different attempt
 * numbers from a stale count-based read and both insert successfully). Instead:
 *
 *   1. `UPDATE batch_ledger_rows SET active_attempt_id = :id WHERE id = :ledgerRowId AND
 *      active_attempt_id IS NULL RETURNING id` -- a guarded compare-and-set, atomic at
 *      the SQLite level (same idiom already proven correct for claimBatchExecution/
 *      acquireVideoExecutionLock). If this affects zero rows, another attempt is already
 *      active (or was claimed a moment earlier by a concurrent caller): return false
 *      immediately, no attempt row is ever inserted, so attemptNumber collisions cannot
 *      occur even under a true race.
 *   2. Only if step 1 succeeds does the INTENDED attempt row get inserted.
 *
 * These two statements are deliberately NOT wrapped in an explicit multi-statement
 * `database.transaction(...)` block, even though that would be the more obviously
 * "atomic-looking" choice: empirically, in this environment, the native libSQL binding's
 * explicit-transaction API serializes across separate client connections to the same
 * file far more aggressively than a bare guarded UPDATE/INSERT does (observed as one
 * connection's `transaction()` call itself blocking for the full busy_timeout budget
 * while a second connection's competing `transaction()` call failed immediately with
 * SQLITE_BUSY, even with WAL mode and a 5s busy_timeout both configured) -- the single-
 * statement idiom used everywhere else in this file (claimBatchExecution,
 * acquireVideoExecutionLock) does not exhibit this and was kept instead.
 *
 * Residual crash window (accepted, not a safety gap): if the process crashes strictly
 * between step 1 committing and step 2 committing, `batch_ledger_rows.active_attempt_id`
 * points at an attempt id with no corresponding `batch_attempts` row. This is a narrow,
 * self-evidently-detectable inconsistency (a future recovery pass can simply check
 * whether `active_attempt_id` resolves to an existing attempt row, and clear it back to
 * NULL if not, before treating the ledger row as safe to retry) -- it can never cause a
 * duplicate write or a lost exclusivity guarantee, only, at worst, a ledger row that
 * needs one extra reconciliation step to recognize "nothing was ever actually sent."
 *
 * The caller must have already computed `attemptNumber` (e.g. from a prior count of this
 * ledger row's attempts) -- doing so is safe here specifically because only the winner of
 * step 1 ever proceeds to actually insert, so a losing caller's (possibly stale) computed
 * number is simply discarded, never written.
 */
export async function beginAttemptIntent(
  input: {
    id: string;
    ledgerRowId: string;
    attemptNumber: number;
    payloadSnapshot: unknown;
  },
  database: AppDb = db
): Promise<boolean> {
  const claim = await database
    .update(batchLedgerRows)
    .set({ activeAttemptId: input.id, updatedAt: new Date() })
    .where(and(eq(batchLedgerRows.id, input.ledgerRowId), isNull(batchLedgerRows.activeAttemptId)))
    .returning({ id: batchLedgerRows.id });

  if (claim.length === 0) return false;

  await database.insert(batchAttempts).values({
    id: input.id,
    ledgerRowId: input.ledgerRowId,
    attemptNumber: input.attemptNumber,
    phase: "INTENDED",
    payloadSnapshotJson: JSON.stringify(input.payloadSnapshot),
  });

  return true;
}

/**
 * Guarded: can only move an attempt from INTENDED to RESULT_RECORDED once, then frees the
 * ledger row's active-attempt slot (only if it still points at this exact attempt, which
 * it always should given the invariant above; the extra check is defense in depth, not
 * load-bearing). This is what makes a *new* attempt possible afterward, whatever the
 * recorded outcome (including UNKNOWN): a resolved slot always becomes claimable again
 * via beginAttemptIntent. As in beginAttemptIntent above, this is deliberately two
 * sequential guarded statements, not an explicit `database.transaction(...)` block -- see
 * that function's comment for why. The residual crash window here (process dies strictly
 * between the two statements, leaving the attempt RESULT_RECORDED but the slot still
 * occupied) is equally narrow and equally self-recoverable: a future recovery pass can
 * detect "active_attempt_id points at an already-resolved attempt" and clear it.
 */
export async function recordAttemptResult(
  input: {
    attemptId: string;
    outcome: AttemptOutcome;
    outcomeDetail: string | null;
  },
  database: AppDb = db
): Promise<boolean> {
  const resolved = await database
    .update(batchAttempts)
    .set({
      phase: "RESULT_RECORDED",
      outcome: input.outcome,
      outcomeDetail: input.outcomeDetail,
      resultAt: new Date(),
    })
    .where(and(eq(batchAttempts.id, input.attemptId), eq(batchAttempts.phase, "INTENDED")))
    .returning({ id: batchAttempts.id, ledgerRowId: batchAttempts.ledgerRowId });

  if (resolved.length === 0) return false;

  await database
    .update(batchLedgerRows)
    .set({ activeAttemptId: null, updatedAt: new Date() })
    .where(
      and(
        eq(batchLedgerRows.id, resolved[0].ledgerRowId),
        eq(batchLedgerRows.activeAttemptId, input.attemptId)
      )
    );

  return true;
}

export async function getStoredAttempt(
  attemptId: string,
  database: AppDb = db
): Promise<StoredAttempt | null> {
  const [row] = await database.select().from(batchAttempts).where(eq(batchAttempts.id, attemptId));
  return row ? mapStoredAttempt(row) : null;
}

export async function listStoredAttemptsByLedgerRow(
  ledgerRowId: string,
  database: AppDb = db
): Promise<StoredAttempt[]> {
  const rows = await database
    .select()
    .from(batchAttempts)
    .where(eq(batchAttempts.ledgerRowId, ledgerRowId))
    .orderBy(batchAttempts.attemptNumber);

  return rows.map(mapStoredAttempt);
}

export async function listStoredAttemptsByBatch(
  batchId: string,
  database: AppDb = db
): Promise<StoredAttempt[]> {
  const ledgerRows = await database
    .select({ id: batchLedgerRows.id })
    .from(batchLedgerRows)
    .where(eq(batchLedgerRows.batchId, batchId));

  if (ledgerRows.length === 0) return [];

  const rows = await database
    .select()
    .from(batchAttempts)
    .where(
      inArray(
        batchAttempts.ledgerRowId,
        ledgerRows.map((row) => row.id)
      )
    );

  return rows.map(mapStoredAttempt);
}

// ---------------------------------------------------------------------------
// Phase 5, Slice 3 -- durable audit trail (AC-AUDIT-01..05).
// ---------------------------------------------------------------------------

export type AuditEventType =
  | "PREPARATION"
  | "ATTEMPT"
  | "RESULT"
  | "CONFLICT"
  | "VERIFICATION"
  | "DRY_RUN"
  | "RECONCILIATION";

export type StoredAuditEvent = {
  id: number;
  batchId: string;
  ledgerRowId: string;
  videoId: string;
  eventType: AuditEventType;
  detail: unknown;
  occurredAt: Date;
};

function mapStoredAuditEvent(row: typeof auditEvents.$inferSelect): StoredAuditEvent {
  return {
    id: row.id,
    batchId: row.batchId,
    ledgerRowId: row.ledgerRowId,
    videoId: row.videoId,
    eventType: row.eventType as AuditEventType,
    detail: JSON.parse(row.detailJson) as unknown,
    occurredAt: row.occurredAt,
  };
}

/** Never updated or deleted -- an audit trail is append-only by construction. */
export async function insertAuditEvent(
  input: {
    batchId: string;
    ledgerRowId: string;
    videoId: string;
    eventType: AuditEventType;
    detail: unknown;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(auditEvents).values({
    batchId: input.batchId,
    ledgerRowId: input.ledgerRowId,
    videoId: input.videoId,
    eventType: input.eventType,
    detailJson: JSON.stringify(input.detail),
  });
}

/** Ordered by `id` (rowid-backed autoincrement) -- see the table comment for why this,
 * not `occurred_at`, is the authoritative ordering (AC-AUDIT-01/04). */
export async function listAuditEventsByLedgerRow(
  ledgerRowId: string,
  database: AppDb = db
): Promise<StoredAuditEvent[]> {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.ledgerRowId, ledgerRowId))
    .orderBy(auditEvents.id);

  return rows.map(mapStoredAuditEvent);
}

export async function listAuditEventsByBatch(
  batchId: string,
  database: AppDb = db
): Promise<StoredAuditEvent[]> {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.batchId, batchId))
    .orderBy(auditEvents.id);

  return rows.map(mapStoredAuditEvent);
}

// video_edit_audit_events -- src/lib/video-details/'s own trail, see the table comment above
// (near videoEditAuditEvents' definition) for why this is a second, separate table.
export type VideoEditAuditEventType = "DRY_RUN" | "BACKUP" | "RESULT" | "VERIFICATION";

export type StoredVideoEditAuditEvent = {
  id: number;
  channelId: string;
  videoId: string;
  eventType: VideoEditAuditEventType;
  detail: unknown;
  occurredAt: Date;
};

function mapStoredVideoEditAuditEvent(
  row: typeof videoEditAuditEvents.$inferSelect
): StoredVideoEditAuditEvent {
  return {
    id: row.id,
    channelId: row.channelId,
    videoId: row.videoId,
    eventType: row.eventType as VideoEditAuditEventType,
    detail: JSON.parse(row.detailJson) as unknown,
    occurredAt: row.occurredAt,
  };
}

export async function insertVideoEditAuditEvent(
  input: {
    channelId: string;
    videoId: string;
    eventType: VideoEditAuditEventType;
    detail: unknown;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(videoEditAuditEvents).values({
    channelId: input.channelId,
    videoId: input.videoId,
    eventType: input.eventType,
    detailJson: JSON.stringify(input.detail),
  });
}

export async function listVideoEditAuditEventsByVideo(
  videoId: string,
  database: AppDb = db
): Promise<StoredVideoEditAuditEvent[]> {
  const rows = await database
    .select()
    .from(videoEditAuditEvents)
    .where(eq(videoEditAuditEvents.videoId, videoId))
    .orderBy(videoEditAuditEvents.id);

  return rows.map(mapStoredVideoEditAuditEvent);
}

// video_metrics_daily -- see the table's own comment above (near videoMetricsDaily's
// definition) for the schema rationale (docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 2).
export type StoredVideoMetric = {
  channelId: string;
  videoId: string;
  metricDate: string;
  metricName: string;
  metricValue: number;
  collectedAt: Date;
};

function mapStoredVideoMetric(row: typeof videoMetricsDaily.$inferSelect): StoredVideoMetric {
  return {
    channelId: row.channelId,
    videoId: row.videoId,
    metricDate: row.metricDate,
    metricName: row.metricName,
    metricValue: row.metricValue,
    collectedAt: row.collectedAt,
  };
}

// Upsert by the table's own primary key (videoId, metricDate, metricName) -- re-collecting an
// already-collected date is idempotent (the existing row's channelId/metricValue/collectedAt are
// all overwritten with the new collection's result), never a duplicate row. `collectedAt` is
// deliberately "when this row's CURRENT value was collected" (last-write time), not "when this
// metric-day was first captured" -- there is no separate first-seen timestamp on this table, by
// design, since nothing in docs/roadmap/plans/PHASE_8_PLAN.md needs one; if a future slice needs
// first-seen tracking, that is an additive column, not a change to this function. See
// docs/roadmap/plans/PHASE_8_PLAN.md §7's explicit acceptance criterion for the idempotency itself.
//
// `channelId` is trusted as given, NOT cross-checked against `videoId`'s actual `videos.channelId`
// -- this function has no channel-scoping enforcement of its own (AGENTS.md §F: "a route or
// service taking a channelId must itself verify the requested resource belongs to that channel").
// Harmless today (only tests call this, with hardcoded consistent values); slice 3's Analytics
// adapter must derive channelId from the video's own FK-verified row, never accept it as a second,
// independent caller-supplied parameter, or a channel-scoped metrics view could show/hide the
// wrong video's data.
export async function upsertVideoMetric(
  input: {
    channelId: string;
    videoId: string;
    metricDate: string;
    metricName: string;
    metricValue: number;
  },
  database: AppDb = db
): Promise<void> {
  const collectedAt = new Date();
  await database
    .insert(videoMetricsDaily)
    .values({ ...input, collectedAt })
    .onConflictDoUpdate({
      target: [videoMetricsDaily.videoId, videoMetricsDaily.metricDate, videoMetricsDaily.metricName],
      set: { channelId: input.channelId, metricValue: input.metricValue, collectedAt },
    });
}

export async function listVideoMetricsByVideo(
  videoId: string,
  database: AppDb = db
): Promise<StoredVideoMetric[]> {
  const rows = await database
    .select()
    .from(videoMetricsDaily)
    .where(eq(videoMetricsDaily.videoId, videoId))
    .orderBy(videoMetricsDaily.metricDate, videoMetricsDaily.metricName);

  return rows.map(mapStoredVideoMetric);
}

// BL-058 (docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 4) -- the Web UI's read-only display needs
// every metric row for a channel at once, not one video at a time.
export async function listVideoMetricsByChannel(
  channelId: string,
  database: AppDb = db
): Promise<StoredVideoMetric[]> {
  const rows = await database
    .select()
    .from(videoMetricsDaily)
    .where(eq(videoMetricsDaily.channelId, channelId))
    .orderBy(videoMetricsDaily.videoId, videoMetricsDaily.metricDate, videoMetricsDaily.metricName);

  return rows.map(mapStoredVideoMetric);
}

export type StoredAnalyticsCollectionRun = {
  id: number;
  channelId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  videoCount: number;
  upsertsIssued: number;
  skippedVideoIds: string[];
  ranAt: Date;
};

/**
 * Appends one row per `collectMetrics` run -- never updated, never deleted (the same append-only
 * discipline `gateway_call_events` uses, minus that table's own retention window, since a
 * collection-run history is small by construction: at most a few rows per channel per day).
 * `skippedVideoIds` is JSON-encoded since SQLite has no native array column and this table is
 * never queried by individual skipped video (see `getDataQualityReport` in
 * `src/lib/analytics/services.ts`, which decodes it after reading every run for a channel).
 */
export async function recordAnalyticsCollectionRun(
  input: {
    channelId: string;
    requestedStartDate: string;
    requestedEndDate: string;
    videoCount: number;
    upsertsIssued: number;
    skippedVideoIds: string[];
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(analyticsCollectionRuns).values({
    channelId: input.channelId,
    requestedStartDate: input.requestedStartDate,
    requestedEndDate: input.requestedEndDate,
    videoCount: input.videoCount,
    upsertsIssued: input.upsertsIssued,
    skippedVideoIdsJson: JSON.stringify(input.skippedVideoIds),
  });
}

export async function listAnalyticsCollectionRunsByChannel(
  channelId: string,
  database: AppDb = db
): Promise<StoredAnalyticsCollectionRun[]> {
  const rows = await database
    .select()
    .from(analyticsCollectionRuns)
    .where(eq(analyticsCollectionRuns.channelId, channelId))
    .orderBy(analyticsCollectionRuns.ranAt);

  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    requestedStartDate: row.requestedStartDate,
    requestedEndDate: row.requestedEndDate,
    videoCount: row.videoCount,
    upsertsIssued: row.upsertsIssued,
    // A row this app itself wrote should always have valid JSON -- if it somehow doesn't
    // (external tampering, disk corruption), treat it as "no skips recorded" rather than
    // crashing the whole diagnostics report over one malformed history row.
    skippedVideoIds: (() => {
      try {
        const parsed = JSON.parse(row.skippedVideoIdsJson);
        return Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        return [];
      }
    })(),
    ranAt: row.ranAt,
  }));
}

export type StoredWeeklyReport = {
  id: number;
  channelId: string;
  weekStartDate: string;
  weekEndDate: string;
  status: string;
  reportJson: string;
  generatedAt: Date;
};

/**
 * Phase 8 follow-up, slice 4. `runWeeklyReportIfDue` (`src/lib/analytics/services.ts`) already
 * reads the existing row first and only calls this function when there either isn't one yet or
 * the existing one is still "provisional" -- but that check-then-act is NOT itself atomic across
 * two concurrent callers (e.g. two open dashboard tabs both triggering `generate-if-due` near the
 * same moment), so this function ALSO enforces "never overwrite an existing 'final' row" at the
 * DB layer via `setWhere` -- SQLite's `ON CONFLICT ... DO UPDATE SET ... WHERE <cond>` applies the
 * update only when `<cond>` is true; otherwise the conflicting insert is silently a no-op and the
 * existing row is left untouched. This closes the real race an independent review found
 * (2026-09-23): without this guard, a concurrent caller reading stale (pre-completion) data could
 * write a "provisional" row over an already-"final" one written by the other caller in between the
 * first caller's own read and write.
 */
export async function upsertWeeklyReport(
  input: {
    channelId: string;
    weekStartDate: string;
    weekEndDate: string;
    status: string;
    reportJson: string;
  },
  generatedAt: Date,
  database: AppDb = db
): Promise<void> {
  const values = {
    channelId: input.channelId,
    weekStartDate: input.weekStartDate,
    weekEndDate: input.weekEndDate,
    status: input.status,
    reportJson: input.reportJson,
    generatedAt,
  };

  await database
    .insert(analyticsWeeklyReports)
    .values(values)
    .onConflictDoUpdate({
      target: [analyticsWeeklyReports.channelId, analyticsWeeklyReports.weekStartDate],
      set: values,
      // Only overwrite an existing row when it is NOT already "final" -- see this function's own
      // doc comment above. `analyticsWeeklyReports.status` here refers to the EXISTING row's value
      // (standard SQLite ON CONFLICT semantics), never the new value being inserted.
      setWhere: ne(analyticsWeeklyReports.status, "final"),
    });
}

export async function getWeeklyReportByWeek(
  channelId: string,
  weekStartDate: string,
  database: AppDb = db
): Promise<StoredWeeklyReport | null> {
  const rows = await database
    .select()
    .from(analyticsWeeklyReports)
    .where(and(eq(analyticsWeeklyReports.channelId, channelId), eq(analyticsWeeklyReports.weekStartDate, weekStartDate)))
    .limit(1);

  return rows[0] ?? null;
}

export async function listWeeklyReportsByChannel(
  channelId: string,
  database: AppDb = db
): Promise<StoredWeeklyReport[]> {
  return database
    .select()
    .from(analyticsWeeklyReports)
    .where(eq(analyticsWeeklyReports.channelId, channelId))
    .orderBy(desc(analyticsWeeklyReports.weekStartDate));
}

export type StoredCreativeAsset = {
  id: string;
  channelId: string;
  assetType: string;
  referenceKind: string;
  referenceValue: string;
  title: string | null;
  description: string | null;
  linkedVideoId: string | null;
  provenanceJson: string | null;
  createdAt: Date;
};

export async function insertCreativeAsset(
  input: {
    id: string;
    channelId: string;
    assetType: string;
    referenceKind: string;
    referenceValue: string;
    title?: string | null;
    description?: string | null;
    linkedVideoId?: string | null;
    provenanceJson?: string | null;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(creativeAssets).values({
    id: input.id,
    channelId: input.channelId,
    assetType: input.assetType,
    referenceKind: input.referenceKind,
    referenceValue: input.referenceValue,
    title: input.title ?? null,
    description: input.description ?? null,
    linkedVideoId: input.linkedVideoId ?? null,
    provenanceJson: input.provenanceJson ?? null,
  });
}

export async function listCreativeAssetsByChannel(
  channelId: string,
  filters: { videoId?: string; assetType?: string } = {},
  database: AppDb = db
): Promise<StoredCreativeAsset[]> {
  const conditions = [eq(creativeAssets.channelId, channelId)];
  if (filters.videoId) {
    conditions.push(eq(creativeAssets.linkedVideoId, filters.videoId));
  }
  if (filters.assetType) {
    conditions.push(eq(creativeAssets.assetType, filters.assetType));
  }

  return database
    .select()
    .from(creativeAssets)
    .where(and(...conditions))
    .orderBy(desc(creativeAssets.createdAt));
}

export async function getCreativeAssetById(
  assetId: string,
  database: AppDb = db
): Promise<StoredCreativeAsset | null> {
  const [row] = await database.select().from(creativeAssets).where(eq(creativeAssets.id, assetId));
  return row ?? null;
}

export type StoredContentProposal = {
  id: string;
  channelId: string;
  objective: string | null;
  topicConcept: string | null;
  rationale: string | null;
  evidenceJson: string | null;
  briefJson: string | null;
  referenceVideoIdsJson: string | null;
  referenceAssetIdsJson: string | null;
  createdAt: Date;
  createdVia: string;
  agentApiVersion: string | null;
};

export async function insertContentProposal(
  input: {
    id: string;
    channelId: string;
    objective?: string | null;
    topicConcept?: string | null;
    rationale?: string | null;
    evidenceJson?: string | null;
    briefJson?: string | null;
    referenceVideoIdsJson?: string | null;
    referenceAssetIdsJson?: string | null;
    createdVia: string;
    agentApiVersion?: string | null;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(contentProposals).values({
    id: input.id,
    channelId: input.channelId,
    objective: input.objective ?? null,
    topicConcept: input.topicConcept ?? null,
    rationale: input.rationale ?? null,
    evidenceJson: input.evidenceJson ?? null,
    briefJson: input.briefJson ?? null,
    referenceVideoIdsJson: input.referenceVideoIdsJson ?? null,
    referenceAssetIdsJson: input.referenceAssetIdsJson ?? null,
    createdVia: input.createdVia,
    agentApiVersion: input.agentApiVersion ?? null,
  });
}

export async function listContentProposalsByChannel(
  channelId: string,
  database: AppDb = db
): Promise<StoredContentProposal[]> {
  return database
    .select()
    .from(contentProposals)
    .where(eq(contentProposals.channelId, channelId))
    .orderBy(desc(contentProposals.createdAt));
}

export async function getContentProposalById(
  proposalId: string,
  database: AppDb = db
): Promise<StoredContentProposal | null> {
  const [row] = await database.select().from(contentProposals).where(eq(contentProposals.id, proposalId));
  return row ?? null;
}

export type StoredContentProposalArtifactLink = {
  id: string;
  proposalId: string;
  assetId: string;
  createdAt: Date;
  createdVia: string;
  agentApiVersion: string | null;
};

export async function insertContentProposalArtifactLink(
  input: {
    id: string;
    proposalId: string;
    assetId: string;
    createdVia: string;
    agentApiVersion?: string | null;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(contentProposalArtifacts).values({
    id: input.id,
    proposalId: input.proposalId,
    assetId: input.assetId,
    createdVia: input.createdVia,
    agentApiVersion: input.agentApiVersion ?? null,
  });
}

export async function listContentProposalArtifactLinksByProposal(
  proposalId: string,
  database: AppDb = db
): Promise<StoredContentProposalArtifactLink[]> {
  return database
    .select()
    .from(contentProposalArtifacts)
    .where(eq(contentProposalArtifacts.proposalId, proposalId))
    .orderBy(desc(contentProposalArtifacts.createdAt));
}

export async function getContentProposalArtifactLinkById(
  linkId: string,
  database: AppDb = db
): Promise<StoredContentProposalArtifactLink | null> {
  const [row] = await database.select().from(contentProposalArtifacts).where(eq(contentProposalArtifacts.id, linkId));
  return row ?? null;
}

// The one and only row this table ever holds -- see `cloudConnection`'s own doc comment above.
const CLOUD_CONNECTION_SINGLETON_ID = "default";

export type StoredCloudConnection = {
  connectedEmail: string;
  scope: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  connectedAt: Date;
};

export async function getStoredCloudConnection(database: AppDb = db): Promise<StoredCloudConnection | null> {
  const [row] = await database
    .select()
    .from(cloudConnection)
    .where(eq(cloudConnection.id, CLOUD_CONNECTION_SINGLETON_ID));

  if (!row || !row.ciphertext || !row.iv || !row.authTag || !row.connectedEmail || !row.scope || !row.connectedAt) {
    return null;
  }

  return {
    connectedEmail: row.connectedEmail,
    scope: row.scope,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    connectedAt: row.connectedAt,
  };
}

export async function upsertStoredCloudConnection(
  input: {
    connectedEmail: string;
    scope: string;
    ciphertext: string;
    iv: string;
    authTag: string;
  },
  database: AppDb = db
): Promise<void> {
  const now = new Date();
  const existing = await getStoredCloudConnection(database);

  if (existing) {
    await database
      .update(cloudConnection)
      .set({ ...input, updatedAt: now })
      .where(eq(cloudConnection.id, CLOUD_CONNECTION_SINGLETON_ID));
  } else {
    await database.insert(cloudConnection).values({
      id: CLOUD_CONNECTION_SINGLETON_ID,
      ...input,
      connectedAt: now,
      updatedAt: now,
    });
  }
}

export async function clearStoredCloudConnection(database: AppDb = db): Promise<void> {
  await database.delete(cloudConnection).where(eq(cloudConnection.id, CLOUD_CONNECTION_SINGLETON_ID));
}
