import { chmodSync, existsSync, mkdirSync } from "fs";
import { readFile } from "fs/promises";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";
import { type Client } from "@libsql/client";
import { createLibsqlClient, SQLITE_BUSY_TIMEOUT_MS } from "@/lib/libsql-client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import path from "path";
import { API_DATA_RETENTION_DAYS, YOUTUBE_API_SNAPSHOT_SOURCES } from "@/lib/youtube-data-policy/contracts";
import { MEDIA_SESSION_ACTIVE_STATUSES, MEDIA_SESSION_STATUSES, MEDIA_SESSION_TERMINAL_STATUSES, type MediaSessionStatus } from "@/lib/media-generation/contracts";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { AttemptOutcome, AttemptPhase, LedgerStatus } from "@/lib/batches/ledger-state";
import { getProductionAppPaths, isRunningUnderTestRunner, resolveLegacyDbPath } from "@/lib/platform-paths";
import { copyDatabaseConsistently, isMissingTableError } from "@/lib/db-backup";
import {
  assertSupportedSchemaVersion,
  readSchemaVersion,
  runSchemaMigrations,
  type SchemaMigration,
} from "@/lib/schema-versioning";
import { createRecoverableInitializer } from "@/lib/recoverable-initializer";
import { acquireOperationLock, OperationLockError, releaseOperationLock, releaseStaleExportLock } from "@/lib/operation-lock";
import { getAgentSession } from "@/lib/agent-session";
import { decodeStoredOAuthToken, encodeStoredOAuthToken } from "@/lib/oauth-token-crypto";

// Platform-aware app-data location (docs/decisions/0002-additive-schema-versioning.md's
// companion task, "Pre-Release Cross-Platform Persistence"). getProductionAppPaths() is the
// single shared implementation of "resolve the real app-data location, but redirect to an
// isolated temp directory under Node's own test runner" -- src/lib/cli-auth/adapters/active-auth-storage.ts and
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

// Captured *before* `createLibsqlClient()` below -- verified empirically that `@libsql/client`'s
// `createClient()` (which `createLibsqlClient()` calls) synchronously creates an empty file at the given path as a side effect of
// construction, before any query runs. An earlier version of this file checked
// `existsSync(appPaths.dbPath)` *after* calling `createClient()`, which made that check always
// true and silently skipped every legacy migration forever -- a real, previously-shipped bug,
// found and fixed via independent review. This flag is the one piece of truth that check
// needed; everything below is ordered around preserving it correctly.
const dbAlreadyExistedAtModuleLoad = existsSync(appPaths.dbPath);

const rawClient = createLibsqlClient({
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
  // Additive, SCHEMA_MIGRATIONS version 41 (BL-115): when Google last ISSUED this identity's refresh token
  // (a sign-in / device-flow exchange that returned one; never a mere access-token refresh). NULL = unknown
  // (every row from before v41). While the OAuth app is in Testing status Google expires a refresh token 7
  // days after issue, so this is the age signal for the dashboard's re-login prompt.
  refreshTokenIssuedAt: integer("refresh_token_issued_at", { mode: "timestamp" }),
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
  // Additive, SCHEMA_MIGRATIONS version 44 (BL-118): when the channel was created on YouTube (`snippet.publishedAt`, RFC 3339 as
  // returned). Nullable with no default (RISK-89: this table is transferred); filled by the next channel sync.
  publishedAt: text("published_at"),
  // Additive, SCHEMA_MIGRATIONS version 6 -- a JSON array of language codes the operator wants
  // tracked as Languages-tab columns even before any video has a real translation in them
  // (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2/E5, owner instruction 2026-09-21).
  // NULL means "none explicitly tracked yet", never backfilled to "[]" (RISK-02/RISK-33's "never
  // silently create a fact that isn't true").
  targetLanguagesJson: text("target_languages_json"),
  // Additive, SCHEMA_MIGRATIONS version 39 -- the operator-chosen EXPECTED language baseline for
  // this channel's videos (owner instruction 2026-10-02): `defaultLanguage` = "Title and
  // description language", `defaultAudioLanguage` = "Video language" (e.g. "zxx" = Not
  // applicable). NULL = no baseline chosen. Pure expectation data; nothing here writes to YouTube.
  expectedDefaultLanguage: text("expected_default_language"),
  expectedDefaultAudioLanguage: text("expected_default_audio_language"),
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
  // Additive, schema version 19 (Phase 7 slice K, owner spec §10 "similar duration" filter) --
  // same nullable-until-next-sync convention as the three columns above.
  durationSeconds: integer("duration_seconds"),
  // Additive, SCHEMA_MIGRATIONS version 47: YouTube's `snippet.liveBroadcastContent` ("none" | "live" | "upcoming") from the last sync; NULL = unknown.
  liveBroadcastContent: text("live_broadcast_content"),
  // Additive, schema version 21 (owner instruction, 2026-09-26, Telegram: Content tab's "Publish"
  // column needs a scheduled-publish date for a still-private video, not only its actual
  // `publishedAt`). This is YouTube's own `status.publishAt` -- a distinct field from
  // `snippet.publishedAt` above, present only while a video is privately scheduled to go public
  // later; `null` once the video is actually public (YouTube itself clears it) or if it was never
  // scheduled at all. Same nullable-until-next-sync convention as the columns above.
  publishAt: text("publish_at"),
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
  // Additive, SCHEMA_MIGRATIONS version 43 (BL-117): JSON array of the batch ids this (never executed) batch was split
  // into because it needed more quota than was available. NULL for every other batch.
  splitIntoJson: text("split_into_json"),
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

// Generic key/value app settings (SCHEMA_MIGRATIONS version 7) -- backs the per-device Settings-tab
// toggles and values (Live writes, MCP connection, Operator CLI access, read toggles, analytics
// sync time, operations workspace path, market-intelligence quota budget, ...). A plain key/value
// table rather than one column per setting -- see `getAppSetting`/`setAppSetting` below.
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
 * `mcp_tool_calls` never records a `blocked` outcome for the "MCP connection off" case: a tool is
 * never registered at all then, so there is no failed call to log, only an absent one. It DOES
 * record `blocked` for a call whose agent token fails re-verification (Phase 12, `src/mcp/server.ts`'s
 * `registerTool` wrapper; BL-091's zone rejections were retired with the zones, ADR 0011) -- a real,
 * counted call attempt through an actually-registered tool, unlike the "connection off" case.
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
 * BL-117 (docs/roadmap/plans/QUOTA_HISTORY_AND_GUARD_PLAN.md) -- one row per YouTube Data / Analytics API call this
 * device made: when, which method, how many quota units it cost (NULL = method not in the cost table), how it ended,
 * and which piece of work it belonged to (`context_*`, NULL = none). Append-only, 45-day retention. Device-local
 * (never in a snapshot: it is written constantly by every device, a replace-style sync would conflict forever);
 * sharing it between devices is a separate per-device-file exchange, not this table.
 */
export const quotaLedger = sqliteTable(
  "quota_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: integer("occurred_at").notNull(),
    service: text("service").notNull(), // 'data' | 'analytics'
    method: text("method").notNull(), // e.g. 'videos.update'
    units: integer("units"),
    outcome: text("outcome").notNull(), // 'ok' | 'error' | 'quota_exceeded'
    contextKind: text("context_kind"),
    contextId: text("context_id"),
    contextLabel: text("context_label"),
  },
  (table) => [index("quota_ledger_occurred_idx").on(table.occurredAt)]
);

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
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` slice 12.4, owner decision D1: "общий сбор и потом
 * выдаем каждому каналу что нужно ему"), SCHEMA_MIGRATIONS version 35. Market records are collected
 * once, globally (Phase 9); the operator then assigns individual records to channels, and a
 * channel-bound agent sees only what is assigned to its own channel. `record_kind` names which
 * Phase 9 record `record_id` refers to (no FK -- five different parent tables; validated in the
 * service). A research request an agent creates is recorded here as owned by its channel.
 *
 * Unlike `agent_channel_tokens`, this IS business data and travels with a device handoff
 * (`SNAPSHOT_TRANSFERRED_TABLES`), exactly like the Phase 9 tables it annotates.
 */
export const channelRecordAssignments = sqliteTable(
  "channel_record_assignments",
  {
    channelId: text("channel_id").notNull(),
    recordKind: text("record_kind").notNull(),
    recordId: text("record_id").notNull(),
    assignedAt: integer("assigned_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.recordKind, table.recordId] })]
);

/**
 * Phase 12 (channel-bound agent isolation, `docs/roadmap/plans/PHASE_12_PLAN.md` slice 12.1),
 * SCHEMA_MIGRATIONS version 34. One row per issued agent channel token. Only a SHA-256 hash of the
 * token is ever stored (AC-P12-11); the plaintext is shown to the operator once at issue time.
 * `user_id` is the Google identity recorded AT ISSUE TIME (verified then to own the channel live) --
 * an agent session's credentials always come from here, never from `channels.connected_user_id`
 * (which an explicit-id `channel_sync` can overwrite). At most one non-revoked row per channel
 * (one agent = one channel, owner decision): issuing a new token revokes the previous one.
 *
 * Device-local: NOT in `SNAPSHOT_TRANSFERRED_TABLES` and not in `sync-gateway` -- an agent is
 * configured per machine, the same reasoning as `agent_connections`.
 */
export const agentChannelTokens = sqliteTable("agent_channel_tokens", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

/**
 * Phase 11 (Channel Workspaces, `docs/roadmap/plans/PHASE_11_PLAN.md` §1), SCHEMA_MIGRATIONS
 * version 33. One operator-set local filesystem path per (device, channel) -- the channel's
 * production-workspace folder on THIS machine. This product stores and returns the string only;
 * it never enumerates, reads, writes, or validates anything inside the path after set time.
 *
 * **Device-local, deliberately NOT in `SNAPSHOT_TRANSFERRED_TABLES`** (`src/lib/snapshot/contracts.ts`)
 * and not in `sync-gateway` -- a local path is meaningless on another machine. Rows are keyed on
 * this installation's bootstrap `deviceId` and every read filters on it, so a row that arrives some
 * other way (e.g. a `data.db` copied from another machine) is invisible, never silently reused.
 */
export const channelWorkspaces = sqliteTable(
  "channel_workspaces",
  {
    deviceId: text("device_id").notNull(),
    channelId: text("channel_id").notNull(),
    path: text("path").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.channelId] })]
);

/**
 * Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md §2.9), SCHEMA_MIGRATIONS version 50. The RunPod API
 * key and the S3 API key pair the operator typed into Settings → Media, as ONE AES-256-GCM blob
 * (`src/lib/media-generation/`). The encryption key is NOT an environment variable: the app
 * generates it on first use and keeps it in a 0600 file in the app-data directory (owner
 * instruction, Telegram 2026-10-05: "вводить через интерфейс настроек и сохранять закодировано
 * локально на каждой машине"). A `playlist-manager.db` copied to another machine has no matching
 * key file, so this row reads as "not configured" there, never as foreign plaintext.
 *
 * A singleton (`id = "default"`). `runpod_key_prefix` (the first characters of the key, for
 * recognition in the UI) and `s3_access_key_id` (RunPod's `user_...` id, not a secret) are
 * plaintext; `verified_at` is when a "Test" last succeeded.
 *
 * **Device-local, deliberately NOT in `SNAPSHOT_TRANSFERRED_TABLES`** (`src/lib/snapshot/contracts.ts`)
 * and not in `sync-gateway`, like `cloud_connection` and `ai_connection_credentials`.
 */
export const mediaCredentials = sqliteTable("media_credentials", {
  id: text("id").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  runpodKeyPrefix: text("runpod_key_prefix").notNull(),
  s3AccessKeyId: text("s3_access_key_id"),
  verifiedAt: integer("verified_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// The status lists have ONE owner, the pure contracts module (review round 21): never a hand copy here that could drift
// from what the domain treats as terminal (the copy decides whether the open slot is freed).
export { MEDIA_SESSION_STATUSES };
export type MediaSessionStatusValue = MediaSessionStatus;

/**
 * Phase 14 slice 2 (docs/roadmap/plans/PHASE_14_PLAN.md §2.3), SCHEMA_MIGRATIONS version 51. One
 * generation session = one RunPod pod, requested by the operator or an agent, approved by a human,
 * watched (idle / minutes / USD caps) and always TERMINATED (never stopped). Transitions are atomic
 * `UPDATE ... WHERE status IN (...) RETURNING`, like `market_collection_requests`.
 *
 * `open_slot` is 1 while the session is non-terminal and NULL once terminal. Until schema v58 a UNIQUE
 * index on it made "one open session per device" a database fact; slice 6 (owner, 2026-10-05) allows
 * concurrent sessions, so the index is plain and the bound is `approveMediaSessionGuarded`'s single
 * guarded UPDATE (active count < `maxConcurrentSessions`). The ComfyUI proxy token is stored encrypted
 * under the same per-device key as `media_credentials` and never returned by any read.
 *
 * **Device-local, NOT in `SNAPSHOT_TRANSFERRED_TABLES`** -- a pod is owned by the server process
 * that started it (its watcher and boot sweep run there); another device must not inherit it.
 */
export const mediaSessions = sqliteTable(
  "media_sessions",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    status: text("status", { enum: MEDIA_SESSION_STATUSES }).notNull().default("pending"),
    openSlot: integer("open_slot"),
    requestedBy: text("requested_by", { enum: ["operator", "agent", "factory"] }).notNull(),
    reason: text("reason"),
    maxMinutes: integer("max_minutes").notNull(),
    maxUsd: real("max_usd"),
    estimateUsd: real("estimate_usd").notNull(),
    fitsToday: integer("fits_today", { mode: "boolean" }).notNull(),
    costPerHr: real("cost_per_hr"),
    gpuTypeId: text("gpu_type_id"),
    datacenterId: text("datacenter_id"),
    podId: text("pod_id"),
    comfyUiProxyUrl: text("comfy_ui_proxy_url"),
    tokenCiphertext: text("token_ciphertext"),
    tokenIv: text("token_iv"),
    tokenAuthTag: text("token_auth_tag"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    approvedByUserId: text("approved_by_user_id"),
    startedAt: integer("started_at", { mode: "timestamp" }),
    readyAt: integer("ready_at", { mode: "timestamp" }),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp" }),
    stoppedAt: integer("stopped_at", { mode: "timestamp" }),
    secondsUsed: integer("seconds_used"),
    usdCharged: real("usd_charged"),
    stopReason: text("stop_reason"),
    error: text("error"),
    /**
     * Schema v53 (review round 6): the terminal status a `stopping` row is heading for (`done` for an
     * operator/watcher/shutdown stop, `failed` for an aborted start, `interrupted` for a boot sweep), so a
     * retried stop reports what really happened instead of defaulting to `done`.
     */
    stoppingOutcome: text("stopping_outcome", { enum: ["done", "failed", "interrupted"] }),
    /**
     * Schema v54 (review round 7): the last moment THIS app saw the pod alive (readiness, every watcher
     * tick). When the pod is already gone at a reconciliation, the billable window is closed here, not at
     * `now()` -- a pod terminated by hand hours before a reboot must not be billed up to the reboot.
     */
    lastSeenAliveAt: integer("last_seen_alive_at", { mode: "timestamp" }),
    /**
     * Schema v57 (review round 19): when this app's terminate DELETE went through for the pod. A later retry whose DELETE
     * answers 404 then bills to this moment (the pod died by OUR hand then), not to the last sighting.
     */
    terminateSentAt: integer("terminate_sent_at", { mode: "timestamp" }),
    /** Schema v63 (BL-135): stop the pod once every job of the session is finished and none followed for a minute. */
    releaseWhenDone: integer("release_when_done", { mode: "boolean" }),
    // Schema v64 (BL-133): who approved it, the GPU plan asked for, and the capacity wait.
    approvedBy: text("approved_by"),
    gpuPlanJson: text("gpu_plan_json"),
    capacityAttempts: integer("capacity_attempts"),
    capacityNextAttemptAt: integer("capacity_next_attempt_at", { mode: "timestamp" }),
    capacityWaitUntil: integer("capacity_wait_until", { mode: "timestamp" }),
    /** Schema v66 (BL-143, ADR 0029): the generation plan this session works for (its whole cost counts there). */
    planId: text("plan_id"),
    // Schema v71 (BL-159, FO-REQ-0011): the session's own minimum host CUDA (call or template), the minimum the last
    // placement used (the higher of it and the owner's setting), and the current pod's host CUDA (null until known).
    minCudaVersion: text("min_cuda_version"),
    usedMinCudaVersion: text("used_min_cuda_version"),
    hostCudaVersion: text("host_cuda_version"),
  },
  (table) => [index("media_sessions_open_slot_idx").on(table.openSlot), index("media_sessions_status_idx").on(table.status)]
);

/**
 * Phase 14 slice 3 (PHASE_14_PLAN.md §2.4, owner decision D7), SCHEMA_MIGRATIONS version 52. An
 * operator-imported ComfyUI workflow in API format plus the parameters an agent may set (name ->
 * node/input, type, bounds). Technical graphs only: prompts arrive as job parameters, never live here.
 * Device-local in this phase (not in `SNAPSHOT_TRANSFERRED_TABLES`); `version` increments on edit so a
 * job's provenance names the exact graph it ran.
 */
export const mediaWorkflowTemplates = sqliteTable("media_workflow_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  description: text("description"),
  workflowJson: text("workflow_json").notNull(),
  parametersJson: text("parameters_json").notNull(),
  /** Schema v55 (review round 8): derived at import/update so a listing never re-parses the graph; null before v55. */
  outputNodeIdsJson: text("output_node_ids_json"),
  nodeCount: integer("node_count"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  /** Schema v61 (BL-132): `owner` = imported by the operator (local), `factory` = installed from the template registry. */
  source: text("source").notNull().default("owner"),
  /** Schema v61: SHA-256 of the registry file a `factory` row was installed from (same version, other content = refused). */
  registrySha256: text("registry_sha256"),
  /** Schema v61: a `factory` row's declared models `[{ folder, file, sha256 }]` (the deletion guard and `usedBy` read it). */
  modelsJson: text("models_json"),
  /** Schema v64 (BL-133): a registry template's GPU plan `{ candidates, minVramGb, maxPricePerHr }`. */
  gpuJson: text("gpu_json"),
  /** Schema v71 (BL-159): the lowest host CUDA version a registry template needs. */
  minCudaVersion: text("min_cuda_version"),
});

export const MEDIA_JOB_STATUSES = ["queued", "submitted", "generating", "transferring", "done", "failed", "cancelled"] as const;
export type MediaJobStatusValue = (typeof MEDIA_JOB_STATUSES)[number];

/**
 * SCHEMA_MIGRATIONS version 52. One ComfyUI prompt inside a running session: template + params ->
 * prompt_id -> outputs pulled over S3 into `<workspace>/99 Data Exchange/From YTM/media/<jobId>/`
 * and registered in `creative_assets`. Transitions are atomic like `media_sessions`. Device-local.
 */
export const mediaJobs = sqliteTable(
  "media_jobs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    channelId: text("channel_id").notNull(),
    templateId: text("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    paramsJson: text("params_json").notNull(),
    status: text("status", { enum: MEDIA_JOB_STATUSES }).notNull().default("queued"),
    createdBy: text("created_by", { enum: ["operator", "agent", "factory"] }).notNull(),
    promptId: text("prompt_id"),
    outputsJson: text("outputs_json"),
    assetIdsJson: text("asset_ids_json"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    // Schema v66 (BL-143, ADR 0029): the generation plan attempt this job is (all null = not part of a plan).
    planId: text("plan_id"),
    planStageId: text("plan_stage_id"),
    planItemKey: text("plan_item_key"),
    planSeed: integer("plan_seed"),
  },
  (table) => [index("media_jobs_session_idx").on(table.sessionId), index("media_jobs_status_idx").on(table.status), index("media_jobs_plan_idx").on(table.planId)]
);

/**
 * Schema v61 (BL-132, FACTORY_MEDIA_CONTROL_PLAN.md §2.5): append-only audit of model pulls/cancels/deletions and
 * template installs/updates/removals, with who did it (`owner`, `factory`, `sync`). Device-local.
 */
export const mediaControlEvents = sqliteTable(
  "media_control_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at", { mode: "timestamp" }).notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    detailsJson: text("details_json"),
  },
  (table) => [index("media_control_events_at_idx").on(table.at)]
);

/** Schema v61 (BL-132, plan §2.4/§7): job input files uploaded as `exchange/in/<jobId>-<param>-<name>`, so the janitor deletes them by ledger only. */
/** Schema v64 (BL-133): one row per createPod attempt (placed / no capacity / error), kept 90 days. Device-local. */
export const mediaCapacityAttempts = sqliteTable(
  "media_capacity_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at", { mode: "timestamp" }).notNull(),
    sessionId: text("session_id").notNull(),
    datacenterId: text("datacenter_id"),
    gpuTypeId: text("gpu_type_id").notNull(),
    pricePerHr: real("price_per_hr"),
    result: text("result").notNull(),
    detail: text("detail"),
    /** Schema v71 (BL-159): on a `placed` entry, the host's CUDA version once known. */
    hostCudaVersion: text("host_cuda_version"),
  },
  (table) => [index("media_capacity_attempts_at_idx").on(table.at)]
);

/**
 * Schema v66 (BL-143, ADR 0029): a generation plan. The definition (stages, groups, items with their job params) is one
 * JSON document changed only by a compare-and-swap on `revision`; in-app progress is read from `media_jobs.plan_id`,
 * never copied. Device-local (owned by the device whose factory endpoint created it).
 */
export const generationPlans = sqliteTable(
  "generation_plans",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    channelId: text("channel_id").notNull(),
    owner: text("owner", { enum: ["factory", "operator"] }).notNull(),
    status: text("status", { enum: ["active", "completed", "cancelled"] }).notNull(),
    budgetUsd: real("budget_usd"),
    budgetGpuMinutes: real("budget_gpu_minutes"),
    note: text("note"),
    definitionJson: text("definition_json").notNull(),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    closedAt: integer("closed_at", { mode: "timestamp" }),
  },
  (table) => [index("generation_plans_status_idx").on(table.status)]
);

/**
 * Schema v66: one row per (plan, stage, item, attempt) of an external stage, an owner verdict, or an attempt imported from a
 * plan file; a repeated report replaces the row. Checks/metrics/markers are bounded JSON written by the plans module.
 */
export const generationPlanResults = sqliteTable(
  "generation_plan_results",
  {
    planId: text("plan_id").notNull(),
    stageId: text("stage_id").notNull(),
    itemKey: text("item_key").notNull(),
    attemptRef: text("attempt_ref").notNull(),
    result: text("result").notNull(),
    reportedBy: text("reported_by").notNull(),
    note: text("note"),
    rating: integer("rating"),
    reasonsJson: text("reasons_json"),
    markersJson: text("markers_json"),
    auditionFile: text("audition_file"),
    checksJson: text("checks_json"),
    metricsJson: text("metrics_json"),
    /** Schema v68 (BL-143 phase 3): the plan references nearest to this attempt (A/B listening). */
    referenceIdsJson: text("reference_ids_json"),
    at: integer("at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.planId, table.stageId, table.itemKey, table.attemptRef] }), index("generation_plan_results_at_idx").on(table.planId, table.at)]
);

/** Schema v66: things that happened to a plan that no other row records (an owner's re-run request, a group note change). */
export const generationPlanEvents = sqliteTable(
  "generation_plan_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: text("plan_id").notNull(),
    at: integer("at", { mode: "timestamp" }).notNull(),
    kind: text("kind").notNull(),
    actor: text("actor").notNull(),
    detailsJson: text("details_json"),
  },
  (table) => [index("generation_plan_events_plan_idx").on(table.planId, table.at)]
);

/**
 * Schema v67 (BL-143 phase 2): verdicts the owner gave on THIS device for plans owned by ANOTHER device. They travel in this
 * device's generation plans report; the owning device applies them. `at` is an ISO string (millisecond order matters).
 */
export const generationPlanPeerVerdicts = sqliteTable(
  "generation_plan_peer_verdicts",
  {
    verdictId: text("verdict_id").primaryKey(),
    planId: text("plan_id").notNull(),
    ownerDeviceId: text("owner_device_id").notNull(),
    itemKey: text("item_key").notNull(),
    attemptRef: text("attempt_ref").notNull(),
    result: text("result").notNull(),
    rating: integer("rating"),
    reasonsJson: text("reasons_json"),
    markersJson: text("markers_json"),
    note: text("note"),
    at: text("at").notNull(),
  },
  (table) => [index("generation_plan_peer_verdicts_at_idx").on(table.at)]
);

/**
 * Schema v69 (BL-157, SERVERS_MEDIA_PLAN.md AC-TC-05): every owner verdict on THIS device's plans, given here or applied from
 * another device -- the result row keeps only the newest, this keeps them all, with the device each was given on. Device-local.
 */
export const generationPlanVerdictHistory = sqliteTable(
  "generation_plan_verdict_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: text("plan_id").notNull(),
    itemKey: text("item_key").notNull(),
    attemptRef: text("attempt_ref").notNull(),
    result: text("result").notNull(),
    rating: integer("rating"),
    reasonsJson: text("reasons_json"),
    markersJson: text("markers_json"),
    note: text("note"),
    /** The computer it was given on (its host name, else its device id). */
    device: text("device").notNull(),
    /** When the owner gave it (that device's clock), ISO. */
    at: text("at").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("generation_plan_verdict_history_plan_idx").on(table.planId, table.itemKey, table.attemptRef)]
);

/**
 * Schema v70 (BL-157, AC-TC-01/AC-WV-06): this device's "being reviewed here" claims -- a track (`attempt`) or a wave
 * (`group`) of a plan owned by `owner_device_id` (this device's own id for its own plans). Published in this device's plans
 * report; advisory, not a lock. Times in ms. Device-local.
 */
export const generationPlanReviewClaims = sqliteTable(
  "generation_plan_review_claims",
  {
    claimId: text("claim_id").primaryKey(),
    planId: text("plan_id").notNull(),
    ownerDeviceId: text("owner_device_id").notNull(),
    scope: text("scope", { enum: ["attempt", "group"] }).notNull(),
    itemKey: text("item_key"),
    attemptRef: text("attempt_ref"),
    groupId: text("group_id"),
    since: integer("since", { mode: "timestamp_ms" }).notNull(),
    until: integer("until", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("generation_plan_review_claims_plan_idx").on(table.ownerDeviceId, table.planId)]
);

export const mediaExchangeInputs = sqliteTable(
  "media_exchange_inputs",
  {
    remoteKey: text("remote_key").primaryKey(),
    jobId: text("job_id").notNull(),
    parameter: text("parameter").notNull(),
    sourcePath: text("source_path").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedAt: integer("uploaded_at", { mode: "timestamp" }).notNull(),
    remoteDeletedAt: integer("remote_deleted_at", { mode: "timestamp" }),
  },
  (table) => [index("media_exchange_inputs_job_idx").on(table.jobId)]
);

/**
 * SCHEMA_MIGRATIONS version 52. The ledger the exchange janitor and the local writer act on -- BY
 * LEDGER ONLY (ADR 0019's rule): a remote key is deleted from the volume only after its row says the
 * file exists locally; nothing outside `exchange/` is ever listed or deleted. Device-local.
 */
export const mediaExchangeFiles = sqliteTable(
  "media_exchange_files",
  {
    remoteKey: text("remote_key").primaryKey(),
    jobId: text("job_id").notNull(),
    localPath: text("local_path").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    pulledAt: integer("pulled_at", { mode: "timestamp" }).notNull(),
    remoteDeletedAt: integer("remote_deleted_at", { mode: "timestamp" }),
  },
  (table) => [index("media_exchange_files_job_idx").on(table.jobId)]
);

/**
 * Factory Operator access (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` §2.2), SCHEMA_MIGRATIONS
 * version 59 (50 on dev; renumbered at the Phase 14 merge). The registry of logical paths: a stable `name` plus, in `logicalPathValues`, one local
 * path string per device. `audience` is `all_agents` (every channel agent may read it) or
 * `factory_only` (only the Factory Operator role). New paths are rows, never a schema change.
 *
 * **Both tables are device-local, deliberately NOT in `SNAPSHOT_TRANSFERRED_TABLES`** and not in
 * `sync-gateway` (owner decision, 2026-10-05: each machine configures only its own values). Values
 * are keyed on the bootstrap `deviceId` and every read filters on it, same as `channelWorkspaces`.
 */
export const logicalPaths = sqliteTable("logical_paths", {
  name: text("name").primaryKey(),
  audience: text("audience").notNull(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const logicalPathValues = sqliteTable(
  "logical_path_values",
  {
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.name] })]
);

/**
 * Factory Operator access (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` §2.1), SCHEMA_MIGRATIONS
 * version 60 (51 on dev; renumbered at the Phase 14 merge). The Factory Operator role's own agent token (`ytom_fo_...`): SHA-256 hash only, one active
 * row at a time, NO channel and NO Google identity (unlike `agentChannelTokens`). Deliberately a
 * separate table, so a channel token can never be looked up as a factory token or the reverse.
 * Device-local, NOT in `SNAPSHOT_TRANSFERRED_TABLES` and not in `sync-gateway`.
 */
export const factoryAgentTokens = sqliteTable("factory_agent_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

/**
 * BL-161 (FO-REQ-0012, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3), SCHEMA_MIGRATIONS version 72. The Producer role's own
 * agent token (`ytom_pr_...`): the same shape and rules as `factoryAgentTokens` (hash only, one active row, no channel, no Google
 * identity), a separate table so no other token can be looked up as a producer token or the reverse.
 */
export const producerAgentTokens = sqliteTable("producer_agent_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

/**
 * BL-161, SCHEMA_MIGRATIONS version 72: one row per Producer MCP tool call, allowed or refused (FO-REQ-0012 §2.4: the owner sees
 * what the Producer looked at). Device-local; rows older than 90 days are pruned on insert.
 */
export const producerCallLog = sqliteTable("producer_call_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at", { mode: "timestamp" }).notNull(),
  tool: text("tool").notNull(),
  channelId: text("channel_id"),
  outcome: text("outcome").notNull(),
  errorCode: text("error_code"),
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
    // Additive, SCHEMA_MIGRATIONS version 45 (BL-118): 1 when this run also collected the CHANNEL-level daily totals
    // (`channel_metrics_daily`); NULL/0 for every earlier run.
    channelLevel: integer("channel_level"),
    ranAt: integer("ran_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("analytics_collection_runs_channel_id_idx").on(table.channelId)]
);

/**
 * SCHEMA_MIGRATIONS version 45 (BL-118) -- CHANNEL-level daily totals (views, watch time, subscribers...) collected with the per-video
 * metrics, so the agent's channel analytics can be read locally instead of a live Analytics API call every time. Same shape and
 * rules as `video_metrics_daily` (the API omits zero-activity days: absence is not zero), device-local like it.
 */
export const channelMetricsDaily = sqliteTable(
  "channel_metrics_daily",
  {
    channelId: text("channel_id").notNull(),
    metricDate: text("metric_date").notNull(),
    metricName: text("metric_name").notNull(),
    metricValue: real("metric_value").notNull(),
    collectedAt: integer("collected_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.metricDate, table.metricName] })]
);

/**
 * SCHEMA_MIGRATIONS version 45 (BL-118) -- per-VIDEO history coverage: this video's daily metrics are collected contiguously from its
 * publish date through `history_through` (a date). Run windows alone cannot say this: a video first synced long after it was published
 * is covered by every channel-level run window yet has no early days. Maintained by collection; drives the automatic history catch-up.
 */
export const analyticsVideoHistory = sqliteTable("analytics_video_history", {
  videoId: text("video_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  historyThrough: text("history_through").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * SCHEMA_MIGRATIONS version 46 (research export, ADR 0019) -- ledger of the files the Manager itself wrote into a channel's workspace
 * `exports/` folder. It is what the expiry sweeper deletes by (file name inside the recorded folder), so nothing in the operator's folder is
 * ever found by scanning or globbing. Device-local: it names files on this computer.
 */
export const workspaceExportFiles = sqliteTable(
  "workspace_export_files",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    exportsDir: text("exports_dir").notNull(),
    fileName: text("file_name").notNull(),
    dataset: text("dataset").notNull(),
    format: text("format").notNull(),
    rowCount: integer("row_count").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [index("workspace_export_files_expires_at_idx").on(table.expiresAt)]
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
 * **Deliberately NOT added to `SNAPSHOT_TRANSFERRED_TABLES`** -- device-local together with the
 * data it is computed from: `video_metrics_daily` does not travel either (RISK-52's accepted
 * limitation, docs/ARCHITECTURE.md §14.7), so on a new device weekly reports are rebuilt from that
 * device's own collected metrics, never copied. (Corrected 2026-10-01, architecture audit M6: this
 * comment previously claimed the reports could be regenerated "from the data that IS transferred",
 * which was false.)
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
  (table) => [index("creative_assets_channel_id_idx").on(table.channelId), index("creative_assets_reference_idx").on(table.channelId, table.referenceKind, table.referenceValue)]
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

// BL-091's `agent_connections`/`agent_capability_zones` tables (SCHEMA_MIGRATIONS v20) were retired
// in Phase 12 (owner decision D4, `docs/decisions/0011-retire-agent-capability-zones.md`): no code
// reads or writes them any more. The migration and the (now inert) tables are deliberately kept --
// dropping a table is a subtractive schema change this project's additive policy
// (`docs/decisions/0001-additive-idempotent-schema-strategy.md`) does not do incidentally.

/**
 * Phase 9 slice 1 (`src/lib/market-intelligence/`) -- a manually-seeded market-research
 * watchlist entry (`docs/roadmap/plans/PHASE_9_PLAN.md` §5). `id` is the real YouTube channel
 * ID (e.g. `UC...`), never a generated UUID -- mirrors `channels.id`'s own convention, since
 * both tables identify the same kind of external entity. Deliberately **not** a foreign key
 * into `channels` and never joined with it: a row here may describe a channel the operator
 * does not own (the entire point of this table), or one they also happen to own -- the two
 * tables must stay structurally distinct regardless (`AGENTS.md` §F "keep owned-channel
 * analytics and public market/competitor observations explicitly separate").
 *
 * This watchlist is global (not scoped to any one owned channel) -- there is currently only
 * one operator per local install, and a competitor is often relevant research context for more
 * than one of the operator's own channels at once.
 *
 * **Correction, 2026-09-27 (RISK-52, closed by slice 9H part A):** now IS in
 * `SNAPSHOT_TRANSFERRED_TABLES` (`src/lib/snapshot/contracts.ts`) -- travels with device handoff,
 * per the owner's 2026-09-26 decision. This comment previously said the opposite.
 */
export const researchChannels = sqliteTable("research_channels", {
  id: text("id").primaryKey(),
  handleOrUrl: text("handle_or_url"),
  reason: text("reason").notNull(),
  createdVia: text("created_via").notNull(),
  addedAt: integer("added_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  /** Phase 9 slice 9B (`docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md`) -- mirrors
   * `channels.analyticsLastAutoCollectedAt`'s own shape/purpose exactly, scoped to a research
   * channel instead. `NULL` means never auto-collected (always stale). Set ONLY on a genuinely
   * successful refresh of THIS channel -- a run that skips this channel (budget exhausted) must
   * never touch it, so the channel stays stale for the next trigger. */
  lastAutoCollectedAt: integer("last_auto_collected_at", { mode: "timestamp" }),
  /** Phase 9 slice 9B -- the mark-then-run concurrency claim (advisor review before
   * implementation: analytics' own `runAutoCollectionIfStale` is actually mark-AFTER and
   * deliberately accepts a rare double-collection race, since Analytics quota is ample; this
   * feature's operator-set budget makes a double-spend a real correctness problem, so it earns its
   * own, stricter claim column rather than reusing `lastAutoCollectedAt` for both roles). Set
   * atomically (a single `UPDATE ... WHERE ... RETURNING` -- never read-then-write) immediately
   * before a channel's real work starts, and cleared once that channel's attempt reaches any
   * terminal outcome (success, failure, or quota-limited skip). A claim older than
   * `MARKET_INTELLIGENCE_CLAIM_EXPIRY_MS` is treated as abandoned (a crashed process) and may be
   * reclaimed -- never requires a manual operator unlock, unlike `operation-lock`'s deliberately
   * stricter export/import/migration guard. */
  collectionClaimedAt: integer("collection_claimed_at", { mode: "timestamp" }),
  // SCHEMA_MIGRATIONS version 48 (operator request 2026-10-04, deeper competitor collection). NULL = "use the global default"
  // (50 videos / no date until the operator sets one); the per-channel override of the two settings.
  maxVideosPerChannel: integer("max_videos_per_channel"),
  publishedAfter: text("published_after"),
  // Collection progress for the depth feature. `videosComplete` NULL = not yet known (treated as a first collection, still capped
  // at the effective cap), 0 = a backfill is under way, 1 = finished. `videosCompleteReason` = exhausted | cap | date;
  // `videosNextPageToken` = where the next run resumes; `videosCapAtRun`/`videosPublishedAfterAtRun` = the settings in force when
  // it completed, so a later raised cap or earlier date is noticed.
  videosComplete: integer("videos_complete"),
  videosCompleteReason: text("videos_complete_reason"),
  videosNextPageToken: text("videos_next_page_token"),
  videosCapAtRun: integer("videos_cap_at_run"),
  videosPublishedAfterAtRun: text("videos_published_after_at_run"),
});

/**
 * Phase 9 slice 1 -- one publicly-observable fact recorded against a `research_channels` row
 * (`docs/roadmap/plans/PHASE_9_PLAN.md` §5/§7). Never a private-analytics-shaped figure (no
 * CTR/retention/revenue field exists here, by design) and never a conclusion ("profitable",
 * "worth copying") -- a raw, sourced observation only. `confidence` is free text for this slice
 * (an enum is deferred until a real consumer needs to filter/sort by it).
 *
 * **Correction, 2026-09-27 (RISK-52, closed by slice 9H part A):** now IS in
 * `SNAPSHOT_TRANSFERRED_TABLES`, same as `research_channels` above.
 */
export const researchEvidence = sqliteTable(
  "research_evidence",
  {
    id: text("id").primaryKey(),
    researchChannelId: text("research_channel_id")
      .notNull()
      .references(() => researchChannels.id),
    observation: text("observation").notNull(),
    source: text("source").notNull(),
    confidence: text("confidence"),
    createdVia: text("created_via").notNull(),
    collectedAt: integer("collected_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("research_evidence_research_channel_id_idx").on(table.researchChannelId)]
);

/**
 * Phase 9 slice 9A (`docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md`) -- a structured, append-only
 * public observation of a watchlisted channel's own numeric stats. Never upserted by any natural
 * key -- every real fetch is its own newly-inserted row, since `channels.list` has no "historical
 * day" concept (unlike `video_metrics_daily`'s per-day upsert for owned-channel analytics; see the
 * slice plan §2 for why that pattern does not transfer here). `hiddenSubscriberCount` is an
 * explicit boolean, not inferred from `subscriberCount IS NULL` -- disambiguates "YouTube hides
 * this, a known fact" from "we don't know" (spec §27's data-quality vocabulary, the one item
 * actually knowable from a `channels.list` response today).
 *
 * **Correction, 2026-09-27 (RISK-52, closed by slice 9H part A):** now IS in
 * `SNAPSHOT_TRANSFERRED_TABLES`, same as `research_channels`/`research_evidence` -- the owner's
 * 2026-09-26 decision to transfer this data was implemented, not left as a separate engineering
 * choice, once the omission was found during 9H part A planning.
 */
export const marketChannelSnapshots = sqliteTable(
  "market_channel_snapshots",
  {
    id: text("id").primaryKey(),
    researchChannelId: text("research_channel_id")
      .notNull()
      .references(() => researchChannels.id),
    observedAt: integer("observed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    subscriberCount: integer("subscriber_count"),
    viewCount: integer("view_count"),
    videoCount: integer("video_count"),
    hiddenSubscriberCount: integer("hidden_subscriber_count", { mode: "boolean" }).notNull().default(false),
    source: text("source").notNull(),
    createdVia: text("created_via").notNull(),
  },
  (table) => [index("market_channel_snapshots_research_channel_id_idx").on(table.researchChannelId)]
);

/**
 * Phase 9 slice 9A -- same append-only shape as `marketChannelSnapshots`, for a video belonging to
 * a watchlisted channel. No FK on `videoId` -- there is no local "videos we don't own" watchlist
 * table yet (that is 9C's own future table, per `docs/roadmap/plans/PHASE_9_PLAN.md` §13's entity
 * mapping), so `videoId` is a plain YouTube id, exactly like `research_evidence.observation` never
 * references anything structured today. `publishedAt` is nullable -- not always known at snapshot
 * time depending on which future collection path populates a row, and needed later (9D) for
 * age-normalized comparison. **No automatic writer exists for this table in slice 9A** -- only a
 * manual `recordVideoSnapshot` entry point; real video-enumeration collection is 9B's own scope.
 */
export const marketVideoSnapshots = sqliteTable(
  "market_video_snapshots",
  {
    id: text("id").primaryKey(),
    researchChannelId: text("research_channel_id")
      .notNull()
      .references(() => researchChannels.id),
    videoId: text("video_id").notNull(),
    observedAt: integer("observed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    viewCount: integer("view_count"),
    likeCount: integer("like_count"),
    commentCount: integer("comment_count"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    // Phase 9 slice 9H part C (v28) -- nullable: `NULL` honestly means "not captured" for any
    // snapshot taken before this column existed; never backfilled or guessed from a later
    // snapshot's own (possibly since-changed) title.
    title: text("title"),
    // SCHEMA_MIGRATIONS version 47 (operator request 2026-10-04) -- NULL honestly means "not captured" (every snapshot taken before this
    // column existed, or a collection path that did not return it); never 0 and never backfilled.
    durationSeconds: integer("duration_seconds"),
    liveBroadcastContent: text("live_broadcast_content"),
    source: text("source").notNull(),
    createdVia: text("created_via").notNull(),
  },
  (table) => [
    index("market_video_snapshots_research_channel_id_idx").on(table.researchChannelId),
    index("market_video_snapshots_video_id_idx").on(table.videoId),
  ]
);

/**
 * Phase 9 slice 9B (`docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md`) -- append-only, one row per real
 * attempt at refreshing one watchlisted channel. Serves TWO roles at once, deliberately not split
 * into two tables: (1) the audit trail owner spec §25 requires ("failures must be visible and
 * auditable") -- mirrors `analyticsCollectionRuns`' own precedent and role; (2) the quota ledger's
 * own source of truth (`SUM(units_spent)` for today's UTC calendar day) -- `gatewayCallEvents`
 * cannot serve this role, since it counts YouTube-client CONSTRUCTIONS, not real per-request unit
 * spend (confirmed by direct inspection before this slice was designed). `videos_requested` vs.
 * `videos_returned` disambiguates "some ids came back missing" from either extreme, honestly --
 * `videos.list` silently omits deleted/private videos from its response with no distinguishing
 * signal, so a gap here is reported as exactly that (a gap), never assumed to mean `deleted_video`
 * specifically (no evidence for that stronger claim exists from this call alone).
 */
export const marketIntelligenceCollectionRuns = sqliteTable(
  "market_intelligence_collection_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    researchChannelId: text("research_channel_id")
      .notNull()
      .references(() => researchChannels.id),
    ranAt: integer("ran_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    status: text("status", { enum: ["success", "skipped_quota_limited", "failed"] }).notNull(),
    unitsSpent: integer("units_spent").notNull(),
    videosRequested: integer("videos_requested"),
    videosReturned: integer("videos_returned"),
    errorMessage: text("error_message"),
    // SCHEMA_MIGRATIONS version 48 -- true when the uploads playlist call failed and the ~15-video RSS feed was used instead.
    feedFallback: integer("feed_fallback", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("market_intelligence_collection_runs_research_channel_id_idx").on(table.researchChannelId),
    index("market_intelligence_collection_runs_ran_at_idx").on(table.ranAt),
  ]
);

/**
 * Phase 9 slice 9C (`docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md`) -- a LIFECYCLE table, not an
 * append-only observation series like `marketChannelSnapshots`/`marketVideoSnapshots` above: one
 * row per discovered channel, touched (never duplicated) on rediscovery. No FK to
 * `researchChannels` -- a candidate is explicitly a PRE-watchlist entity; promotion inserts a
 * separate `research_channels` row and keeps this one (`status: "promoted"`) as a permanent
 * historical record.
 */
export const marketDiscoveryCandidates = sqliteTable("market_discovery_candidates", {
  id: text("id").primaryKey(), // the real YouTube channel id
  title: text("title").notNull(),
  status: text("status", { enum: ["new", "watching", "ignored", "archived", "promoted"] }).notNull(),
  discoverySource: text("discovery_source").notNull(),
  discoveryQuery: text("discovery_query").notNull(),
  reasonDiscovered: text("reason_discovered"),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  createdVia: text("created_via").notNull(),
  // BL-145 (v65): the channel's public counts as observed right after the search that found it (channels.list).
  // Observed values with their time only; blanked with the title after 30 days (youtube-data-policy).
  subscriberCount: integer("subscriber_count"),
  hiddenSubscriberCount: integer("hidden_subscriber_count", { mode: "boolean" }),
  videoCount: integer("video_count"),
  viewCount: integer("view_count"),
  channelPublishedAt: text("channel_published_at"),
  statsObservedAt: integer("stats_observed_at", { mode: "timestamp" }),
  // BL-145 genre search (v65): how many of this channel's videos the latest genre search returned, their total views,
  // and that search's query. Observed values only; blanked after 30 days.
  matchQuery: text("match_query"),
  matchVideoCount: integer("match_video_count"),
  matchViewCount: integer("match_view_count"),
});

/**
 * Phase 9 slice 9C -- this slice's own `market_intelligence_collection_runs` counterpart: append-
 * only audit trail and, since Phase 13 slice 13.4, the ledger of the separate `search.list` bucket
 * (one row = one call, `countMarketDiscoverySearchesSince`). Not scoped to any one `researchChannelId` -- a discovery
 * run is a search, not a per-channel refresh -- so it cannot reuse that other table's own
 * NOT-NULL-FK'd shape.
 */
export const marketDiscoveryRuns = sqliteTable(
  "market_discovery_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    query: text("query").notNull(),
    ranAt: integer("ran_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    status: text("status", { enum: ["success", "failed"] }).notNull(),
    unitsSpent: integer("units_spent").notNull(),
    candidatesFound: integer("candidates_found"),
    candidatesNew: integer("candidates_new"),
    errorMessage: text("error_message"),
    // BL-145 (v65): units of the 10,000-unit POOL this search spent besides the search itself (channel counts, video
    // views). `units_spent` stays the search bucket's 1. Counted in the Research daily unit budget.
    poolUnitsSpent: integer("pool_units_spent"),
  },
  (table) => [index("market_discovery_runs_ran_at_idx").on(table.ranAt)]
);

/**
 * Phase 9 slice 9E (`docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md`) -- a flat, operator-defined list
 * of topic labels (owner spec §13). `name` is stored as the operator typed it (display-preserving),
 * with a SERVICE-LEVEL normalized-uniqueness check (trim/collapse whitespace/lowercase) run before
 * insert -- the raw SQL `UNIQUE` below is a defense-in-depth backstop for an exact-string race, not
 * the primary duplicate-prevention mechanism (which needs case-insensitive/whitespace-normalized
 * comparison this column's own collation cannot express).
 */
export const marketTopics = sqliteTable("market_topics", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdVia: text("created_via").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Phase 13 slice 13.8 (docs/roadmap/plans/PHASE_13_PLAN.md) -- Wikipedia articles linked to a topic,
// and their daily page views (Wikimedia Pageviews API; CC0 data, not YouTube API data). Owned by
// `src/lib/wikipedia-signals`; deleting a topic cascades its links at the database level (FK), so the
// market-intelligence module needs no knowledge of this one (AGENTS.md §M).
export const topicWikipediaArticles = sqliteTable(
  "topic_wikipedia_articles",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id").notNull(),
    project: text("project").notNull(),
    article: text("article").notNull(),
    createdVia: text("created_via").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("topic_wikipedia_articles_unique").on(table.topicId, table.project, table.article)]
);

export const wikipediaPageviewsDaily = sqliteTable(
  "wikipedia_pageviews_daily",
  {
    project: text("project").notNull(),
    article: text("article").notNull(),
    /** YYYY-MM-DD (UTC day, as Wikimedia reports it). */
    date: text("date").notNull(),
    views: integer("views").notNull(),
  },
  (table) => [primaryKey({ columns: [table.project, table.article, table.date] })]
);

/**
 * BL-114 (docs/decisions/0014-youtube-reporting-api-gateway-child.md) -- the YouTube Reporting API job
 * this app holds for a channel and report type. Google is the source of truth (`jobs.list`); this row only
 * lets the UI/agent say "the job exists since X" without a network call.
 */
export const reportingJobs = sqliteTable(
  "reporting_jobs",
  {
    channelId: text("channel_id").notNull(),
    reportTypeId: text("report_type_id").notNull(),
    jobId: text("job_id").notNull(),
    jobName: text("job_name").notNull(),
    /** Google's own `job.createTime` (RFC 3339), never this app's clock. */
    jobCreatedAt: text("job_created_at"),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.reportTypeId] })]
);

/**
 * BL-114 -- the LAST sync attempt per channel and report type, kept apart from `reporting_jobs` (a job row
 * only exists once Google accepted a job; an attempt can fail before that: toggle off, missing scope, API
 * disabled) and apart from the file ledger (a failed file must NOT be recorded as seen, or it is never
 * retried). Read by the Analytics card and by the automatic-sync throttle.
 */
export const reportingSyncAttempts = sqliteTable(
  "reporting_sync_attempts",
  {
    channelId: text("channel_id").notNull(),
    reportTypeId: text("report_type_id").notNull(),
    attemptedAt: integer("attempted_at", { mode: "timestamp" }).notNull(),
    /** `ok` (all listed files handled), `partial` (some files failed, retried next time) or `failed` (the sync stopped early). */
    outcome: text("outcome").notNull(),
    /** Message of the error that stopped the sync; null unless `outcome = 'failed'`. */
    error: text("error"),
    filesListed: integer("files_listed").notNull().default(0),
    filesImported: integer("files_imported").notNull().default(0),
    /** JSON array of `{ reportId, error }` for files that failed in this attempt. */
    failuresJson: text("failures_json"),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.reportTypeId] })]
);

/**
 * One row per Reporting API report FILE already seen: the idempotency ledger (a file is downloaded once)
 * and the replacement bookkeeping (Google regenerates a period's file with a later `createTime`; the newer
 * file's rows replace the older file's, never add to them). `status` is `imported` or `superseded`.
 */
export const reportingReportFiles = sqliteTable(
  "reporting_report_files",
  {
    reportId: text("report_id").primaryKey(),
    channelId: text("channel_id").notNull(),
    reportTypeId: text("report_type_id").notNull(),
    jobId: text("job_id").notNull(),
    /** RFC 3339, as Google returned them. The period is [startTime, endTime). */
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    createTime: text("create_time").notNull(),
    rowCount: integer("row_count").notNull(),
    status: text("status").notNull(),
    importedAt: integer("imported_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("reporting_report_files_period_idx").on(table.channelId, table.reportTypeId, table.startTime, table.endTime)]
);

/**
 * `channel_reach_basic_a1` rows: thumbnail impressions and click-through rate per video per day. No FK to
 * `videos` (a report can name a video this device never synced, or one since deleted). `ctr` is NULL when the
 * report left it empty -- never fabricated as 0 -- and is stored exactly as the report gave it.
 */
export const channelReachDaily = sqliteTable(
  "channel_reach_daily",
  {
    channelId: text("channel_id").notNull(),
    /** YYYY-MM-DD, the report's own day (a Pacific-Time reporting day, never converted). */
    date: text("date").notNull(),
    videoId: text("video_id").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr"),
    sourceReportId: text("source_report_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.date, table.videoId] }),
    index("channel_reach_daily_source_idx").on(table.sourceReportId),
  ]
);

/**
 * Links a topic to a watchlisted channel or a video (owner spec §13's "manual associations").
 * `subjectId` is NOT a foreign key -- a single column can't conditionally reference two different
 * tables depending on `subjectType`, and a video has no canonical one-row-per-video table to
 * reference anyway (9A's `market_video_snapshots` is an append-only series). A channel-type
 * assignment is instead cascade-deleted explicitly inside `deleteResearchChannel` below, the same
 * way every other channel-scoped table already is.
 */
export const marketTopicAssignments = sqliteTable(
  "market_topic_assignments",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id")
      .notNull()
      .references(() => marketTopics.id),
    subjectType: text("subject_type", { enum: ["channel", "video"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    source: text("source", { enum: ["manual", "ai_assisted"] }).notNull(),
    createdVia: text("created_via").notNull(),
    assignedAt: integer("assigned_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("market_topic_assignments_topic_id_idx").on(table.topicId),
    index("market_topic_assignments_subject_idx").on(table.subjectType, table.subjectId),
    uniqueIndex("market_topic_assignments_unique_idx").on(table.topicId, table.subjectType, table.subjectId),
  ]
);

/**
 * Owner spec §14-16 -- entirely operator-created and evidenced by hand this slice (no automatic
 * cross-referencing of 9D's own breakout/emerging signals yet, `docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md`
 * §1). `topicId` is nullable -- a trend need not be topic-tagged yet.
 */
export const marketTrendCandidates = sqliteTable("market_trend_candidates", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  topicId: text("topic_id").references(() => marketTopics.id),
  status: text("status", { enum: ["emerging", "growing", "established", "declining", "stale"] }).notNull(),
  firstObservedAt: integer("first_observed_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastObservedAt: integer("last_observed_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  createdVia: text("created_via").notNull(),
});

/**
 * Purpose-built for this slice, NOT a reuse of `shared-provenance`'s `EvidenceReference` -- that
 * shape is for citing an EXTERNAL url-based source (an agent's own outside research), a mismatch
 * for "this trend is supported by these N of our own already-tracked channels/videos."
 */
export const marketTrendEvidence = sqliteTable(
  "market_trend_evidence",
  {
    id: text("id").primaryKey(),
    trendCandidateId: text("trend_candidate_id")
      .notNull()
      .references(() => marketTrendCandidates.id),
    evidenceType: text("evidence_type", { enum: ["supporting_channel", "supporting_video", "signal"] }).notNull(),
    referenceId: text("reference_id"),
    description: text("description").notNull(),
    createdVia: text("created_via").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("market_trend_evidence_trend_candidate_id_idx").on(table.trendCandidateId)]
);

/**
 * Phase 9 slice 9G, part B (`docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md`) -- an
 * agent-created research draft with a human-only approval gate (owner spec §29). No FK to anything
 * -- a request is not about one specific already-watchlisted channel (its `query` may discover
 * several, or none), mirroring `marketDiscoveryRuns`'s own FK-less shape for the identical reason.
 * `monitorDurationDays` is stored and returned as metadata only -- no code path in this application
 * ever reads it to decide whether/when to run anything (there is no scheduler here at all), which
 * is the concrete, structural answer to owner spec §29's "must not automatically create unlimited
 * collection jobs."
 */
export const marketResearchRequests = sqliteTable(
  "market_research_requests",
  {
    id: text("id").primaryKey(),
    query: text("query").notNull(),
    rationale: text("rationale").notNull(),
    monitorDurationDays: integer("monitor_duration_days"),
    status: text("status", { enum: ["pending", "approved", "rejected", "executed", "execution_failed"] })
      .notNull()
      .default("pending"),
    createdVia: text("created_via").notNull(),
    agentApiVersion: text("agent_api_version"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    resolvedReason: text("resolved_reason"),
    candidatesFound: integer("candidates_found"),
    candidatesNew: integer("candidates_new"),
    executionError: text("execution_error"),
  },
  (table) => [index("market_research_requests_status_idx").on(table.status)]
);

/**
 * SCHEMA_MIGRATIONS version 49 (docs/decisions/0021-agent-collection-requests.md, owner-approved 2026-10-04): an agent-created
 * request to collect a set of watchlist channels, approved by a human in the Research tab. JSON columns are stored as text and
 * parsed by the market-intelligence service (the shape lives there, not here). `channel_ids_json` is a fixed list taken at creation;
 * `estimate_json` is the local upper-bound estimate taken at creation; `result_json` is the per-channel outcome of the run.
 */
export const marketCollectionRequests = sqliteTable(
  "market_collection_requests",
  {
    id: text("id").primaryKey(),
    channelIdsJson: text("channel_ids_json").notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: ["pending", "approved", "running", "done", "rejected", "failed"] })
      .notNull()
      .default("pending"),
    estimateJson: text("estimate_json").notNull(),
    createdVia: text("created_via").notNull(),
    agentApiVersion: text("agent_api_version"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    approvedByUserId: text("approved_by_user_id"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    resolvedReason: text("resolved_reason"),
    resultJson: text("result_json"),
    unitsSpentTotal: integer("units_spent_total"),
    error: text("error"),
  },
  (table) => [index("market_collection_requests_status_idx").on(table.status)]
);

// Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- Decision & Experiment Engine,
// manual-entry record-keeping foundation. `channelId` nullable: a "new channel concept" hypothesis
// has no existing channel yet (FUTURE_PHASES.md §6).
export const hypotheses = sqliteTable("hypotheses", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").references(() => channels.id),
  statement: text("statement").notNull(),
  evidenceNotes: text("evidence_notes").notNull(),
  createdBy: text("created_by").notNull(),
  createdVia: text("created_via").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// `approvedBy`/`approvedAt` are set ONLY by transitionExperimentStatus's own atomic
// `WHERE status IN (...)` update (never at row creation, never by a generic "update experiment"
// call -- there isn't one) -- the structural approval gate FUTURE_PHASES.md §6 requires.
export const experiments = sqliteTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    hypothesisId: text("hypothesis_id")
      .notNull()
      .references(() => hypotheses.id),
    treatment: text("treatment").notNull(),
    controlBaseline: text("control_baseline").notNull(),
    successCriteria: text("success_criteria").notNull(),
    stoppingCriteria: text("stopping_criteria").notNull(),
    startConditions: text("start_conditions"),
    plannedDuration: text("planned_duration"),
    sampleCoverageConstraints: text("sample_coverage_constraints"),
    budgetEstimate: text("budget_estimate"),
    responsible: text("responsible").notNull(),
    status: text("status", { enum: ["proposed", "approved", "running", "concluded", "abandoned"] })
      .notNull()
      .default("proposed"),
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    // Phase 10 slice 5 -- deliberately plain TEXT, no `.references()`: `change_sets` rows are
    // really deleted (change-drafts' `discardLocalAndAdoptPeer`, RISK-46's divergent-lineage
    // flow), and this connection runs with `foreign_keys=ON`, so an FK here would make that
    // unrelated delete throw. Validated at the application level instead (RISK-66's own "no FK
    // for an informal reference" pattern), re-checked at execute time, not just at attach time.
    changeSetId: text("change_set_id"),
    executionBatchId: text("execution_batch_id"),
    // The atomic execution claim (`claimExperimentForExecution`) -- deliberately its own field,
    // never repurposing the user-visible `status` column as a lock, mirroring
    // `research_channels.collection_claimed_at`'s own precedent (Phase 9 slice 9B).
    executionClaimedAt: integer("execution_claimed_at", { mode: "timestamp" }),
    createdVia: text("created_via").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("experiments_hypothesis_id_idx").on(table.hypothesisId)]
);

// Append-only, mirroring market_channel_snapshots/market_video_snapshots (Phase 9) -- no
// update/delete function is ever written for this table. A correction is a new row, never an
// edit, which is what FUTURE_PHASES.md §6's "an AI agent may never silently rewrite a past
// outcome" requires structurally, not just by convention. `lessonsLearned` folds the
// "Retrospective" entity in as a field (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md §2) rather
// than a fifth table, for this first slice.
export const experimentOutcomes = sqliteTable(
  "experiment_outcomes",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => experiments.id),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    outcomeData: text("outcome_data").notNull(),
    dataQualityLimitations: text("data_quality_limitations"),
    criteriaMet: text("criteria_met", { enum: ["met", "not_met", "inconclusive"] }).notNull(),
    lessonsLearned: text("lessons_learned"),
    createdVia: text("created_via").notNull(),
  },
  (table) => [index("experiment_outcomes_experiment_id_idx").on(table.experimentId)]
);

// Append-only (mirrors experimentOutcomes/market_*_snapshots) -- no update/delete function is
// ever written. A wrong reference is superseded by adding a corrected one, never edited in place.
// `referenceJson` is validated (the referenced Phase 8/9 row actually exists) BEFORE this insert
// happens, by decision-engine/services.ts's `addHypothesisEvidence` -- via a resolver the caller
// (the route file, not this module) supplies, since decision-engine itself must never import
// analytics/market-intelligence (AGENTS.md §M, PHASE_9_PLAN.md §5's own precedent -- see
// docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §4).
export const hypothesisEvidence = sqliteTable(
  "hypothesis_evidence",
  {
    id: text("id").primaryKey(),
    hypothesisId: text("hypothesis_id")
      .notNull()
      .references(() => hypotheses.id),
    sourceType: text("source_type", {
      enum: ["phase8_metric", "phase9_channel_snapshot", "phase9_video_snapshot", "phase9_trend_candidate"],
    }).notNull(),
    referenceJson: text("reference_json").notNull(),
    note: text("note"),
    createdVia: text("created_via").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("hypothesis_evidence_hypothesis_id_idx").on(table.hypothesisId)]
);

// Phase 10 slice 4 (docs/roadmap/plans/PHASE_10_SLICE_4_PLAN.md §4) -- append-only, one row per
// AI generation call that was actually saved as a hypothesis. Distinct from `createdVia` (mcp/
// cli/web_ui -- transport), which cannot represent "AI authored this text, a human may have then
// edited it" -- mirrors `aiLocalizationGenerationProvenance`'s own reason for existing as a
// separate table rather than overloading an existing column.
export const hypothesisGenerationProvenance = sqliteTable(
  "hypothesis_generation_provenance",
  {
    id: text("id").primaryKey(),
    hypothesisId: text("hypothesis_id")
      .notNull()
      .references(() => hypotheses.id),
    connectionId: text("connection_id"),
    providerName: text("provider_name").notNull(),
    modelId: text("model_id"),
    generatedStatement: text("generated_statement").notNull(),
    finalStatement: text("final_statement").notNull(),
    rationale: text("rationale"),
    evidenceRefCount: integer("evidence_ref_count").notNull(),
    editedBeforeSave: integer("edited_before_save", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("hypothesis_generation_provenance_hypothesis_id_idx").on(table.hypothesisId)]
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
  {
    version: 19,
    description:
      "videos.duration_seconds -- Phase 7 slice K, owner spec §10 comparable-content 'similar duration' filter (docs/AGENT_OPERATIONS_INTERFACE.md §4g)",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE videos ADD COLUMN duration_seconds INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 20,
    description:
      "agent_connections, agent_capability_zones -- multi-agent responsibility zones (docs/roadmap/plans/AGENT_ZONES_PLAN.md, BL-091)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS agent_connections (" +
          "id TEXT PRIMARY KEY, " +
          "label TEXT NOT NULL, " +
          "enabled INTEGER NOT NULL DEFAULT 1, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS agent_capability_zones (" +
          "capability_id TEXT PRIMARY KEY, " +
          "assigned_connection_id TEXT REFERENCES agent_connections(id))"
      );
    },
  },
  {
    version: 21,
    description:
      "videos.publish_at -- owner instruction 2026-09-26, Content tab's scheduled-publish date for a still-private video (YouTube's status.publishAt, distinct from snippet.publishedAt)",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE videos ADD COLUMN publish_at TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 22,
    description:
      "research_channels, research_evidence -- Phase 9 slice 1 manually-seeded market-research watchlist (docs/roadmap/plans/PHASE_9_PLAN.md), structurally separate from channels/videos: these rows describe channels the operator does not own",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS research_channels (" +
          "id TEXT PRIMARY KEY, " +
          "handle_or_url TEXT, " +
          "reason TEXT NOT NULL, " +
          "created_via TEXT NOT NULL, " +
          "added_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS research_evidence (" +
          "id TEXT PRIMARY KEY, " +
          "research_channel_id TEXT NOT NULL REFERENCES research_channels(id), " +
          "observation TEXT NOT NULL, " +
          "source TEXT NOT NULL, " +
          "confidence TEXT, " +
          "created_via TEXT NOT NULL, " +
          "collected_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS research_evidence_research_channel_id_idx ON research_evidence(research_channel_id)"
      );
    },
  },
  {
    version: 23,
    description:
      "market_channel_snapshots, market_video_snapshots -- Phase 9 slice 9A structured, append-only public observations (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md), referencing research_channels; never upserted by any natural key",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_channel_snapshots (" +
          "id TEXT PRIMARY KEY, " +
          "research_channel_id TEXT NOT NULL REFERENCES research_channels(id), " +
          "observed_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "subscriber_count INTEGER, " +
          "view_count INTEGER, " +
          "video_count INTEGER, " +
          "hidden_subscriber_count INTEGER NOT NULL DEFAULT 0, " +
          "source TEXT NOT NULL, " +
          "created_via TEXT NOT NULL)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_channel_snapshots_research_channel_id_idx ON market_channel_snapshots(research_channel_id)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_video_snapshots (" +
          "id TEXT PRIMARY KEY, " +
          "research_channel_id TEXT NOT NULL REFERENCES research_channels(id), " +
          "video_id TEXT NOT NULL, " +
          "observed_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "view_count INTEGER, " +
          "like_count INTEGER, " +
          "comment_count INTEGER, " +
          "published_at INTEGER, " +
          "source TEXT NOT NULL, " +
          "created_via TEXT NOT NULL)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_video_snapshots_research_channel_id_idx ON market_video_snapshots(research_channel_id)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_video_snapshots_video_id_idx ON market_video_snapshots(video_id)"
      );
    },
  },
  {
    version: 24,
    description:
      "research_channels.last_auto_collected_at/collection_claimed_at + market_intelligence_collection_runs -- Phase 9 slice 9B repeatable refresh staleness tracking, mark-then-run concurrency claim, and append-only collection-run audit/quota log (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md)",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE research_channels ADD COLUMN last_auto_collected_at INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
      try {
        await client.execute("ALTER TABLE research_channels ADD COLUMN collection_claimed_at INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_intelligence_collection_runs (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "research_channel_id TEXT NOT NULL REFERENCES research_channels(id), " +
          "ran_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "status TEXT NOT NULL, " +
          "units_spent INTEGER NOT NULL, " +
          "videos_requested INTEGER, " +
          "videos_returned INTEGER, " +
          "error_message TEXT)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_intelligence_collection_runs_research_channel_id_idx ON market_intelligence_collection_runs(research_channel_id)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_intelligence_collection_runs_ran_at_idx ON market_intelligence_collection_runs(ran_at)"
      );
    },
  },
  {
    version: 25,
    description:
      "market_discovery_candidates + market_discovery_runs -- Phase 9 slice 9C search.list-based discovery, candidate lifecycle, and its own append-only quota-ledger counterpart to market_intelligence_collection_runs (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_discovery_candidates (" +
          "id TEXT PRIMARY KEY, " +
          "title TEXT NOT NULL, " +
          "status TEXT NOT NULL, " +
          "discovery_source TEXT NOT NULL, " +
          "discovery_query TEXT NOT NULL, " +
          "reason_discovered TEXT, " +
          "first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "created_via TEXT NOT NULL)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_discovery_runs (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "query TEXT NOT NULL, " +
          "ran_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "status TEXT NOT NULL, " +
          "units_spent INTEGER NOT NULL, " +
          "candidates_found INTEGER, " +
          "candidates_new INTEGER, " +
          "error_message TEXT)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_discovery_runs_ran_at_idx ON market_discovery_runs(ran_at)"
      );
    },
  },
  {
    // This migration's body was edited in place (the named-index fix below, commit 2c3662f) after
    // it was first introduced (commit e1b43bf) rather than shipped as a new version -- normally
    // forbidden by this file's own additive-only schema-versioning discipline (docs/decisions/0002),
    // since the migration runner only re-applies a version once, via `version > stampedBeforeMigrations`.
    // This was NOT actually safe in practice: this development machine's own real, production
    // database (never a disposable copy -- see RISK-63, docs/TECHNICAL_DEBT.md) had already run this
    // migration's ORIGINAL body (inline `UNIQUE(...)` constraint) before this edit landed, via a
    // `next build` invocation missing its `NODE_TEST_CONTEXT=1` guard (RISK-63's own root cause).
    // That real database is confirmed (`sqlite3 -readonly ... "PRAGMA index_list/index_info"`,
    // 2026-09-27) to still carry the old SQLite-auto-named index for the 3-column UNIQUE constraint
    // (`sqlite_autoindex_market_topic_assignments_2`, origin `u` -- `_1` is the primary key's own
    // autoindex on `id`, origin `pk`, a different index entirely), permanently diverging
    // from every fresh v26 database created after this fix, which gets the intended
    // `market_topic_assignments_unique_idx` name instead -- a naming-only divergence (both enforce
    // the identical constraint), tracked as part of RISK-63, not silently accepted here. See RISK-63
    // for the full history and the owner's remediation options. This is not a repeatable pattern:
    // every later correction on this branch (e.g. `market_research_requests` below) got its own new
    // version number, exactly as this file's discipline requires.
    version: 26,
    description:
      "market_topics + market_topic_assignments + market_trend_candidates + market_trend_evidence -- Phase 9 slice 9E topic model and manual/structural trend candidates (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_topics (" +
          "id TEXT PRIMARY KEY, " +
          "name TEXT NOT NULL UNIQUE, " +
          "created_via TEXT NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_topic_assignments (" +
          "id TEXT PRIMARY KEY, " +
          "topic_id TEXT NOT NULL REFERENCES market_topics(id), " +
          "subject_type TEXT NOT NULL, " +
          "subject_id TEXT NOT NULL, " +
          "source TEXT NOT NULL, " +
          "created_via TEXT NOT NULL, " +
          "assigned_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_topic_assignments_topic_id_idx ON market_topic_assignments(topic_id)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_topic_assignments_subject_idx ON market_topic_assignments(subject_type, subject_id)"
      );
      // A separate, explicitly-named CREATE UNIQUE INDEX -- not an inline table-level UNIQUE(...)
      // constraint -- so the index name matches the Drizzle schema's own `uniqueIndex(...)`
      // declaration exactly (found by independent code review: an inline constraint lets SQLite
      // auto-name the index (e.g. `sqlite_autoindex_market_topic_assignments_2`, confirmed the
      // actual real name this table's real inline constraint got -- `_1` here would have been the
      // primary key's own autoindex, a different index), silently diverging
      // from `market_topic_assignments_unique_idx` and breaking any future maintenance code that
      // assumes the declared name exists). Mirrors this file's own established precedent (e.g.
      // `analytics_weekly_reports_channel_week_idx`).
      await client.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS market_topic_assignments_unique_idx ON market_topic_assignments(topic_id, subject_type, subject_id)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_trend_candidates (" +
          "id TEXT PRIMARY KEY, " +
          "title TEXT NOT NULL, " +
          "description TEXT, " +
          "topic_id TEXT REFERENCES market_topics(id), " +
          "status TEXT NOT NULL, " +
          "first_observed_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "last_observed_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "created_via TEXT NOT NULL)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_trend_evidence (" +
          "id TEXT PRIMARY KEY, " +
          "trend_candidate_id TEXT NOT NULL REFERENCES market_trend_candidates(id), " +
          "evidence_type TEXT NOT NULL, " +
          "reference_id TEXT, " +
          "description TEXT NOT NULL, " +
          "created_via TEXT NOT NULL, " +
          "recorded_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_trend_evidence_trend_candidate_id_idx ON market_trend_evidence(trend_candidate_id)"
      );
    },
  },
  {
    version: 27,
    description:
      "market_research_requests -- Phase 9 slice 9G, part B, agent-created research drafts with a human-only approval gate (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_research_requests (" +
          "id TEXT PRIMARY KEY, " +
          "query TEXT NOT NULL, " +
          "rationale TEXT NOT NULL, " +
          "monitor_duration_days INTEGER, " +
          "status TEXT NOT NULL DEFAULT 'pending', " +
          "created_via TEXT NOT NULL, " +
          "agent_api_version TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "resolved_at INTEGER, " +
          "resolved_reason TEXT, " +
          "candidates_found INTEGER, " +
          "candidates_new INTEGER, " +
          "execution_error TEXT)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_research_requests_status_idx ON market_research_requests(status)"
      );
    },
  },
  {
    version: 28,
    description:
      "market_video_snapshots.title -- Phase 9 slice 9H part C, capturing a field getPublicVideoSnapshots already fetches at zero extra quota cost but 9B's own collector previously discarded (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md)",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE market_video_snapshots ADD COLUMN title TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 29,
    description:
      "hypotheses/experiments/experiment_outcomes -- Phase 10 slice 1, Decision & Experiment Engine manual-entry foundation (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS hypotheses (" +
          "id TEXT PRIMARY KEY, " +
          "channel_id TEXT REFERENCES channels(id), " +
          "statement TEXT NOT NULL, " +
          "evidence_notes TEXT NOT NULL, " +
          "created_by TEXT NOT NULL, " +
          "created_via TEXT NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS experiments (" +
          "id TEXT PRIMARY KEY, " +
          "hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id), " +
          "treatment TEXT NOT NULL, " +
          "control_baseline TEXT NOT NULL, " +
          "success_criteria TEXT NOT NULL, " +
          "stopping_criteria TEXT NOT NULL, " +
          "start_conditions TEXT, " +
          "planned_duration TEXT, " +
          "sample_coverage_constraints TEXT, " +
          "budget_estimate TEXT, " +
          "responsible TEXT NOT NULL, " +
          "status TEXT NOT NULL DEFAULT 'proposed', " +
          "approved_by TEXT, " +
          "approved_at INTEGER, " +
          "created_via TEXT NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS experiments_hypothesis_id_idx ON experiments(hypothesis_id)");
      await client.execute(
        "CREATE TABLE IF NOT EXISTS experiment_outcomes (" +
          "id TEXT PRIMARY KEY, " +
          "experiment_id TEXT NOT NULL REFERENCES experiments(id), " +
          "recorded_by TEXT NOT NULL, " +
          "recorded_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "outcome_data TEXT NOT NULL, " +
          "data_quality_limitations TEXT, " +
          "criteria_met TEXT NOT NULL, " +
          "lessons_learned TEXT, " +
          "created_via TEXT NOT NULL)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS experiment_outcomes_experiment_id_idx ON experiment_outcomes(experiment_id)"
      );
    },
  },
  {
    version: 30,
    description:
      "hypothesis_evidence -- Phase 10 slice 3, structured (validated at creation) references from a hypothesis to real Phase 8/Phase 9 rows, additive alongside the existing free-text evidenceNotes (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS hypothesis_evidence (" +
          "id TEXT PRIMARY KEY, " +
          "hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id), " +
          "source_type TEXT NOT NULL, " +
          "reference_json TEXT NOT NULL, " +
          "note TEXT, " +
          "created_via TEXT NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS hypothesis_evidence_hypothesis_id_idx ON hypothesis_evidence(hypothesis_id)"
      );
    },
  },
  {
    version: 31,
    description:
      "hypothesis_generation_provenance -- Phase 10 slice 4, one row per AI hypothesis-generation call that was saved, recording AI authorship separately from createdVia's transport meaning (docs/roadmap/plans/PHASE_10_SLICE_4_PLAN.md)",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS hypothesis_generation_provenance (" +
          "id TEXT PRIMARY KEY, " +
          "hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id), " +
          "connection_id TEXT, " +
          "provider_name TEXT NOT NULL, " +
          "model_id TEXT, " +
          "generated_statement TEXT NOT NULL, " +
          "final_statement TEXT NOT NULL, " +
          "rationale TEXT, " +
          "evidence_ref_count INTEGER NOT NULL, " +
          "edited_before_save INTEGER NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS hypothesis_generation_provenance_hypothesis_id_idx ON hypothesis_generation_provenance(hypothesis_id)"
      );
    },
  },
  {
    version: 32,
    description:
      "experiments.change_set_id/execution_batch_id/execution_claimed_at -- Phase 10 slice 5, localization-experiment execution via the existing Change Set/Batch pipeline (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md). No FK on change_set_id/execution_batch_id -- change_sets rows are really deleted (RISK-46's discardLocalAndAdoptPeer) and this connection runs with foreign_keys=ON, so an FK here would break that unrelated delete; validated at the application level instead.",
    apply: async (client) => {
      // isDuplicateColumnError tolerance, same as every other ADD-COLUMN migration above
      // (RISK-33) -- required for the pre-versioning re-apply path (a `schema_meta`-less
      // database re-runs every migration from v1, including ones that already succeeded).
      for (const statement of [
        "ALTER TABLE experiments ADD COLUMN change_set_id TEXT",
        "ALTER TABLE experiments ADD COLUMN execution_batch_id TEXT",
        "ALTER TABLE experiments ADD COLUMN execution_claimed_at INTEGER",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 33,
    description:
      "channel_workspaces -- Phase 11, per-device per-channel local production-workspace path (docs/roadmap/plans/PHASE_11_PLAN.md). Device-local: excluded from SNAPSHOT_TRANSFERRED_TABLES and sync-gateway, keyed on the bootstrap deviceId.",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS channel_workspaces (" +
          "device_id TEXT NOT NULL, " +
          "channel_id TEXT NOT NULL, " +
          "path TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "PRIMARY KEY (device_id, channel_id))"
      );
    },
  },
  {
    version: 34,
    description:
      "agent_channel_tokens -- Phase 12, channel-bound agent tokens (docs/roadmap/plans/PHASE_12_PLAN.md slice 12.1). SHA-256 hash only; device-local (excluded from SNAPSHOT_TRANSFERRED_TABLES and sync-gateway).",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS agent_channel_tokens (" +
          "id TEXT PRIMARY KEY, " +
          "channel_id TEXT NOT NULL, " +
          "user_id TEXT NOT NULL, " +
          "token_hash TEXT NOT NULL UNIQUE, " +
          "label TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "revoked_at INTEGER)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS agent_channel_tokens_channel_id_idx ON agent_channel_tokens(channel_id)"
      );
    },
  },
  {
    version: 35,
    description:
      "channel_record_assignments -- Phase 12 slice 12.4 (owner decision D1): per-channel assignment of globally collected market records (docs/roadmap/plans/PHASE_12_PLAN.md). Travels with device handoff.",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS channel_record_assignments (" +
          "channel_id TEXT NOT NULL, " +
          "record_kind TEXT NOT NULL, " +
          "record_id TEXT NOT NULL, " +
          "assigned_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "PRIMARY KEY (channel_id, record_kind, record_id))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS channel_record_assignments_record_idx ON channel_record_assignments(record_kind, record_id)"
      );
    },
  },
  {
    version: 36,
    description:
      "snapshot_lineage.content_fingerprint + ancestors_json -- automatic device sync (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §2/§3.1): what this device's transferred tables looked like at its lineage head, and that head's ancestry. Device-local.",
    apply: async (client) => {
      for (const column of ["content_fingerprint", "ancestors_json"]) {
        try {
          await client.execute(`ALTER TABLE snapshot_lineage ADD COLUMN ${column} TEXT`);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 37,
    description:
      "topic_wikipedia_articles + wikipedia_pageviews_daily -- Phase 13 slice 13.8 (docs/roadmap/plans/PHASE_13_PLAN.md): Wikipedia articles linked to Research topics and their daily page views (Wikimedia, not YouTube data).",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS topic_wikipedia_articles (" +
          "id TEXT PRIMARY KEY, " +
          "topic_id TEXT NOT NULL REFERENCES market_topics(id) ON DELETE CASCADE, " +
          "project TEXT NOT NULL, " +
          "article TEXT NOT NULL, " +
          "created_via TEXT NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS topic_wikipedia_articles_unique ON topic_wikipedia_articles(topic_id, project, article)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS wikipedia_pageviews_daily (" +
          "project TEXT NOT NULL, " +
          "article TEXT NOT NULL, " +
          "date TEXT NOT NULL, " +
          "views INTEGER NOT NULL, " +
          "PRIMARY KEY (project, article, date))"
      );
    },
  },
  {
    version: 38,
    description:
      "reporting_jobs + reporting_report_files + channel_reach_daily -- BL-114 (docs/decisions/0014-youtube-reporting-api-gateway-child.md): the YouTube Reporting API job per channel, the ledger of downloaded report files, and thumbnail impressions/CTR per video per day from the Reach basic report.",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS reporting_jobs (" +
          "channel_id TEXT NOT NULL, " +
          "report_type_id TEXT NOT NULL, " +
          "job_id TEXT NOT NULL, " +
          "job_name TEXT NOT NULL, " +
          "job_created_at TEXT, " +
          "last_checked_at INTEGER, " +
          "PRIMARY KEY (channel_id, report_type_id))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS reporting_report_files (" +
          "report_id TEXT PRIMARY KEY, " +
          "channel_id TEXT NOT NULL, " +
          "report_type_id TEXT NOT NULL, " +
          "job_id TEXT NOT NULL, " +
          "start_time TEXT NOT NULL, " +
          "end_time TEXT NOT NULL, " +
          "create_time TEXT NOT NULL, " +
          "row_count INTEGER NOT NULL, " +
          "status TEXT NOT NULL, " +
          "imported_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS reporting_report_files_period_idx ON reporting_report_files(channel_id, report_type_id, start_time, end_time)"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS channel_reach_daily (" +
          "channel_id TEXT NOT NULL, " +
          "date TEXT NOT NULL, " +
          "video_id TEXT NOT NULL, " +
          "impressions INTEGER NOT NULL, " +
          "ctr REAL, " +
          "source_report_id TEXT NOT NULL, " +
          "PRIMARY KEY (channel_id, date, video_id))"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS channel_reach_daily_source_idx ON channel_reach_daily(source_report_id)"
      );
    },
  },
  {
    version: 39,
    description:
      "channels.expected_default_language / expected_default_audio_language -- per-channel expected language baseline (owner instruction 2026-10-02)",
    apply: async (client) => {
      for (const column of ["expected_default_language", "expected_default_audio_language"]) {
        try {
          await client.execute(`ALTER TABLE channels ADD COLUMN ${column} TEXT`);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 40,
    description:
      "reporting_sync_attempts -- BL-114: last Reporting API sync attempt per channel (time, outcome, error, failed files), so the Analytics card can show real status and a failed attempt is not invisible",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS reporting_sync_attempts (" +
          "channel_id TEXT NOT NULL, " +
          "report_type_id TEXT NOT NULL, " +
          "attempted_at INTEGER NOT NULL, " +
          "outcome TEXT NOT NULL, " +
          "error TEXT, " +
          "files_listed INTEGER NOT NULL DEFAULT 0, " +
          "files_imported INTEGER NOT NULL DEFAULT 0, " +
          "failures_json TEXT, " +
          "PRIMARY KEY (channel_id, report_type_id))"
      );
    },
  },
  {
    version: 41,
    description:
      "users.refresh_token_issued_at -- BL-115: when Google issued the stored refresh token, for the dashboard's connection-health / re-login prompt (NULL = unknown for existing rows)",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE users ADD COLUMN refresh_token_issued_at INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 42,
    description:
      "quota_ledger -- BL-117: one row per YouTube Data/Analytics API call (time, method, quota units, outcome, which work it belonged to), for the Settings quota-history popup and the batch quota guard. Device-local.",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS quota_ledger (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "occurred_at INTEGER NOT NULL, " +
          "service TEXT NOT NULL, " +
          "method TEXT NOT NULL, " +
          "units INTEGER, " +
          "outcome TEXT NOT NULL, " +
          "context_kind TEXT, " +
          "context_id TEXT, " +
          "context_label TEXT)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS quota_ledger_occurred_idx ON quota_ledger(occurred_at)");
    },
  },
  {
    version: 43,
    description: "batches.split_into_json -- BL-117: ids of the batches a never-executed batch was split into for quota",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE batches ADD COLUMN split_into_json TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 44,
    description: "channels.published_at -- BL-118: the channel's creation time on YouTube, for the analytics channel start date",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE channels ADD COLUMN published_at TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 45,
    description:
      "channel_metrics_daily + analytics_video_history + analytics_collection_runs.channel_level -- BL-118: channel-level daily totals stored locally, per-video history coverage, and a flag on runs that collected channel totals",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS channel_metrics_daily (" +
          "channel_id TEXT NOT NULL, " +
          "metric_date TEXT NOT NULL, " +
          "metric_name TEXT NOT NULL, " +
          "metric_value REAL NOT NULL, " +
          "collected_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "PRIMARY KEY (channel_id, metric_date, metric_name))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS analytics_video_history (" +
          "video_id TEXT PRIMARY KEY, " +
          "channel_id TEXT NOT NULL, " +
          "history_through TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      try {
        await client.execute("ALTER TABLE analytics_collection_runs ADD COLUMN channel_level INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 46,
    description:
      "workspace_export_files -- ledger of the research export files the Manager wrote into a channel workspace, so it can delete the expired ones itself",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS workspace_export_files (" +
          "id TEXT PRIMARY KEY, " +
          "channel_id TEXT NOT NULL, " +
          "exports_dir TEXT NOT NULL, " +
          "file_name TEXT NOT NULL, " +
          "dataset TEXT NOT NULL, " +
          "format TEXT NOT NULL, " +
          "row_count INTEGER NOT NULL, " +
          "created_at INTEGER NOT NULL, " +
          "expires_at INTEGER, " +
          "deleted_at INTEGER)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS workspace_export_files_expires_at_idx ON workspace_export_files (expires_at)");
    },
  },
  {
    version: 47,
    description:
      "market_video_snapshots.duration_seconds + live_broadcast_content and videos.live_broadcast_content -- operator request 2026-10-04: video length and live/upcoming state in research and own-video exports; existing rows stay NULL (unknown), never 0",
    apply: async (client) => {
      for (const statement of [
        "ALTER TABLE market_video_snapshots ADD COLUMN duration_seconds INTEGER",
        "ALTER TABLE market_video_snapshots ADD COLUMN live_broadcast_content TEXT",
        "ALTER TABLE videos ADD COLUMN live_broadcast_content TEXT",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 48,
    description:
      "research_channels depth settings + collection progress (max_videos_per_channel, published_after, videos_complete, videos_complete_reason, videos_next_page_token, videos_cap_at_run, videos_published_after_at_run) and market_intelligence_collection_runs.feed_fallback -- operator request 2026-10-04: collect competitor uploads deeper than 50 videos; existing rows keep NULL/false and behave exactly as before",
    apply: async (client) => {
      for (const statement of [
        "ALTER TABLE research_channels ADD COLUMN max_videos_per_channel INTEGER",
        "ALTER TABLE research_channels ADD COLUMN published_after TEXT",
        "ALTER TABLE research_channels ADD COLUMN videos_complete INTEGER",
        "ALTER TABLE research_channels ADD COLUMN videos_complete_reason TEXT",
        "ALTER TABLE research_channels ADD COLUMN videos_next_page_token TEXT",
        "ALTER TABLE research_channels ADD COLUMN videos_cap_at_run INTEGER",
        "ALTER TABLE research_channels ADD COLUMN videos_published_after_at_run TEXT",
        "ALTER TABLE market_intelligence_collection_runs ADD COLUMN feed_fallback INTEGER NOT NULL DEFAULT 0",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 49,
    description:
      "market_collection_requests -- agent-created requests to collect watchlist channels, approved by a human in the Research tab (docs/decisions/0021-agent-collection-requests.md); additive new table, existing data untouched",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS market_collection_requests (" +
          "id TEXT PRIMARY KEY, " +
          "channel_ids_json TEXT NOT NULL, " +
          "reason TEXT NOT NULL, " +
          "status TEXT NOT NULL DEFAULT 'pending', " +
          "estimate_json TEXT NOT NULL, " +
          "created_via TEXT NOT NULL, " +
          "agent_api_version TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "approved_at INTEGER, " +
          "approved_by_user_id TEXT, " +
          "resolved_at INTEGER, " +
          "resolved_reason TEXT, " +
          "result_json TEXT, " +
          "units_spent_total INTEGER, " +
          "error TEXT)"
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS market_collection_requests_status_idx ON market_collection_requests(status)"
      );
    },
  },
  {
    version: 50,
    description:
      "media_credentials -- encrypted RunPod / S3 API keys entered in Settings → Media, key file per device (Phase 14, docs/roadmap/plans/PHASE_14_PLAN.md §2.9); additive new table, existing data untouched",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_credentials (" +
          "id TEXT PRIMARY KEY, " +
          "ciphertext TEXT NOT NULL, " +
          "iv TEXT NOT NULL, " +
          "auth_tag TEXT NOT NULL, " +
          "runpod_key_prefix TEXT NOT NULL, " +
          "s3_access_key_id TEXT, " +
          "verified_at INTEGER, " +
          "updated_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
    },
  },
  {
    version: 51,
    description:
      "media_sessions -- RunPod pod sessions approved by a human, watched and always terminated (Phase 14 slice 2, docs/roadmap/plans/PHASE_14_PLAN.md §2.3); additive new table, existing data untouched",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_sessions (" +
          "id TEXT PRIMARY KEY, " +
          "channel_id TEXT NOT NULL, " +
          "status TEXT NOT NULL DEFAULT 'pending', " +
          "open_slot INTEGER, " +
          "requested_by TEXT NOT NULL, " +
          "reason TEXT, " +
          "max_minutes INTEGER NOT NULL, " +
          "max_usd REAL, " +
          "estimate_usd REAL NOT NULL, " +
          "fits_today INTEGER NOT NULL, " +
          "cost_per_hr REAL, " +
          "gpu_type_id TEXT, " +
          "datacenter_id TEXT, " +
          "pod_id TEXT, " +
          "comfy_ui_proxy_url TEXT, " +
          "token_ciphertext TEXT, " +
          "token_iv TEXT, " +
          "token_auth_tag TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "approved_at INTEGER, " +
          "approved_by_user_id TEXT, " +
          "started_at INTEGER, " +
          "ready_at INTEGER, " +
          "last_activity_at INTEGER, " +
          "stopped_at INTEGER, " +
          "seconds_used INTEGER, " +
          "usd_charged REAL, " +
          "stop_reason TEXT, " +
          "error TEXT)"
      );
      await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS media_sessions_open_slot_idx ON media_sessions(open_slot)");
      await client.execute("CREATE INDEX IF NOT EXISTS media_sessions_status_idx ON media_sessions(status)");
    },
  },
  {
    version: 52,
    description:
      "media_workflow_templates, media_jobs, media_exchange_files -- ComfyUI workflow templates, generation jobs and the pulled-file ledger (Phase 14 slice 3, docs/roadmap/plans/PHASE_14_PLAN.md §2.4); additive new tables, existing data untouched",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_workflow_templates (" +
          "id TEXT PRIMARY KEY, " +
          "name TEXT NOT NULL, " +
          "version INTEGER NOT NULL DEFAULT 1, " +
          "description TEXT, " +
          "workflow_json TEXT NOT NULL, " +
          "parameters_json TEXT NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "updated_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_jobs (" +
          "id TEXT PRIMARY KEY, " +
          "session_id TEXT NOT NULL, " +
          "channel_id TEXT NOT NULL, " +
          "template_id TEXT NOT NULL, " +
          "template_version INTEGER NOT NULL, " +
          "params_json TEXT NOT NULL, " +
          "status TEXT NOT NULL DEFAULT 'queued', " +
          "created_by TEXT NOT NULL, " +
          "prompt_id TEXT, " +
          "outputs_json TEXT, " +
          "asset_ids_json TEXT, " +
          "error TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "submitted_at INTEGER, " +
          "finished_at INTEGER)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS media_jobs_session_idx ON media_jobs(session_id)");
      await client.execute("CREATE INDEX IF NOT EXISTS media_jobs_status_idx ON media_jobs(status)");
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_exchange_files (" +
          "remote_key TEXT PRIMARY KEY, " +
          "job_id TEXT NOT NULL, " +
          "local_path TEXT NOT NULL, " +
          "bytes INTEGER NOT NULL, " +
          "sha256 TEXT NOT NULL, " +
          "pulled_at INTEGER NOT NULL, " +
          "remote_deleted_at INTEGER)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS media_exchange_files_job_idx ON media_exchange_files(job_id)");
    },
  },
  {
    version: 53,
    description:
      "media_sessions.stopping_outcome -- the terminal status a `stopping` session is heading for, so a retried stop reports failed/interrupted/done truthfully (Phase 14 review round 6); additive nullable column, existing rows untouched",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE media_sessions ADD COLUMN stopping_outcome TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 54,
    description:
      "media_sessions.last_seen_alive_at -- when the app last saw the session's pod alive, so a pod already gone at a reconciliation is billed up to then, not up to the reboot (Phase 14 review round 7); additive nullable column, existing rows untouched",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE media_sessions ADD COLUMN last_seen_alive_at INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 55,
    description:
      "media_workflow_templates.output_node_ids_json + node_count -- derived at import/update so listing templates never re-parses every graph (Phase 14 review round 8); additive nullable columns, rows written earlier fall back to parsing",
    apply: async (client) => {
      for (const statement of ["ALTER TABLE media_workflow_templates ADD COLUMN output_node_ids_json TEXT", "ALTER TABLE media_workflow_templates ADD COLUMN node_count INTEGER"]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 56,
    description:
      "creative_assets(channel_id, reference_kind, reference_value) index -- the media job pipeline looks an asset up by its local path per pulled output (Phase 14 review round 14); additive index, data untouched",
    apply: async (client) => {
      // A published snapshot has no `creative_assets` (device-local, scrubbed), and the 50..58 collision guard below
      // re-runs this migration on such a staged copy (owner's Windows computer, 2026-10-06): nothing to index there.
      const table = (await client.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'creative_assets'")) as { rows: unknown[] };
      if (table.rows.length === 0) return;
      await client.execute("CREATE INDEX IF NOT EXISTS creative_assets_reference_idx ON creative_assets(channel_id, reference_kind, reference_value)");
    },
  },
  {
    version: 57,
    description:
      "media_sessions.terminate_sent_at -- when the app's terminate DELETE went through, so a retried stop whose DELETE answers 404 bills to that moment (Phase 14 review round 19); additive nullable column, existing rows untouched",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE media_sessions ADD COLUMN terminate_sent_at INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 58,
    description:
      "media_sessions_open_slot_idx becomes a plain index -- concurrent generation sessions (Phase 14 slice 6, owner 2026-10-05); the concurrency bound moves to the guarded approve UPDATE; rows untouched",
    apply: async (client) => {
      await client.execute("DROP INDEX IF EXISTS media_sessions_open_slot_idx");
      await client.execute("CREATE INDEX IF NOT EXISTS media_sessions_open_slot_idx ON media_sessions(open_slot)");
    },
  },
  {
    version: 59,
    description:
      "logical_paths + logical_path_values -- Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F1; numbered 50 on dev, renumbered 59 when Phase 14 -- whose 50–58 a real database already carried -- was merged): named paths with a per-device value. Device-local: excluded from SNAPSHOT_TRANSFERRED_TABLES and sync-gateway. Seeds only the two initial NAMES (no values); additive, existing data untouched",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS logical_paths (" +
          "name TEXT PRIMARY KEY, " +
          "audience TEXT NOT NULL, " +
          "description TEXT NOT NULL DEFAULT '', " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS logical_path_values (" +
          "device_id TEXT NOT NULL, " +
          "name TEXT NOT NULL, " +
          "path TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "PRIMARY KEY (device_id, name))"
      );
      await client.execute(
        "INSERT OR IGNORE INTO logical_paths (name, audience, description) VALUES " +
          "('factory_shared', 'all_agents', 'Shared Registry folder, read-only for channels'), " +
          "('developer_exchange', 'factory_only', 'Factory Operator <-> Developer exchange folder')"
      );
    },
  },
  {
    version: 60,
    description:
      "factory_agent_tokens -- Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F2; numbered 51 on dev, renumbered 60 at the Phase 14 merge): the Factory Operator role's own agent token, SHA-256 hash only, no channel binding. Device-local (excluded from SNAPSHOT_TRANSFERRED_TABLES and sync-gateway); additive, existing data untouched",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS factory_agent_tokens (" +
          "id TEXT PRIMARY KEY, " +
          "token_hash TEXT NOT NULL UNIQUE, " +
          "label TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "revoked_at INTEGER)"
      );
      // A database that already holds several active rows (only possible if two overlapping issue calls raced before this
      // index existed) must not wedge boot: keep the newest active token, revoke the others, THEN add the index.
      await client.execute(
        "UPDATE factory_agent_tokens SET revoked_at = unixepoch() WHERE revoked_at IS NULL AND rowid NOT IN " +
          "(SELECT MAX(rowid) FROM factory_agent_tokens WHERE revoked_at IS NULL)"
      );
      // At most ONE active row, enforced by the database (independent review): two overlapping issue calls can then
      // never leave two valid tokens -- the loser fails closed instead of the Settings card hiding a live second token.
      await client.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS factory_agent_tokens_one_active_idx ON factory_agent_tokens((1)) WHERE revoked_at IS NULL"
      );
    },
  },
  {
    version: 61,
    description:
      "media_control_events + media_exchange_inputs + media_workflow_templates.source/registry_sha256 -- factory control of media (BL-132, docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md): an append-only audit of model/template actions with their actor, the ledger of job input files uploaded to the volume, and which templates come from the factory registry. Device-local (excluded from SNAPSHOT_TRANSFERRED_TABLES); additive, existing rows become source 'owner'",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_control_events (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "at INTEGER NOT NULL, " +
          "actor TEXT NOT NULL, " +
          "action TEXT NOT NULL, " +
          "subject TEXT NOT NULL, " +
          "details_json TEXT)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS media_control_events_at_idx ON media_control_events(at)");
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_exchange_inputs (" +
          "remote_key TEXT PRIMARY KEY, " +
          "job_id TEXT NOT NULL, " +
          "parameter TEXT NOT NULL, " +
          "source_path TEXT NOT NULL, " +
          "bytes INTEGER NOT NULL, " +
          "sha256 TEXT NOT NULL, " +
          "uploaded_at INTEGER NOT NULL, " +
          "remote_deleted_at INTEGER)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS media_exchange_inputs_job_idx ON media_exchange_inputs(job_id)");
      // The registry folder is a logical path like the two seeded at v59: a NAME only, each device sets its own value.
      await client.execute(
        "INSERT OR IGNORE INTO logical_paths (name, audience, description) VALUES " +
          "('media_templates', 'factory_only', 'Factory media template registry (index.json + <templateId>.v<version>.json)')"
      );
      for (const statement of [
        "ALTER TABLE media_workflow_templates ADD COLUMN source TEXT NOT NULL DEFAULT 'owner'",
        "ALTER TABLE media_workflow_templates ADD COLUMN registry_sha256 TEXT",
        "ALTER TABLE media_workflow_templates ADD COLUMN models_json TEXT",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 62,
    description:
      "completes v61 for a database stamped 61 by an intermediate BL-132 development build (one real database was: it got the v61 tables and source/registry_sha256 but not media_workflow_templates.models_json or the media_templates logical-path name, which v61 gained later). Re-applies those two idempotently; a database that ran the final v61 is unchanged",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE media_workflow_templates ADD COLUMN models_json TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
      await client.execute(
        "INSERT OR IGNORE INTO logical_paths (name, audience, description) VALUES " +
          "('media_templates', 'factory_only', 'Factory media template registry (index.json + <templateId>.v<version>.json)')"
      );
    },
  },
  {
    version: 63,
    description:
      "media_sessions.release_when_done -- BL-135 (ADR 0023 amendment 2): a session requested with releaseWhenDone is stopped by the watcher once every job of it is finished and none followed for a minute. Additive nullable column; existing sessions behave as before",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE media_sessions ADD COLUMN release_when_done INTEGER");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 64,
    description:
      "media_sessions.approved_by/gpu_plan_json/capacity_* + media_capacity_attempts + media_workflow_templates.gpu_json -- Factory Operator GPU sessions, GPU fallback and the capacity wait (BL-133, docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md). Device-local (excluded from SNAPSHOT_TRANSFERRED_TABLES); additive, existing sessions behave as before",
    apply: async (client) => {
      for (const statement of [
        "ALTER TABLE media_sessions ADD COLUMN approved_by TEXT",
        "ALTER TABLE media_sessions ADD COLUMN gpu_plan_json TEXT",
        "ALTER TABLE media_sessions ADD COLUMN capacity_attempts INTEGER",
        "ALTER TABLE media_sessions ADD COLUMN capacity_next_attempt_at INTEGER",
        "ALTER TABLE media_sessions ADD COLUMN capacity_wait_until INTEGER",
        "ALTER TABLE media_workflow_templates ADD COLUMN gpu_json TEXT",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
      await client.execute(
        "CREATE TABLE IF NOT EXISTS media_capacity_attempts (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "at INTEGER NOT NULL, " +
          "session_id TEXT NOT NULL, " +
          "datacenter_id TEXT, " +
          "gpu_type_id TEXT NOT NULL, " +
          "price_per_hr REAL, " +
          "result TEXT NOT NULL, " +
          "detail TEXT)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS media_capacity_attempts_at_idx ON media_capacity_attempts(at)");
    },
  },
  {
    version: 65,
    description:
      "market_discovery_candidates.subscriber_count/hidden_subscriber_count/video_count/view_count/channel_published_at/stats_observed_at/match_query/match_video_count/match_view_count + market_discovery_runs.pool_units_spent -- BL-145 (owner, Telegram 2026-10-07): each search result's public counts from one channels.list call. Additive nullable columns (existing candidates: unknown); blanked with the title after 30 days",
    apply: async (client) => {
      for (const statement of [
        "ALTER TABLE market_discovery_candidates ADD COLUMN subscriber_count INTEGER",
        "ALTER TABLE market_discovery_candidates ADD COLUMN hidden_subscriber_count INTEGER",
        "ALTER TABLE market_discovery_candidates ADD COLUMN video_count INTEGER",
        "ALTER TABLE market_discovery_candidates ADD COLUMN view_count INTEGER",
        "ALTER TABLE market_discovery_candidates ADD COLUMN channel_published_at TEXT",
        "ALTER TABLE market_discovery_candidates ADD COLUMN stats_observed_at INTEGER",
        "ALTER TABLE market_discovery_candidates ADD COLUMN match_query TEXT",
        "ALTER TABLE market_discovery_candidates ADD COLUMN match_video_count INTEGER",
        "ALTER TABLE market_discovery_candidates ADD COLUMN match_view_count INTEGER",
        "ALTER TABLE market_discovery_runs ADD COLUMN pool_units_spent INTEGER",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 66,
    description:
      "generation_plans + generation_plan_results + generation_plan_events, media_jobs.plan_id/plan_stage_id/plan_item_key/plan_seed, media_sessions.plan_id -- BL-143 (ADR 0029, FO-REQ-0006, owner 2026-10-07): generation plans; in-app progress is read from the jobs. Additive, device-local",
    apply: async (client) => {
      await client.execute(`CREATE TABLE IF NOT EXISTS generation_plans (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        budget_usd REAL,
        budget_gpu_minutes REAL,
        note TEXT,
        definition_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      )`);
      await client.execute("CREATE INDEX IF NOT EXISTS generation_plans_status_idx ON generation_plans (status)");
      await client.execute(`CREATE TABLE IF NOT EXISTS generation_plan_results (
        plan_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        attempt_ref TEXT NOT NULL,
        result TEXT NOT NULL,
        reported_by TEXT NOT NULL,
        note TEXT,
        rating INTEGER,
        reasons_json TEXT,
        markers_json TEXT,
        audition_file TEXT,
        checks_json TEXT,
        metrics_json TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (plan_id, stage_id, item_key, attempt_ref)
      )`);
      await client.execute("CREATE INDEX IF NOT EXISTS generation_plan_results_at_idx ON generation_plan_results (plan_id, at)");
      await client.execute(`CREATE TABLE IF NOT EXISTS generation_plan_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT
      )`);
      await client.execute("CREATE INDEX IF NOT EXISTS generation_plan_events_plan_idx ON generation_plan_events (plan_id, at)");
      for (const statement of [
        "ALTER TABLE media_jobs ADD COLUMN plan_id TEXT",
        "ALTER TABLE media_jobs ADD COLUMN plan_stage_id TEXT",
        "ALTER TABLE media_jobs ADD COLUMN plan_item_key TEXT",
        "ALTER TABLE media_jobs ADD COLUMN plan_seed INTEGER",
        "ALTER TABLE media_sessions ADD COLUMN plan_id TEXT",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
      await client.execute("CREATE INDEX IF NOT EXISTS media_jobs_plan_idx ON media_jobs (plan_id)");
    },
  },
  {
    version: 67,
    description:
      "generation_plan_peer_verdicts -- BL-143 phase 2 (owner 2026-10-07): verdicts given on this device for another device's generation plans, carried in this device's plans report until that device applies them. Additive, device-local",
    apply: async (client) => {
      await client.execute(`CREATE TABLE IF NOT EXISTS generation_plan_peer_verdicts (
        verdict_id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        owner_device_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        attempt_ref TEXT NOT NULL,
        result TEXT NOT NULL,
        rating INTEGER,
        reasons_json TEXT,
        markers_json TEXT,
        note TEXT,
        at TEXT NOT NULL
      )`);
      await client.execute("CREATE INDEX IF NOT EXISTS generation_plan_peer_verdicts_at_idx ON generation_plan_peer_verdicts (at)");
    },
  },
  {
    version: 68,
    description:
      "generation_plan_results.reference_ids_json -- BL-143 phase 3 (FO-MSG-0009): the plan references (validator's nearest library tracks) of an attempt, for A/B listening. Additive nullable column",
    apply: async (client) => {
      try {
        await client.execute("ALTER TABLE generation_plan_results ADD COLUMN reference_ids_json TEXT");
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    },
  },
  {
    version: 69,
    description:
      "generation_plan_verdict_history -- BL-157 (FO-REQ-0009 §6.4): every owner verdict on this device's plans with the device it was given on (the result row keeps only the newest). Additive, device-local",
    apply: async (client) => {
      await client.execute(`CREATE TABLE IF NOT EXISTS generation_plan_verdict_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        attempt_ref TEXT NOT NULL,
        result TEXT NOT NULL,
        rating INTEGER,
        reasons_json TEXT,
        markers_json TEXT,
        note TEXT,
        device TEXT NOT NULL,
        at TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      )`);
      await client.execute("CREATE INDEX IF NOT EXISTS generation_plan_verdict_history_plan_idx ON generation_plan_verdict_history (plan_id, item_key, attempt_ref)");
    },
  },
  {
    version: 70,
    description:
      "generation_plan_review_claims -- BL-157 (FO-REQ-0009 §6.1/§7.3): this device's 'being reviewed here' claims on a track or a wave, published in its plans report (advisory). Additive, device-local",
    apply: async (client) => {
      await client.execute(`CREATE TABLE IF NOT EXISTS generation_plan_review_claims (
        claim_id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        owner_device_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        item_key TEXT,
        attempt_ref TEXT,
        group_id TEXT,
        since INTEGER NOT NULL,
        until INTEGER NOT NULL
      )`);
      await client.execute("CREATE INDEX IF NOT EXISTS generation_plan_review_claims_plan_idx ON generation_plan_review_claims (owner_device_id, plan_id)");
    },
  },
  {
    version: 71,
    description:
      "media_sessions.min_cuda_version/used_min_cuda_version/host_cuda_version + media_capacity_attempts.host_cuda_version + media_workflow_templates.min_cuda_version -- BL-159 (FO-REQ-0011, docs/roadmap/plans/PER_SESSION_CUDA_PLAN.md): a session's or template's own minimum host CUDA (only raising the owner's setting) and the host's CUDA shown. Additive nullable columns, device-local",
    apply: async (client) => {
      for (const statement of [
        "ALTER TABLE media_sessions ADD COLUMN min_cuda_version TEXT",
        "ALTER TABLE media_sessions ADD COLUMN used_min_cuda_version TEXT",
        "ALTER TABLE media_sessions ADD COLUMN host_cuda_version TEXT",
        "ALTER TABLE media_capacity_attempts ADD COLUMN host_cuda_version TEXT",
        "ALTER TABLE media_workflow_templates ADD COLUMN min_cuda_version TEXT",
      ]) {
        try {
          await client.execute(statement);
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error;
        }
      }
    },
  },
  {
    version: 72,
    description:
      "producer_agent_tokens + producer_call_log -- BL-161 (FO-REQ-0012, docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3): the read-only Producer role's own agent token (SHA-256 hash only, one active, no channel) and its per-call log. Device-local; additive, existing data untouched",
    apply: async (client) => {
      await client.execute(
        "CREATE TABLE IF NOT EXISTS producer_agent_tokens (" +
          "id TEXT PRIMARY KEY, " +
          "token_hash TEXT NOT NULL UNIQUE, " +
          "label TEXT, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "revoked_at INTEGER)"
      );
      await client.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS producer_agent_tokens_one_active_idx ON producer_agent_tokens((1)) WHERE revoked_at IS NULL"
      );
      await client.execute(
        "CREATE TABLE IF NOT EXISTS producer_call_log (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "at INTEGER NOT NULL, " +
          "tool TEXT NOT NULL, " +
          "channel_id TEXT, " +
          "outcome TEXT NOT NULL, " +
          "error_code TEXT)"
      );
      await client.execute("CREATE INDEX IF NOT EXISTS producer_call_log_at_idx ON producer_call_log (at)");
    },
  },
];

/**
 * Phase 14 ⟷ Factory Operator merge (2026-10-05): both branches had used SCHEMA_MIGRATIONS versions 50/51. A real
 * database already carried Phase 14's 50–58, so those kept their numbers and Factory Operator's two became 59/60.
 * A database stamped 50 or 51 by a pre-merge `dev` build has the Factory Operator tables but NOT Phase 14's, and
 * would otherwise skip Phase 14's 50/51 and wedge at 53 (`ALTER TABLE media_sessions` on a missing table). Such a
 * database is recognised by its stamp in 50..58 with no `media_credentials` table and treated as stamped 49: every
 * migration from 50 to 60 is idempotent (`IF NOT EXISTS`, duplicate-column guards, `INSERT OR IGNORE`), so re-running
 * them converges. Exported for its test.
 */
export async function resolveMergedNumberingCollision(client: Client, foundVersion: number | null): Promise<number | null> {
  if (foundVersion === null || foundVersion < 50 || foundVersion > 58) return foundVersion;
  const media = await client.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_credentials'");
  if (media.rows.length > 0) return foundVersion;
  console.warn(`[db] schema stamped ${foundVersion} without the Phase 14 tables (a pre-merge dev build numbered Factory Operator 50/51); re-running migrations from 50`);
  return 49;
}

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
  await client.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  // WAL allows one writer and many concurrent readers without them blocking each other
  // at the file-lock level, which is what makes two separate connections' transactions
  // interleave safely instead of racing for the same exclusive rollback-journal lock.
  await client.execute("PRAGMA journal_mode = WAL");

  // Reject a database reporting a version newer than this build supports *before* any
  // schema-mutating statement below runs (AC-SCHEMA-04) -- assertSupportedSchemaVersion only
  // ever performs a read.
  const foundVersion = await resolveMergedNumberingCollision(client, await assertSupportedSchemaVersion(client, SCHEMA_CURRENT_VERSION));

  // The `rules` table (auto-playlisting engine, from the project's original pre-rewrite baseline) is retired as of
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

/**
 * Boot-time migration lock (RISK-20), taken ONLY when this boot has migrations to run -- see the
 * comment in `initializeDatabase`. Returns whether the lock was acquired (the caller releases it).
 * Waits for a busy lock (an export takes about a second) and clears a provably dead export's lock;
 * gives up with the original `OperationLockError` after `attempts` waits. Exported for tests.
 */
export async function acquireMigrationLockIfDue(
  client: Client,
  options: { currentVersion?: number; attempts?: number; waitMs?: number } = {}
): Promise<boolean> {
  const currentVersion = options.currentVersion ?? SCHEMA_CURRENT_VERSION;
  const attempts = options.attempts ?? 30;
  const waitMs = options.waitMs ?? 1_000;
  // A failed read counts as "due": the locked path is the conservative one.
  const stampedVersion = await readSchemaVersion(client).catch(() => null);
  if (stampedVersion !== null && stampedVersion >= currentVersion) return false;
  for (let attempt = 0; ; attempt++) {
    try {
      await acquireOperationLock(client, "migration");
      return true;
    } catch (error) {
      if (isMissingTableError(error)) return false;
      if (!(error instanceof OperationLockError) || attempt >= attempts) throw error;
      if (await releaseStaleExportLock(client).catch(() => false)) continue;
      // A holder process that is provably gone (an interrupted import/migration -- never
      // auto-released, decision 2b) will never release this lock by itself, so waiting out the
      // attempts only delays the same failure by `attempts * waitMs`. Fail at once; the operator
      // clears it explicitly from the /recovery page or the `operation-lock` CLI.
      if (error.details.stale) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
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
  //
  // Automatic device sync, cross-system audit (2026-10-01): the lock is taken ONLY when this boot
  // actually has migrations to run. Exports now hold the same lock about once a minute; taking it
  // on every boot made any MCP/CLI process that started during one fail its database
  // initialization for its whole lifetime. A boot with nothing to migrate only runs idempotent
  // `IF NOT EXISTS` DDL, which needs no serialization against export/import. When a migration is
  // due and the lock is busy, wait for it (an export takes about a second) instead of failing.
  const lockAcquired = await acquireMigrationLockIfDue(rawClient);

  // False divergences (BL-139): a device in sync before this boot's migrations stays in sync after
  // them -- every computer applies the same migrations (RISK-89). Both fingerprints come from the
  // pre-migration backup, never the live DB. Loaded lazily: `@/lib/snapshot` imports this module.
  // The hooks never throw.
  let syncHooks: { beforeMigrations: (backupPath: string) => Promise<void>; afterMigrations: () => Promise<void> } | null = null;
  try {
    await initializeDatabaseSchema(rawClient, {
      beforeMigrations: async () => {
        const destPath = path.join(
          appPaths.migrationBackupsDir,
          `pre-migration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
        );
        await copyDatabaseConsistently(rawClient, destPath);
        syncHooks = await import("@/lib/snapshot")
          .then(({ createSyncPreservingMigrationHooks }) => createSyncPreservingMigrationHooks(rawClient))
          .catch(() => null);
        await syncHooks?.beforeMigrations(destPath);
      },
    });
    await (syncHooks as { afterMigrations: () => Promise<void> } | null)?.afterMigrations();
  } finally {
    if (lockAcquired) await releaseOperationLock(rawClient);
  }

  // Gate B toggle: NOT reset here any more (architecture audit 2026-10-01, finding H1). It used to
  // be forced to false on EVERY process boot -- but the flag is shared by every process, so each CLI
  // call or MCP spawn silently switched the operator's toggle off (and could strand a running Batch
  // in APPLYING). "Off by default each session" is now enforced where a session actually starts:
  // the web server's boot hook (`src/instrumentation.ts` -> `resetLiveWritesForNewServerSession`).

  // The read-side toggles (`data_api_reads_enabled`/`analytics_reads_enabled`, see
  // `getDataApiReadsEnabled`/`getAnalyticsReadsEnabled` below) are deliberately NOT reset here,
  // unlike `live_writes_enabled` above -- they persist across restarts by design (see their own
  // doc comment for why). Do not add them to this per-boot reset without re-reading that
  // reasoning first.
}

function startDatabaseInitialization(): Promise<void> {
  return initializeDatabase().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Database initialization failed: ${message}`);
  });
}

// Recoverable initialization (stuck-lock recovery, see `createRecoverableInitializer`): once an
// attempt fails, the next call re-attempts (at most every INIT_RETRY_MIN_INTERVAL_MS), so a process
// recovers after the operator clears a stale operation lock -- no restart needed. Each module
// instance (Next may load db.ts separately for proxy/instrumentation/route bundles) recovers
// independently.
const INIT_RETRY_MIN_INTERVAL_MS = 3_000;
const initializer = createRecoverableInitializer(startDatabaseInitialization, {
  minRetryIntervalMs: INIT_RETRY_MIN_INTERVAL_MS,
});

/** The first initialization attempt, for callers/tests that await boot itself; request-time
 * callers go through `ensureDatabaseInitialized`, which can recover. */
export const databaseInitialization = initializer.first;

export function ensureDatabaseInitialized(): Promise<void> {
  return initializer.get();
}

/**
 * Deliberately NOT gated on initialization -- the one client the /recovery page, its API route and
 * the `operation-lock` CLI use to inspect/clear a stuck operation lock, which must work exactly
 * when initialization is failing because of that lock. Use ONLY for `src/lib/operation-lock`
 * calls; everything else goes through `rawSqlClient`/`db`.
 */
export const ungatedRecoveryClient: Client = rawClient;

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
        await ensureDatabaseInitialized();
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

  // Phase 12 slice 12.8 -- decrypt at rest (src/lib/oauth-token-crypto). A legacy plaintext row
  // is re-encrypted the first time it is read while a key is configured.
  const access = decodeStoredOAuthToken(row.accessToken);
  const refresh = decodeStoredOAuthToken(row.refreshToken);
  if (access.needsReencrypt || refresh.needsReencrypt) {
    await db
      .update(users)
      .set({ accessToken: encodeStoredOAuthToken(access.value), refreshToken: encodeStoredOAuthToken(refresh.value) })
      .where(eq(users.id, userId));
  }

  return {
    userId: row.id,
    accessToken: access.value,
    refreshToken: refresh.value,
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
      accessToken: encodeStoredOAuthToken(patch.accessToken),
      refreshToken: encodeStoredOAuthToken(patch.refreshToken),
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
        accessToken: encodeStoredOAuthToken(input.accessToken ?? existing.accessToken),
        refreshToken: encodeStoredOAuthToken(input.refreshToken ?? existing.refreshToken),
        tokenExpiry: input.tokenExpiry,
        oauthScope: input.scope ?? existing.scope,
        ...refreshTokenIssuedAtPatch(input.refreshToken),
      })
      .where(eq(users.id, input.userId));
    return;
  }

  await db.insert(users).values({
    id: input.userId,
    name: input.name,
    email: input.email,
    image: input.image,
    accessToken: encodeStoredOAuthToken(input.accessToken),
    refreshToken: encodeStoredOAuthToken(input.refreshToken),
    tokenExpiry: input.tokenExpiry,
    oauthScope: input.scope,
    ...refreshTokenIssuedAtPatch(input.refreshToken),
  });
}

/**
 * BL-115 -- `{ refreshTokenIssuedAt: now }` exactly when an exchange handed us a refresh token, else `{}`
 * (the column is left untouched, so an access-token-only sign-in never makes an old grant look new).
 */
export function refreshTokenIssuedAtPatch(
  refreshToken: string | null | undefined,
  now: Date = new Date()
): { refreshTokenIssuedAt?: Date } {
  return refreshToken ? { refreshTokenIssuedAt: now } : {};
}

/** BL-115 -- when Google issued this identity's stored refresh token; `null` = not recorded (pre-v41 row). */
export async function getRefreshTokenIssuedAt(userId: string, database: AppDb = db): Promise<Date | null> {
  const [row] = await database
    .select({ issuedAt: users.refreshTokenIssuedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row?.issuedAt ?? null;
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
        accessToken: encodeStoredOAuthToken(input.accessToken),
        // `existing.refreshToken` is the raw stored value (already encoded, or legacy plaintext that
        // the next read re-encrypts) -- kept as-is, never double-encoded.
        refreshToken: input.refreshToken != null ? encodeStoredOAuthToken(input.refreshToken) : existing.refreshToken,
        tokenExpiry: input.tokenExpiry,
        oauthScope: input.scope ?? existing.oauthScope,
        ...refreshTokenIssuedAtPatch(input.refreshToken),
      })
      .where(eq(users.id, input.userId));

    return;
  }

  await db.insert(users).values({
    id: input.userId,
    email: input.email,
    name: input.name,
    image: input.image,
    accessToken: encodeStoredOAuthToken(input.accessToken),
    refreshToken: encodeStoredOAuthToken(input.refreshToken),
    tokenExpiry: input.tokenExpiry,
    oauthScope: input.scope,
    ...refreshTokenIssuedAtPatch(input.refreshToken),
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
      hasRefreshToken: decodeStoredOAuthToken(row.refreshToken).value !== null,
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
    hasRefreshToken: decodeStoredOAuthToken(row.refreshToken).value !== null,
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
    hasAccessToken: decodeStoredOAuthToken(row.accessToken).value !== null,
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
  // Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md §6): in a channel-bound agent process the
  // "selected channel" IS the bound channel, never the operator's stored selection -- and only for
  // the bound identity (anyone else: null, which every active-channel check treats as fail-closed).
  const agentSession = getAgentSession();
  if (agentSession) {
    return userId === agentSession.userId ? agentSession.channelId : null;
  }
  const [row] = await db
    .select({ selectedChannelId: users.selectedChannelId })
    .from(users)
    .where(eq(users.id, userId));

  return row?.selectedChannelId ?? null;
}

export async function setSelectedChannelId(userId: string, channelId: string): Promise<void> {
  // Phase 12: a silent no-op in a channel-bound agent process. Deliberately not an error -- `apply`
  // and every playlist write persist the selection AFTER a real YouTube write already succeeded,
  // and failing there would misreport that write. The operator's selection is never touched by an
  // agent (AC-P12-04/06).
  if (getAgentSession()) {
    return;
  }
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
  /** BL-118: when the channel was created on YouTube (RFC 3339); null until a sync recorded it. */
  publishedAt: string | null;
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
  durationSeconds: number | null;
  /** `snippet.liveBroadcastContent` as of the last sync; absent/null = unknown. */
  liveBroadcastContent?: string | null;
  publishAt: string | null;
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
    publishedAt: row.publishedAt,
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
    durationSeconds: row.durationSeconds,
    liveBroadcastContent: row.liveBroadcastContent,
    publishAt: row.publishAt,
    lastSyncedAt: row.lastSyncedAt,
  };
}

export async function upsertChannel(input: {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  /** Architecture audit H3: `undefined` leaves an existing row's owner untouched; only a proven
   * owner (the implicit "my channel" sync) ever sets it, and a sync never clears it (`null` is
   * treated like `undefined` here). */
  connectedUserId?: string | null;
  /** BL-118: the channel's creation time (`snippet.publishedAt`); `undefined`/`null` leaves a stored value untouched. */
  publishedAt?: string | null;
}): Promise<void> {
  await db
    .insert(channels)
    .values({
      id: input.channelId,
      title: input.title,
      thumbnailUrl: input.thumbnailUrl,
      uploadsPlaylistId: input.uploadsPlaylistId,
      connectedUserId: input.connectedUserId ?? null,
      publishedAt: input.publishedAt ?? null,
    })
    .onConflictDoUpdate({
      target: channels.id,
      set: {
        title: input.title,
        thumbnailUrl: input.thumbnailUrl,
        uploadsPlaylistId: input.uploadsPlaylistId,
        ...(input.connectedUserId ? { connectedUserId: input.connectedUserId } : {}),
        ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
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

export type ChannelExpectedLanguages = {
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
};

export async function getChannelExpectedLanguages(channelId: string): Promise<ChannelExpectedLanguages> {
  const [row] = await db
    .select({
      defaultLanguage: channels.expectedDefaultLanguage,
      defaultAudioLanguage: channels.expectedDefaultAudioLanguage,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  return { defaultLanguage: row?.defaultLanguage ?? null, defaultAudioLanguage: row?.defaultAudioLanguage ?? null };
}

export async function setChannelExpectedLanguages(channelId: string, value: ChannelExpectedLanguages): Promise<void> {
  await db
    .update(channels)
    .set({ expectedDefaultLanguage: value.defaultLanguage, expectedDefaultAudioLanguage: value.defaultAudioLanguage })
    .where(eq(channels.id, channelId));
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
 * `src/lib/youtube-write-gateway`'s `assertLiveWritesAuthorized()` reads this at call time (not
 * cached, not captured at construction) immediately before every real write, on every write path
 * (Batches, single-item apply, playlists); Batches additionally only construct a real
 * `WriteExecutor` when it is true (`createLiveWriteExecutorIfEnabled`). Persisted, not an in-memory module
 * variable, so every process that reads it (the Web app, a separately-spawned MCP process, the
 * CLI) agrees. "Off by default each session" is achieved by `resetLiveWritesForNewServerSession`,
 * run once at web-server boot only (never per process -- H1).
 */
const LIVE_WRITES_SESSION_LEASE_SETTING_KEY = "live_writes_session_lease_at";

/**
 * How long a web-server session lease stays valid without renewal (architecture-audit review, round
 * 3). The web server renews it every `LIVE_WRITES_SESSION_LEASE_RENEW_MS`; a few missed renewals
 * (event-loop stall, laptop sleep) do not flip the toggle off, but any ungraceful end of the web
 * server -- a crash, Windows `taskkill /F`, a closed console window -- makes Live writes lapse
 * within this TTL on every platform.
 */
export const LIVE_WRITES_SESSION_LEASE_TTL_MS = 3 * 60 * 1000;
export const LIVE_WRITES_SESSION_LEASE_RENEW_MS = 30 * 1000;
/** Tolerated clock skew for a lease stamped slightly "in the future" (e.g. two processes' clocks). */
export const LIVE_WRITES_SESSION_LEASE_MAX_SKEW_MS = 60 * 1000;

/**
 * Gate B: Live writes are honored only while a web-server session is alive (owner rule "off by
 * default at the start of every session", 2026-09-21; architecture audit H1 + review). True only
 * when the persisted toggle is on AND the web server's session lease is fresh. Every consumer (the
 * write gateway, the Batch executor factory, the batch/experiment routes, the Settings snapshot)
 * reads this one function, so the UI toggle and the real write permission can never disagree.
 */
export async function getLiveWritesEnabled(now: Date = new Date()): Promise<boolean> {
  if ((await getAppSetting(LIVE_WRITES_ENABLED_SETTING_KEY)) !== "true") return false;
  const leaseAt = Number(await getAppSetting(LIVE_WRITES_SESSION_LEASE_SETTING_KEY));
  const age = now.getTime() - leaseAt;
  // Fresh = stamped within the TTL AND not meaningfully in the future (a lease stamped while the
  // clock ran ahead must not stay "fresh" for hours after the clock is corrected -- review round 4).
  if (Number.isFinite(leaseAt) && age < LIVE_WRITES_SESSION_LEASE_TTL_MS && age > -LIVE_WRITES_SESSION_LEASE_MAX_SKEW_MS) {
    return true;
  }
  // A lapsed lease is a real OFF, persisted: the toggle must not silently come back on when a later
  // renewal happens (e.g. after the laptop wakes), and the Settings UI must show exactly what is
  // enforced. Re-enabling is always an explicit operator action (review round 4).
  try {
    await setAppSetting(LIVE_WRITES_ENABLED_SETTING_KEY, "false");
  } catch {
    // Still reported as off below.
  }
  return false;
}

/** Called only by the operator-facing web settings route -- turning the toggle on happens inside a
 * live web-server session, so it also stamps that session's lease. */
export async function setLiveWritesEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(LIVE_WRITES_ENABLED_SETTING_KEY, enabled ? "true" : "false");
  if (enabled) await renewLiveWritesSessionLease();
}

/**
 * Renews the web-server session lease. ONLY the web server's boot hook (`src/instrumentation.ts`)
 * and `setLiveWritesEnabled` may call this -- never an MCP or CLI process (inventory-tested), or a
 * process that is not the operator's web session could keep Live writes alive by itself.
 */
export async function renewLiveWritesSessionLease(now: Date = new Date(), database: AppDb = db): Promise<void> {
  await setAppSetting(LIVE_WRITES_SESSION_LEASE_SETTING_KEY, String(now.getTime()), database);
}

/**
 * Gate B's "off by default at the start of every session" (owner instruction, 2026-09-21: "по
 * дефолту при запуске сессии он выключен") -- called ONLY by the web server's boot hook
 * (`src/instrumentation.ts`), never by an MCP server or CLI process: the flag is shared by all
 * processes, so resetting it from any of them would switch the operator's live toggle off
 * mid-session (architecture audit 2026-10-01, H1).
 */
export async function resetLiveWritesForNewServerSession(database: AppDb = db): Promise<void> {
  await setAppSetting(LIVE_WRITES_ENABLED_SETTING_KEY, "false", database);
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
 * Read fresh on EVERY request by the in-app MCP endpoint (`src/lib/agent-mcp-endpoint`, stateless,
 * a new server per request -- docs/decisions/0013-in-app-http-mcp-transport.md), so flipping it
 * takes effect on the very next agent call, with no client restart.
 */
export async function getMcpConnectionEnabled(): Promise<boolean> {
  return (await getAppSetting(MCP_CONNECTION_ENABLED_SETTING_KEY)) === "true";
}

export async function setMcpConnectionEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(MCP_CONNECTION_ENABLED_SETTING_KEY, enabled ? "true" : "false");
}

const OPERATOR_CLI_ENABLED_SETTING_KEY = "operator_cli_enabled";

/**
 * Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md slice 12.5, AC-P12-10) -- whether the CLI may run
 * as the operator -- the only way it runs now (the agent mode was removed, ADR 0013). Off by default and
 * persistent (like MCP connection): otherwise a shell-capable agent could simply run it.
 * Settable only through the Web Settings tab (`POST /api/settings`), never from the CLI itself.
 */
export async function getOperatorCliEnabled(): Promise<boolean> {
  return (await getAppSetting(OPERATOR_CLI_ENABLED_SETTING_KEY)) === "true";
}

export async function setOperatorCliEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(OPERATOR_CLI_ENABLED_SETTING_KEY, enabled ? "true" : "false");
}

const DEVICE_AUTO_SYNC_ENABLED_SETTING_KEY = "device_auto_sync_enabled";
const DEVICE_SYNC_STATUS_SETTING_KEY = "device_sync_status";

/**
 * Automatic device sync (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §3.7) -- ON unless the
 * operator turned it off (the owner asked for sync to stop needing manual steps). Persistent,
 * device-local like every `app_settings` row.
 */
export async function getDeviceAutoSyncEnabled(): Promise<boolean> {
  return (await getAppSetting(DEVICE_AUTO_SYNC_ENABLED_SETTING_KEY)) !== "false";
}

export async function setDeviceAutoSyncEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(DEVICE_AUTO_SYNC_ENABLED_SETTING_KEY, enabled ? "true" : "false");
}

/** The automatic sync's own last-known state (JSON, owned by `src/lib/device-sync`). Stored rather
 * than kept in memory: Next.js route handlers and the instrumentation scheduler are separate
 * bundles and do not share module state. */
export async function getDeviceSyncStatusJson(): Promise<string | null> {
  return getAppSetting(DEVICE_SYNC_STATUS_SETTING_KEY);
}

export async function setDeviceSyncStatusJson(value: string): Promise<void> {
  await setAppSetting(DEVICE_SYNC_STATUS_SETTING_KEY, value);
}

// --- Phase 13 slice 13.8: Wikipedia topic signals (owned by src/lib/wikipedia-signals) -------------

export type StoredTopicWikipediaArticle = {
  id: string;
  topicId: string;
  project: string;
  article: string;
  createdVia: string;
  createdAt: Date;
};

export async function insertTopicWikipediaArticle(
  input: { id: string; topicId: string; project: string; article: string; createdVia: string },
  database: AppDb = db
): Promise<void> {
  await database.insert(topicWikipediaArticles).values(input);
}

export async function deleteTopicWikipediaArticle(id: string, database: AppDb = db): Promise<boolean> {
  const deleted = await database.delete(topicWikipediaArticles).where(eq(topicWikipediaArticles.id, id)).returning();
  return deleted.length > 0;
}

export async function listTopicWikipediaArticles(
  topicId: string | null,
  database: AppDb = db
): Promise<StoredTopicWikipediaArticle[]> {
  const query = database.select().from(topicWikipediaArticles);
  const rows = topicId === null ? await query : await query.where(eq(topicWikipediaArticles.topicId, topicId));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// --- BL-114: YouTube Reporting API storage ------------------------------------------------------

export type StoredReportingJob = {
  channelId: string;
  reportTypeId: string;
  jobId: string;
  jobName: string;
  jobCreatedAt: string | null;
  lastCheckedAt: Date | null;
};

export async function upsertReportingJob(
  input: { channelId: string; reportTypeId: string; jobId: string; jobName: string; jobCreatedAt: string | null },
  database: AppDb = db
): Promise<void> {
  const lastCheckedAt = new Date();
  await database
    .insert(reportingJobs)
    .values({ ...input, lastCheckedAt })
    .onConflictDoUpdate({
      target: [reportingJobs.channelId, reportingJobs.reportTypeId],
      set: { jobId: input.jobId, jobName: input.jobName, jobCreatedAt: input.jobCreatedAt, lastCheckedAt },
    });
}

export async function getReportingJob(
  channelId: string,
  reportTypeId: string,
  database: AppDb = db
): Promise<StoredReportingJob | null> {
  const [row] = await database
    .select()
    .from(reportingJobs)
    .where(and(eq(reportingJobs.channelId, channelId), eq(reportingJobs.reportTypeId, reportTypeId)));
  return row ?? null;
}

export async function listSeenReportingReportIds(
  channelId: string,
  reportTypeId: string,
  database: AppDb = db
): Promise<Set<string>> {
  const rows = await database
    .select({ reportId: reportingReportFiles.reportId })
    .from(reportingReportFiles)
    .where(and(eq(reportingReportFiles.channelId, channelId), eq(reportingReportFiles.reportTypeId, reportTypeId)));
  return new Set(rows.map((row) => row.reportId));
}

export type ReachReportImport = {
  channelId: string;
  reportTypeId: string;
  jobId: string;
  reportId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  rows: Array<{ date: string; videoId: string; impressions: number; ctr: number | null }>;
};

export type ReachReportImportResult =
  | { outcome: "imported"; replacedReports: number }
  | { outcome: "superseded_by_newer" };

/**
 * Imports one Reach report file in a single transaction. **Replacement, not addition:** when an
 * already-imported file covers the SAME period, the one with the later `createTime` wins -- a newer file
 * replaces the older file's rows (including a video the regenerated file no longer lists), and an older
 * file arriving after a newer one is recorded as superseded without touching the data.
 */
// One reach report import at a time in this process (re-review): between reading the period's reports and writing, another import
// of the same period (the local sync and a peer's file) could otherwise record both as imported and let the older one's rows win.
let reachImportQueue: Promise<unknown> = Promise.resolve();
export function importReachReport(input: ReachReportImport, database: AppDb = db): Promise<ReachReportImportResult> {
  const run = reachImportQueue.then(
    () => importReachReportUnlocked(input, database),
    () => importReachReportUnlocked(input, database)
  );
  reachImportQueue = run.catch(() => undefined);
  return run;
}

async function importReachReportUnlocked(
  input: ReachReportImport,
  database: AppDb = db
): Promise<ReachReportImportResult> {
  const newCreate = Date.parse(input.createTime);
  // The decision is read first; every write then runs as ONE atomic batch (BL-151 re-review): a transaction with an await per
  // row held the database lock while other writers of this process failed with SQLITE_BUSY (libsql is synchronous on the one
  // Node thread). Behaviour is unchanged: a report older than one already imported for the period is recorded as superseded;
  // otherwise the older reports' rows are replaced by this one's.
  const samePeriod = await database
    .select()
    .from(reportingReportFiles)
    .where(
      and(
        eq(reportingReportFiles.channelId, input.channelId),
        eq(reportingReportFiles.reportTypeId, input.reportTypeId),
        eq(reportingReportFiles.startTime, input.startTime),
        eq(reportingReportFiles.endTime, input.endTime),
        eq(reportingReportFiles.status, "imported")
      )
    );
  const fileRow = (status: "imported" | "superseded", rowCount: number) =>
    database.insert(reportingReportFiles).values({
      reportId: input.reportId,
      channelId: input.channelId,
      reportTypeId: input.reportTypeId,
      jobId: input.jobId,
      startTime: input.startTime,
      endTime: input.endTime,
      createTime: input.createTime,
      rowCount,
      status,
    });

  if (samePeriod.some((file) => Date.parse(file.createTime) >= newCreate)) {
    await fileRow("superseded", 0);
    return { outcome: "superseded_by_newer" } as const;
  }

  const olderIds = samePeriod.map((file) => file.reportId);
  const writes: Array<BatchItem<"sqlite">> = [];
  if (olderIds.length > 0) {
    writes.push(database.delete(channelReachDaily).where(inArray(channelReachDaily.sourceReportId, olderIds)));
    writes.push(database.update(reportingReportFiles).set({ status: "superseded" }).where(inArray(reportingReportFiles.reportId, olderIds)));
  }
  for (const row of input.rows) {
    writes.push(
      database
        .insert(channelReachDaily)
        .values({ channelId: input.channelId, date: row.date, videoId: row.videoId, impressions: row.impressions, ctr: row.ctr, sourceReportId: input.reportId })
        .onConflictDoUpdate({
          target: [channelReachDaily.channelId, channelReachDaily.date, channelReachDaily.videoId],
          set: { impressions: row.impressions, ctr: row.ctr, sourceReportId: input.reportId },
        })
    );
  }
  writes.push(fileRow("imported", input.rows.length));
  await database.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return { outcome: "imported", replacedReports: olderIds.length } as const;
}

export type StoredChannelReachRow = {
  channelId: string;
  date: string;
  videoId: string;
  impressions: number;
  ctr: number | null;
};

export async function listChannelReachDaily(
  channelId: string,
  range: { startDate: string; endDate: string },
  database: AppDb = db
): Promise<StoredChannelReachRow[]> {
  return database
    .select({
      channelId: channelReachDaily.channelId,
      date: channelReachDaily.date,
      videoId: channelReachDaily.videoId,
      impressions: channelReachDaily.impressions,
      ctr: channelReachDaily.ctr,
    })
    .from(channelReachDaily)
    .where(
      and(
        eq(channelReachDaily.channelId, channelId),
        gte(channelReachDaily.date, range.startDate),
        sql`${channelReachDaily.date} <= ${range.endDate}`
      )
    )
    .orderBy(asc(channelReachDaily.date), asc(channelReachDaily.videoId));
}

export async function getChannelReachCoverage(
  channelId: string,
  database: AppDb = db
): Promise<{ firstDate: string | null; lastDate: string | null; importedFiles: number }> {
  const [days] = await database
    .select({
      firstDate: sql<string | null>`MIN(${channelReachDaily.date})`,
      lastDate: sql<string | null>`MAX(${channelReachDaily.date})`,
    })
    .from(channelReachDaily)
    .where(eq(channelReachDaily.channelId, channelId));
  const [files] = await database
    .select({ count: sql<number>`COUNT(*)` })
    .from(reportingReportFiles)
    .where(and(eq(reportingReportFiles.channelId, channelId), eq(reportingReportFiles.status, "imported")));
  return {
    firstDate: days?.firstDate ?? null,
    lastDate: days?.lastDate ?? null,
    importedFiles: Number(files?.count ?? 0),
  };
}

// --- BL-117 slice 2: quota reserve setting ---------------------------------------------------------

const QUOTA_RESERVE_PERCENT_SETTING_KEY = "quota_reserve_percent";

/** Share of the daily quota (percent) background reads leave untouched so writes keep headroom; default 20. */
export async function getQuotaReservePercent(database: AppDb = db): Promise<number> {
  const raw = await getAppSetting(QUOTA_RESERVE_PERCENT_SETTING_KEY, database);
  if (raw === null || raw === "") return 20;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 90 ? Math.round(parsed) : 20;
}

export async function setQuotaReservePercent(percent: number, database: AppDb = db): Promise<void> {
  await setAppSetting(QUOTA_RESERVE_PERCENT_SETTING_KEY, String(Math.round(percent)), database);
}

// --- BL-125: retention of settled drafts and of the write log ----------------------------------------------

const DRAFT_RETENTION_DAYS_SETTING_KEY = "draft_retention_days";
const WRITE_LOG_RETENTION_DAYS_SETTING_KEY = "write_log_retention_days";
export const DEFAULT_DRAFT_RETENTION_DAYS = 7;
export const MIN_DRAFT_RETENTION_DAYS = 1;
export const DEFAULT_WRITE_LOG_RETENTION_DAYS = 30;
export const MIN_WRITE_LOG_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;

function parseRetentionDays(raw: string | null, fallback: number, min: number): number {
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(MAX_RETENTION_DAYS, Math.max(min, parsed));
}

/** How many days a settled (rejected, or approved and successfully written) change set stays before the sweep deletes it. Default 7, at least 1. */
export async function getDraftRetentionDays(database: AppDb = db): Promise<number> {
  return parseRetentionDays(
    await getAppSetting(DRAFT_RETENTION_DAYS_SETTING_KEY, database),
    DEFAULT_DRAFT_RETENTION_DAYS,
    MIN_DRAFT_RETENTION_DAYS
  );
}

export async function setDraftRetentionDays(days: number, database: AppDb = db): Promise<void> {
  if (!Number.isInteger(days) || days < MIN_DRAFT_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new Error(`Draft retention must be a whole number of days from ${MIN_DRAFT_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`);
  }
  await setAppSetting(DRAFT_RETENTION_DAYS_SETTING_KEY, String(days), database);
}

/** How many days the write log (batches, ledger rows, attempts, audit events) of a fully successful batch stays. Default 30; never below 7, even if a lower value is stored. */
export async function getWriteLogRetentionDays(database: AppDb = db): Promise<number> {
  return parseRetentionDays(
    await getAppSetting(WRITE_LOG_RETENTION_DAYS_SETTING_KEY, database),
    DEFAULT_WRITE_LOG_RETENTION_DAYS,
    MIN_WRITE_LOG_RETENTION_DAYS
  );
}

export async function setWriteLogRetentionDays(days: number, database: AppDb = db): Promise<void> {
  if (!Number.isInteger(days) || days < MIN_WRITE_LOG_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new Error(`Write log retention must be a whole number of days from ${MIN_WRITE_LOG_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`);
  }
  await setAppSetting(WRITE_LOG_RETENTION_DAYS_SETTING_KEY, String(days), database);
}

// --- BL-117: quota ledger ---------------------------------------------------------------------------

export const QUOTA_LEDGER_RETENTION_SECONDS = 45 * 24 * 3600;
let lastQuotaLedgerPruneAt = 0;

export type QuotaCallRecord = {
  occurredAt: number; // unix seconds
  service: "data" | "analytics";
  method: string;
  units: number | null;
  outcome: "ok" | "error" | "quota_exceeded";
  contextKind: string | null;
  contextId: string | null;
  contextLabel: string | null;
};

/** Appends one call; prunes entries past retention at most once an hour. Callers treat this as best-effort. */
export async function recordQuotaCall(record: QuotaCallRecord, database: AppDb = db): Promise<void> {
  await database.insert(quotaLedger).values(record);
  const nowMs = Date.now();
  if (nowMs - lastQuotaLedgerPruneAt > 3_600_000) {
    lastQuotaLedgerPruneAt = nowMs;
    await pruneQuotaLedger(Math.floor(nowMs / 1000), database);
  }
}

/** Deletes entries older than the retention window as of `nowSeconds`; returns nothing (best-effort housekeeping). */
export async function pruneQuotaLedger(nowSeconds: number, database: AppDb = db): Promise<void> {
  await database.delete(quotaLedger).where(sql`${quotaLedger.occurredAt} < ${nowSeconds - QUOTA_LEDGER_RETENTION_SECONDS}`);
}

export async function listQuotaCalls(
  args: { sinceSeconds: number; service: "data" | "analytics" },
  database: AppDb = db
): Promise<QuotaCallRecord[]> {
  const rows = await database
    .select()
    .from(quotaLedger)
    .where(and(eq(quotaLedger.service, args.service), gte(quotaLedger.occurredAt, args.sinceSeconds)))
    .orderBy(asc(quotaLedger.occurredAt), asc(quotaLedger.id));
  return rows.map((r) => ({
    occurredAt: r.occurredAt,
    service: r.service === "analytics" ? "analytics" : "data",
    method: r.method,
    units: r.units,
    outcome: r.outcome === "ok" || r.outcome === "quota_exceeded" ? r.outcome : "error",
    contextKind: r.contextKind,
    contextId: r.contextId,
    contextLabel: r.contextLabel,
  }));
}

/** Every service's calls since `sinceSeconds`, oldest first (for publishing this device's log to the shared folder). */
export async function listAllQuotaCalls(sinceSeconds: number, database: AppDb = db): Promise<QuotaCallRecord[]> {
  const [data, analytics] = await Promise.all([
    listQuotaCalls({ sinceSeconds, service: "data" }, database),
    listQuotaCalls({ sinceSeconds, service: "analytics" }, database),
  ]);
  return [...data, ...analytics].sort((a, b) => a.occurredAt - b.occurredAt);
}

/** How many ledger rows of each status a batch has (history says "N videos changed" from SUCCESS, not from call counts). */
export async function countBatchRowsByStatus(batchId: string, database: AppDb = db): Promise<Record<string, number>> {
  const rows = await database
    .select({ status: batchLedgerRows.status, count: sql<number>`COUNT(*)` })
    .from(batchLedgerRows)
    .where(eq(batchLedgerRows.batchId, batchId))
    .groupBy(batchLedgerRows.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

export type StoredReportingSyncAttempt = {
  attemptedAt: Date;
  outcome: "ok" | "partial" | "failed";
  error: string | null;
  filesListed: number;
  filesImported: number;
  failures: Array<{ reportId: string; error: string }>;
};

export async function recordReportingSyncAttempt(
  input: {
    channelId: string;
    reportTypeId: string;
    outcome: "ok" | "partial" | "failed";
    error: string | null;
    filesListed: number;
    filesImported: number;
    failures: Array<{ reportId: string; error: string }>;
  },
  database: AppDb = db
): Promise<void> {
  const values = {
    channelId: input.channelId,
    reportTypeId: input.reportTypeId,
    attemptedAt: new Date(),
    outcome: input.outcome,
    error: input.error,
    filesListed: input.filesListed,
    filesImported: input.filesImported,
    failuresJson: input.failures.length > 0 ? JSON.stringify(input.failures) : null,
  };
  await database
    .insert(reportingSyncAttempts)
    .values(values)
    .onConflictDoUpdate({
      target: [reportingSyncAttempts.channelId, reportingSyncAttempts.reportTypeId],
      set: values,
    });
}

export async function getReportingSyncAttempt(
  channelId: string,
  reportTypeId: string,
  database: AppDb = db
): Promise<StoredReportingSyncAttempt | null> {
  const [row] = await database
    .select()
    .from(reportingSyncAttempts)
    .where(and(eq(reportingSyncAttempts.channelId, channelId), eq(reportingSyncAttempts.reportTypeId, reportTypeId)));
  if (!row) return null;
  let failures: Array<{ reportId: string; error: string }> = [];
  try {
    const parsed: unknown = row.failuresJson ? JSON.parse(row.failuresJson) : [];
    if (Array.isArray(parsed)) {
      failures = parsed.filter(
        (f): f is { reportId: string; error: string } =>
          typeof f === "object" && f !== null && typeof (f as { reportId?: unknown }).reportId === "string" && typeof (f as { error?: unknown }).error === "string"
      );
    }
  } catch {
    failures = [];
  }
  return {
    attemptedAt: row.attemptedAt,
    outcome: row.outcome === "ok" || row.outcome === "partial" ? row.outcome : "failed",
    error: row.error,
    filesListed: row.filesListed,
    filesImported: row.filesImported,
    failures,
  };
}

export type StoredReportingFile = {
  reportId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  rowCount: number;
  status: string;
  importedAt: Date;
};

/** Newest period first; `limit` bounds the payload (Google keeps ~60 daily files). */
export async function listReportingReportFiles(
  channelId: string,
  reportTypeId: string,
  limit: number,
  database: AppDb = db
): Promise<StoredReportingFile[]> {
  const rows = await database
    .select()
    .from(reportingReportFiles)
    .where(and(eq(reportingReportFiles.channelId, channelId), eq(reportingReportFiles.reportTypeId, reportTypeId)))
    .orderBy(desc(reportingReportFiles.startTime), desc(reportingReportFiles.createTime))
    .limit(limit);
  return rows.map((row) => ({
    reportId: row.reportId,
    startTime: row.startTime,
    endTime: row.endTime,
    createTime: row.createTime,
    rowCount: row.rowCount,
    status: row.status,
    importedAt: row.importedAt,
  }));
}


export async function upsertWikipediaPageviews(
  rows: { project: string; article: string; date: string; views: number }[],
  database: AppDb = db
): Promise<void> {
  for (const row of rows) {
    await database
      .insert(wikipediaPageviewsDaily)
      .values(row)
      .onConflictDoUpdate({
        target: [wikipediaPageviewsDaily.project, wikipediaPageviewsDaily.article, wikipediaPageviewsDaily.date],
        set: { views: row.views },
      });
  }
}

export async function listWikipediaPageviews(
  args: { project: string; article: string; sinceDate: string },
  database: AppDb = db
): Promise<{ date: string; views: number }[]> {
  return database
    .select({ date: wikipediaPageviewsDaily.date, views: wikipediaPageviewsDaily.views })
    .from(wikipediaPageviewsDaily)
    .where(
      and(
        eq(wikipediaPageviewsDaily.project, args.project),
        eq(wikipediaPageviewsDaily.article, args.article),
        gte(wikipediaPageviewsDaily.date, args.sinceDate)
      )
    )
    .orderBy(asc(wikipediaPageviewsDaily.date));
}

export async function getLatestWikipediaPageviewDate(
  args: { project: string; article: string },
  database: AppDb = db
): Promise<string | null> {
  const [row] = await database
    .select({ date: sql<string | null>`MAX(${wikipediaPageviewsDaily.date})` })
    .from(wikipediaPageviewsDaily)
    .where(and(eq(wikipediaPageviewsDaily.project, args.project), eq(wikipediaPageviewsDaily.article, args.article)));
  return row?.date ?? null;
}

const API_DATA_RETENTION_STATE_SETTING_KEY = "api_data_retention_state";

/** Phase 13 slice 13.2: the YouTube API data retention job's own state (JSON, owned by
 * `src/lib/youtube-data-policy`): whether the one-time pre-purge backup was taken, last run, counts. */
export async function getApiDataRetentionStateJson(): Promise<string | null> {
  return getAppSetting(API_DATA_RETENTION_STATE_SETTING_KEY);
}

export async function setApiDataRetentionStateJson(value: string): Promise<void> {
  await setAppSetting(API_DATA_RETENTION_STATE_SETTING_KEY, value);
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

const YOUTUBE_FEED_READS_ENABLED_SETTING_KEY = "youtube_feed_reads_enabled";
const WIKIPEDIA_READS_ENABLED_SETTING_KEY = "wikipedia_reads_enabled";
const REPORTING_READS_ENABLED_SETTING_KEY = "reporting_reads_enabled";

/** Phase 13 slice 13.5: the YouTube RSS feed read category (no quota). Same semantics as the other
 * read toggles: on unless the operator turned it off, persistent. */
export async function getYoutubeFeedReadsEnabled(database: AppDb = db): Promise<boolean> {
  return (await getAppSetting(YOUTUBE_FEED_READS_ENABLED_SETTING_KEY, database)) !== "false";
}

export async function setYoutubeFeedReadsEnabled(enabled: boolean, database: AppDb = db): Promise<void> {
  await setAppSetting(YOUTUBE_FEED_READS_ENABLED_SETTING_KEY, enabled ? "true" : "false", database);
}

/** Phase 13 slice 13.8: the Wikipedia Pageviews read category. On unless turned off, persistent. */
export async function getWikipediaReadsEnabled(database: AppDb = db): Promise<boolean> {
  return (await getAppSetting(WIKIPEDIA_READS_ENABLED_SETTING_KEY, database)) !== "false";
}

export async function setWikipediaReadsEnabled(enabled: boolean, database: AppDb = db): Promise<void> {
  await setAppSetting(WIKIPEDIA_READS_ENABLED_SETTING_KEY, enabled ? "true" : "false", database);
}

/** BL-114: the YouTube Reporting API read category (bulk reports: impressions/CTR). Same semantics as
 * the other read toggles: on unless the operator turned it off, persistent. */
export async function getReportingReadsEnabled(database: AppDb = db): Promise<boolean> {
  return (await getAppSetting(REPORTING_READS_ENABLED_SETTING_KEY, database)) !== "false";
}

export async function setReportingReadsEnabled(enabled: boolean, database: AppDb = db): Promise<void> {
  await setAppSetting(REPORTING_READS_ENABLED_SETTING_KEY, enabled ? "true" : "false", database);
}

const OPERATIONS_WORKSPACE_PATH_SETTING_KEY = "operations_workspace_path";

/**
 * Phase 7 slice I (owner spec §3/§30, `docs/AGENT_OPERATIONS_INTERFACE.md` §4i, project owner
 * clarification via Telegram 2026-09-24): an absolute filesystem path to a folder OUTSIDE this
 * repository holding Codex's own operating/editorial instructions -- this application never
 * generates, templates, or commits anything into that folder (`AGENTS.md` §B), it only stores
 * where it is and surfaces its contents to the connected agent on request. Only ever set through
 * the operator-facing Settings API (`POST /api/settings`), never through any `agent`-namespaced
 * MCP tool or CLI command -- an agent that could choose its own instructions directory would be
 * self-authorizing filesystem access, the exact `local_path`/owner-spec-§17 logic slice G2
 * already established for asset registration. `null`/empty string both mean "not configured" --
 * this is not a boolean toggle like the settings above, so no separate "enabled" flag exists.
 */
export async function getOperationsWorkspacePath(database: AppDb = db): Promise<string | null> {
  const value = await getAppSetting(OPERATIONS_WORKSPACE_PATH_SETTING_KEY, database);
  return value && value.length > 0 ? value : null;
}

export async function setOperationsWorkspacePath(path: string | null, database: AppDb = db): Promise<void> {
  await setAppSetting(OPERATIONS_WORKSPACE_PATH_SETTING_KEY, path ?? "", database);
}

/** Phase 12 slice 12.4. Record ids of one kind assigned to a channel. */
export async function listChannelAssignedRecordIds(channelId: string, recordKind: string, database: AppDb = db): Promise<string[]> {
  const rows = await database
    .select({ recordId: channelRecordAssignments.recordId })
    .from(channelRecordAssignments)
    .where(and(eq(channelRecordAssignments.channelId, channelId), eq(channelRecordAssignments.recordKind, recordKind)));
  return rows.map((row) => row.recordId);
}

/** Channels one record is assigned to. */
export async function listRecordAssignmentChannels(recordKind: string, recordId: string, database: AppDb = db): Promise<string[]> {
  const rows = await database
    .select({ channelId: channelRecordAssignments.channelId })
    .from(channelRecordAssignments)
    .where(and(eq(channelRecordAssignments.recordKind, recordKind), eq(channelRecordAssignments.recordId, recordId)));
  return rows.map((row) => row.channelId);
}

/** Every assignment of one kind -- the operator UI's bulk view. */
export async function listRecordAssignmentsByKind(
  recordKind: string,
  database: AppDb = db
): Promise<Array<{ channelId: string; recordId: string }>> {
  return database
    .select({ channelId: channelRecordAssignments.channelId, recordId: channelRecordAssignments.recordId })
    .from(channelRecordAssignments)
    .where(eq(channelRecordAssignments.recordKind, recordKind));
}

/** Replaces the full set of channels a record is assigned to, in one transaction. */
export async function setRecordAssignmentChannels(
  recordKind: string,
  recordId: string,
  channelIds: string[],
  database: AppDb = db
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .delete(channelRecordAssignments)
      .where(and(eq(channelRecordAssignments.recordKind, recordKind), eq(channelRecordAssignments.recordId, recordId)));
    if (channelIds.length > 0) {
      const assignedAt = new Date();
      await tx
        .insert(channelRecordAssignments)
        .values(channelIds.map((channelId) => ({ channelId, recordKind, recordId, assignedAt })));
    }
  });
}

/** Adds one assignment (idempotent) -- used when an agent creates a record owned by its channel. */
export async function addChannelRecordAssignment(channelId: string, recordKind: string, recordId: string, database: AppDb = db): Promise<void> {
  await database
    .insert(channelRecordAssignments)
    .values({ channelId, recordKind, recordId, assignedAt: new Date() })
    .onConflictDoNothing();
}

export type StoredAgentChannelToken = {
  id: string;
  channelId: string;
  userId: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

const agentChannelTokenColumns = {
  id: agentChannelTokens.id,
  channelId: agentChannelTokens.channelId,
  userId: agentChannelTokens.userId,
  label: agentChannelTokens.label,
  createdAt: agentChannelTokens.createdAt,
  revokedAt: agentChannelTokens.revokedAt,
};

/** Phase 12. Revokes any active token of the channel and inserts the new one in ONE transaction,
 * so "at most one active token per channel" can never be observed violated. */
export async function replaceAgentChannelToken(
  input: { id: string; channelId: string; userId: string; tokenHash: string; label: string | null },
  database: AppDb = db
): Promise<void> {
  const now = new Date();
  await database.transaction(async (tx) => {
    await tx
      .update(agentChannelTokens)
      .set({ revokedAt: now })
      .where(and(eq(agentChannelTokens.channelId, input.channelId), isNull(agentChannelTokens.revokedAt)));
    await tx.insert(agentChannelTokens).values({ ...input, createdAt: now, revokedAt: null });
  });
}

/** Returns the number of tokens revoked (0 when the channel had no active token). */
export async function revokeAgentChannelTokens(channelId: string, database: AppDb = db): Promise<number> {
  const revoked = await database
    .update(agentChannelTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentChannelTokens.channelId, channelId), isNull(agentChannelTokens.revokedAt)))
    .returning({ id: agentChannelTokens.id });
  return revoked.length;
}

/** Active (non-revoked) token by hash, or null. */
export async function findActiveAgentChannelTokenByHash(
  tokenHash: string,
  database: AppDb = db
): Promise<StoredAgentChannelToken | null> {
  const rows = await database
    .select(agentChannelTokenColumns)
    .from(agentChannelTokens)
    .where(and(eq(agentChannelTokens.tokenHash, tokenHash), isNull(agentChannelTokens.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** BL-130. Token row by hash whether active or revoked, or null -- import must tell "already
 * active here" apart from "revoked here" (a revoked token is never re-activated on this device). */
export async function findAgentChannelTokenByHash(
  tokenHash: string,
  database: AppDb = db
): Promise<StoredAgentChannelToken | null> {
  const rows = await database
    .select(agentChannelTokenColumns)
    .from(agentChannelTokens)
    .where(eq(agentChannelTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function listActiveAgentChannelTokens(database: AppDb = db): Promise<StoredAgentChannelToken[]> {
  return database.select(agentChannelTokenColumns).from(agentChannelTokens).where(isNull(agentChannelTokens.revokedAt));
}

/** Phase 11. Every read/write is filtered on `deviceId` -- see `channelWorkspaces` above. */
export async function getChannelWorkspacePath(
  deviceId: string,
  channelId: string,
  database: AppDb = db
): Promise<string | null> {
  const rows = await database
    .select({ path: channelWorkspaces.path })
    .from(channelWorkspaces)
    .where(and(eq(channelWorkspaces.deviceId, deviceId), eq(channelWorkspaces.channelId, channelId)))
    .limit(1);
  return rows[0]?.path ?? null;
}

export async function listChannelWorkspacePaths(
  deviceId: string,
  database: AppDb = db
): Promise<Array<{ channelId: string; path: string; updatedAt: Date }>> {
  return database
    .select({ channelId: channelWorkspaces.channelId, path: channelWorkspaces.path, updatedAt: channelWorkspaces.updatedAt })
    .from(channelWorkspaces)
    .where(eq(channelWorkspaces.deviceId, deviceId));
}

/** `null` deletes this device's row for the channel. */
export async function setChannelWorkspacePath(
  deviceId: string,
  channelId: string,
  path: string | null,
  database: AppDb = db
): Promise<void> {
  if (path === null) {
    await database
      .delete(channelWorkspaces)
      .where(and(eq(channelWorkspaces.deviceId, deviceId), eq(channelWorkspaces.channelId, channelId)));
    return;
  }
  const updatedAt = new Date();
  await database
    .insert(channelWorkspaces)
    .values({ deviceId, channelId, path, updatedAt })
    .onConflictDoUpdate({
      target: [channelWorkspaces.deviceId, channelWorkspaces.channelId],
      set: { path, updatedAt },
    });
}

export type StoredLogicalPath = { name: string; audience: string; description: string; createdAt: Date };

/** Factory Operator access. Definitions are device-local; values are filtered on `deviceId`. */
export async function listLogicalPathRows(database: AppDb = db): Promise<StoredLogicalPath[]> {
  return database
    .select({
      name: logicalPaths.name,
      audience: logicalPaths.audience,
      description: logicalPaths.description,
      createdAt: logicalPaths.createdAt,
    })
    .from(logicalPaths)
    .orderBy(asc(logicalPaths.name));
}

/** Returns false (nothing written) when the name already exists. */
export async function insertLogicalPathRow(
  input: { name: string; audience: string; description: string },
  database: AppDb = db
): Promise<boolean> {
  const inserted = await database
    .insert(logicalPaths)
    .values({ ...input, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ name: logicalPaths.name });
  return inserted.length > 0;
}

/** Deletes the definition and every stored value for that name. Returns false if it did not exist. */
export async function deleteLogicalPathRow(name: string, database: AppDb = db): Promise<boolean> {
  return database.transaction(async (tx) => {
    await tx.delete(logicalPathValues).where(eq(logicalPathValues.name, name));
    const deleted = await tx.delete(logicalPaths).where(eq(logicalPaths.name, name)).returning({ name: logicalPaths.name });
    return deleted.length > 0;
  });
}

export async function getLogicalPathValue(deviceId: string, name: string, database: AppDb = db): Promise<string | null> {
  const rows = await database
    .select({ path: logicalPathValues.path })
    .from(logicalPathValues)
    .where(and(eq(logicalPathValues.deviceId, deviceId), eq(logicalPathValues.name, name)))
    .limit(1);
  return rows[0]?.path ?? null;
}

export async function listLogicalPathValues(
  deviceId: string,
  database: AppDb = db
): Promise<Array<{ name: string; path: string; updatedAt: Date }>> {
  return database
    .select({ name: logicalPathValues.name, path: logicalPathValues.path, updatedAt: logicalPathValues.updatedAt })
    .from(logicalPathValues)
    .where(eq(logicalPathValues.deviceId, deviceId));
}

/** `null` deletes this device's value for the name. */
export async function setLogicalPathValue(
  deviceId: string,
  name: string,
  path: string | null,
  database: AppDb = db
): Promise<void> {
  if (path === null) {
    await database
      .delete(logicalPathValues)
      .where(and(eq(logicalPathValues.deviceId, deviceId), eq(logicalPathValues.name, name)));
    return;
  }
  const updatedAt = new Date();
  await database
    .insert(logicalPathValues)
    .values({ deviceId, name, path, updatedAt })
    .onConflictDoUpdate({
      target: [logicalPathValues.deviceId, logicalPathValues.name],
      set: { path, updatedAt },
    });
}

export type StoredFactoryAgentToken = { id: string; label: string | null; createdAt: Date; revokedAt: Date | null };

const factoryAgentTokenColumns = {
  id: factoryAgentTokens.id,
  label: factoryAgentTokens.label,
  createdAt: factoryAgentTokens.createdAt,
  revokedAt: factoryAgentTokens.revokedAt,
};

/** Factory Operator access. Revokes any active token and inserts the new one in ONE transaction, so
 * "at most one active factory token" can never be observed violated. */
export async function replaceFactoryAgentToken(
  input: { id: string; tokenHash: string; label: string | null },
  database: AppDb = db
): Promise<void> {
  const now = new Date();
  await database.transaction(async (tx) => {
    await tx.update(factoryAgentTokens).set({ revokedAt: now }).where(isNull(factoryAgentTokens.revokedAt));
    await tx.insert(factoryAgentTokens).values({ ...input, createdAt: now, revokedAt: null });
  });
}

/** Returns the number of tokens revoked (0 when there was no active token). */
export async function revokeFactoryAgentTokens(database: AppDb = db): Promise<number> {
  const revoked = await database
    .update(factoryAgentTokens)
    .set({ revokedAt: new Date() })
    .where(isNull(factoryAgentTokens.revokedAt))
    .returning({ id: factoryAgentTokens.id });
  return revoked.length;
}

/** Active (non-revoked) factory token by hash, or null. */
export async function findActiveFactoryAgentTokenByHash(
  tokenHash: string,
  database: AppDb = db
): Promise<StoredFactoryAgentToken | null> {
  const rows = await database
    .select(factoryAgentTokenColumns)
    .from(factoryAgentTokens)
    .where(and(eq(factoryAgentTokens.tokenHash, tokenHash), isNull(factoryAgentTokens.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** BL-130. Factory token row by hash whether active or revoked, or null (see `findAgentChannelTokenByHash`). */
export async function findFactoryAgentTokenByHash(
  tokenHash: string,
  database: AppDb = db
): Promise<StoredFactoryAgentToken | null> {
  const rows = await database
    .select(factoryAgentTokenColumns)
    .from(factoryAgentTokens)
    .where(eq(factoryAgentTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function listActiveFactoryAgentTokens(database: AppDb = db): Promise<StoredFactoryAgentToken[]> {
  return database.select(factoryAgentTokenColumns).from(factoryAgentTokens).where(isNull(factoryAgentTokens.revokedAt));
}

// BL-161: the Producer role's token -- the same four operations as the factory token's, on its own table.

export type StoredProducerAgentToken = StoredFactoryAgentToken;

const producerAgentTokenColumns = {
  id: producerAgentTokens.id,
  label: producerAgentTokens.label,
  createdAt: producerAgentTokens.createdAt,
  revokedAt: producerAgentTokens.revokedAt,
};

/** Revokes any active producer token and inserts the new one in ONE transaction (at most one active, also by index). */
export async function replaceProducerAgentToken(
  input: { id: string; tokenHash: string; label: string | null },
  database: AppDb = db
): Promise<void> {
  const now = new Date();
  await database.transaction(async (tx) => {
    await tx.update(producerAgentTokens).set({ revokedAt: now }).where(isNull(producerAgentTokens.revokedAt));
    await tx.insert(producerAgentTokens).values({ ...input, createdAt: now, revokedAt: null });
  });
}

/** Returns the number of tokens revoked (0 when there was no active token). */
export async function revokeProducerAgentTokens(database: AppDb = db): Promise<number> {
  const revoked = await database
    .update(producerAgentTokens)
    .set({ revokedAt: new Date() })
    .where(isNull(producerAgentTokens.revokedAt))
    .returning({ id: producerAgentTokens.id });
  return revoked.length;
}

export async function findActiveProducerAgentTokenByHash(
  tokenHash: string,
  database: AppDb = db
): Promise<StoredProducerAgentToken | null> {
  const rows = await database
    .select(producerAgentTokenColumns)
    .from(producerAgentTokens)
    .where(and(eq(producerAgentTokens.tokenHash, tokenHash), isNull(producerAgentTokens.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findProducerAgentTokenByHash(
  tokenHash: string,
  database: AppDb = db
): Promise<StoredProducerAgentToken | null> {
  const rows = await database
    .select(producerAgentTokenColumns)
    .from(producerAgentTokens)
    .where(eq(producerAgentTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function listActiveProducerAgentTokens(database: AppDb = db): Promise<StoredProducerAgentToken[]> {
  return database.select(producerAgentTokenColumns).from(producerAgentTokens).where(isNull(producerAgentTokens.revokedAt));
}

export type ProducerCallLogEntry = {
  id: number;
  at: Date;
  tool: string;
  channelId: string | null;
  outcome: "ok" | "error";
  errorCode: string | null;
};

/** How long a Producer call stays in the log (BL-161). */
export const PRODUCER_CALL_LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** BL-161: records one Producer tool call and drops rows older than the retention, in one transaction. */
export async function insertProducerCallLogEntry(
  entry: { at: Date; tool: string; channelId: string | null; outcome: "ok" | "error"; errorCode: string | null },
  database: AppDb = db
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(producerCallLog).values(entry);
    await tx.delete(producerCallLog).where(lt(producerCallLog.at, new Date(entry.at.getTime() - PRODUCER_CALL_LOG_RETENTION_MS)));
  });
}

/** BL-161: the newest Producer calls first. */
export async function listProducerCallLogEntries(limit: number, database: AppDb = db): Promise<ProducerCallLogEntry[]> {
  const rows = await database.select().from(producerCallLog).orderBy(desc(producerCallLog.at), desc(producerCallLog.id)).limit(limit);
  return rows.map((row) => ({ ...row, outcome: row.outcome === "ok" ? "ok" : "error" }));
}

export type GatewayTrafficCategory =
  | "data_api_reads"
  | "analytics_reads"
  | "live_writes"
  | "mcp_tool_calls"
  | "cloud_monitoring_reads"
  | "youtube_feed_reads"
  | "wikipedia_reads"
  | "reporting_reads"
  // Phase 14 -- the three media-gateway children (`src/lib/media-gateway/`), one counter each.
  | "runpod_api"
  | "runpod_s3"
  | "comfyui_api"
  // BL-132 -- the Hugging Face Hub metadata reads (`src/lib/media-gateway/huggingface.ts`).
  | "huggingface_api";

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
  "youtube_feed_reads",
  "wikipedia_reads",
  "reporting_reads",
  "runpod_api",
  "runpod_s3",
  "comfyui_api",
  "huggingface_api",
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

export type SyncFamily = "change_drafts" | "editorial_profile" | "ai_connections" | "media_sessions" | "generation_plans" | "media_settings";

const SYNC_FAMILIES: readonly SyncFamily[] = ["change_drafts", "editorial_profile", "ai_connections", "media_sessions", "generation_plans", "media_settings"];

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
    durationSeconds?: number | null;
    liveBroadcastContent?: string | null;
    publishAt?: string | null;
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
      durationSeconds: entry.durationSeconds ?? null,
      liveBroadcastContent: entry.liveBroadcastContent ?? null,
      publishAt: entry.publishAt ?? null,
      lastSyncedAt: syncedAt,
    };

    await db
      .insert(videos)
      .values(values)
      .onConflictDoUpdate({ target: videos.id, set: values });
  }
}

/**
 * After a Batch write was read back from YouTube and matched what was sent, the local copy of that video takes the confirmed values, so the
 * Languages table does not wait for the next Sync Now. Only the fields a batch can change are written; counts, thumbnails, `lastSyncedAt` and
 * the rest still belong to the real sync. Returns false when the video is not in this channel's local copy (nothing is created here).
 */
export async function applyConfirmedWriteToStoredVideo(input: {
  channelId: string;
  videoId: string;
  title: string;
  description: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  localizations: Record<string, LocaleMetadataRecord>;
}): Promise<boolean> {
  const updated = await db
    .update(videos)
    .set({
      title: input.title,
      description: input.description,
      defaultLanguage: input.defaultLanguage,
      defaultAudioLanguage: input.defaultAudioLanguage,
      localizationsJson: JSON.stringify(input.localizations),
    })
    .where(and(eq(videos.id, input.videoId), eq(videos.channelId, input.channelId)))
    .returning({ id: videos.id });
  return updated.length > 0;
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
  /** BL-117: ids of the batches this one was split into (it was never executed); null otherwise. */
  splitInto: string[] | null;
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
    splitInto: parseSplitInto(row.splitIntoJson),
  };
}

function parseSplitInto(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
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

/**
 * BL-125: deletes whole batches -- their audit events, attempts, stale video locks, ledger rows and the batch row itself, in
 * foreign-key order, in one transaction. Only the retention sweep calls this, and only for batches it has judged settled
 * (completed, every row SUCCESS or DRY_RUN_COMPLETE, older than the write-log retention).
 */
export async function deleteStoredBatchesWithChildren(batchIds: string[], database: AppDb = db): Promise<number> {
  if (batchIds.length === 0) return 0;
  return database.transaction(async (tx) => {
    let deleted = 0;
    for (const batchId of batchIds) {
      const rows = await tx.select({ id: batchLedgerRows.id }).from(batchLedgerRows).where(eq(batchLedgerRows.batchId, batchId));
      const rowIds = rows.map((row) => row.id);
      await tx.delete(auditEvents).where(eq(auditEvents.batchId, batchId));
      await tx.delete(videoExecutionLocks).where(eq(videoExecutionLocks.batchId, batchId));
      if (rowIds.length > 0) await tx.delete(batchAttempts).where(inArray(batchAttempts.ledgerRowId, rowIds));
      await tx.delete(batchLedgerRows).where(eq(batchLedgerRows.batchId, batchId));
      await tx.delete(batches).where(eq(batches.id, batchId));
      deleted += 1;
    }
    return deleted;
  });
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
 * BL-117 slice 2 -- splits a never-executed live batch because it needs more quota than is available: ALL in ONE transaction,
 * the new "fits" batch (first rows, in stored order), the new "rest" batch (everything else), and the ORIGINAL closed
 * (`ABORTED`, every row `CANCELLED`, `split_into_json` set). The original must still be `PENDING` with every row `PENDING`
 * (checked inside the transaction with guarded updates), so nothing that ever started can be split, a concurrent execute
 * claim loses cleanly, and after commit every original video sits in exactly one new batch -- none lost, none doubled.
 * Returns `null` (nothing changed) when the original was no longer splittable.
 */
export async function splitPendingBatchForQuota(
  input: {
    batchId: string;
    fitCount: number;
    fitsBatchId: string | null;
    restBatchId: string | null;
    newRowIds: () => string;
  },
  database: AppDb = db
): Promise<{ fitsBatchId: string | null; restBatchId: string | null; fitRows: number; restRows: number } | null> {
  return database.transaction(async (tx) => {
    const [original] = await tx.select().from(batches).where(eq(batches.id, input.batchId));
    if (!original || original.status !== "PENDING" || original.dryRun) return null;

    // Insertion order (SQLite rowid) is the batch's stored order: `created_at` has second precision and ids are random, so
    // neither can say which rows came first.
    const rows = await tx
      .select()
      .from(batchLedgerRows)
      .where(eq(batchLedgerRows.batchId, input.batchId))
      .orderBy(sql`rowid`);
    if (rows.length === 0 || rows.some((r) => r.status !== "PENDING")) return null;

    const fitCount = Math.min(Math.max(0, input.fitCount), rows.length);
    const fitRows = rows.slice(0, fitCount);
    const restRows = rows.slice(fitCount);
    if ((fitRows.length > 0 && !input.fitsBatchId) || (restRows.length > 0 && !input.restBatchId)) return null;

    const claim = await tx
      .update(batches)
      .set({ status: "ABORTED", completedAt: new Date() })
      .where(and(eq(batches.id, input.batchId), eq(batches.status, "PENDING")))
      .returning({ id: batches.id });
    if (claim.length === 0) return null;

    const createdIds: string[] = [];
    for (const [newId, part] of [
      [input.fitsBatchId, fitRows],
      [input.restBatchId, restRows],
    ] as const) {
      if (!newId || part.length === 0) continue;
      await tx.insert(batches).values({
        id: newId,
        channelId: original.channelId,
        status: "PENDING",
        concurrency: original.concurrency,
        dryRun: false,
      });
      for (const row of part) {
        await tx.insert(batchLedgerRows).values({
          id: input.newRowIds(),
          batchId: newId,
          videoId: row.videoId,
          changeIdsJson: row.changeIdsJson,
          status: "PENDING",
        });
      }
      createdIds.push(newId);
    }

    await tx
      .update(batchLedgerRows)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(batchLedgerRows.batchId, input.batchId), eq(batchLedgerRows.status, "PENDING")));
    await tx.update(batches).set({ splitIntoJson: JSON.stringify(createdIds) }).where(eq(batches.id, input.batchId));

    return {
      fitsBatchId: fitRows.length > 0 ? input.fitsBatchId : null,
      restBatchId: restRows.length > 0 ? input.restBatchId : null,
      fitRows: fitRows.length,
      restRows: restRows.length,
    };
  });
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
  | "RECONCILIATION"
  | "CANCELLED";

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

// --- Research export ledger (ADR 0019) --------------------------------------------------------------------

export type StoredWorkspaceExportFile = {
  id: string;
  channelId: string;
  exportsDir: string;
  fileName: string;
  dataset: string;
  format: string;
  rowCount: number;
  createdAt: Date;
  expiresAt: Date | null;
};

export async function insertWorkspaceExportFile(record: StoredWorkspaceExportFile, database: AppDb = db): Promise<void> {
  await database.insert(workspaceExportFiles).values(record);
}

/** Files not yet deleted whose expiry has passed (files with no expiry never appear). */
export async function listExpiredWorkspaceExportFiles(now: Date, database: AppDb = db): Promise<StoredWorkspaceExportFile[]> {
  const rows = await database
    .select()
    .from(workspaceExportFiles)
    .where(and(isNull(workspaceExportFiles.deletedAt), isNotNull(workspaceExportFiles.expiresAt), lte(workspaceExportFiles.expiresAt, now)));
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    exportsDir: row.exportsDir,
    fileName: row.fileName,
    dataset: row.dataset,
    format: row.format,
    rowCount: row.rowCount,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
}

export async function markWorkspaceExportFileDeleted(id: string, at: Date, database: AppDb = db): Promise<void> {
  await database.update(workspaceExportFiles).set({ deletedAt: at }).where(eq(workspaceExportFiles.id, id));
}

// --- BL-118: channel-level daily totals and per-video history coverage ------------------------------------

export type StoredChannelMetric = { channelId: string; metricDate: string; metricName: string; metricValue: number };

export async function saveChannelDailyMetric(input: StoredChannelMetric, database: AppDb = db): Promise<void> {
  const collectedAt = new Date();
  await database
    .insert(channelMetricsDaily)
    .values({ ...input, collectedAt })
    .onConflictDoUpdate({
      target: [channelMetricsDaily.channelId, channelMetricsDaily.metricDate, channelMetricsDaily.metricName],
      set: { metricValue: input.metricValue, collectedAt },
    });
}

/** Inclusive date range; oldest first. */
export async function listChannelMetricsInRange(
  channelId: string,
  range: { startDate: string; endDate: string },
  database: AppDb = db
): Promise<StoredChannelMetric[]> {
  const rows = await database
    .select()
    .from(channelMetricsDaily)
    .where(
      and(
        eq(channelMetricsDaily.channelId, channelId),
        gte(channelMetricsDaily.metricDate, range.startDate),
        sql`${channelMetricsDaily.metricDate} <= ${range.endDate}`
      )
    )
    .orderBy(asc(channelMetricsDaily.metricDate), asc(channelMetricsDaily.metricName));
  return rows.map((r) => ({ channelId: r.channelId, metricDate: r.metricDate, metricName: r.metricName, metricValue: r.metricValue }));
}

/** The latest time any channel-level row of this channel was collected (for the freshness note), or null. */
export async function getLatestChannelMetricCollectedAt(channelId: string, database: AppDb = db): Promise<Date | null> {
  const [row] = await database
    .select({ at: sql<number | null>`MAX(${channelMetricsDaily.collectedAt})` })
    .from(channelMetricsDaily)
    .where(eq(channelMetricsDaily.channelId, channelId));
  return row?.at ? new Date(Number(row.at) * 1000) : null;
}

export type StoredVideoHistory = { videoId: string; channelId: string; historyThrough: string };

export async function listVideoHistoryByChannel(channelId: string, database: AppDb = db): Promise<StoredVideoHistory[]> {
  const rows = await database.select().from(analyticsVideoHistory).where(eq(analyticsVideoHistory.channelId, channelId));
  return rows.map((r) => ({ videoId: r.videoId, channelId: r.channelId, historyThrough: r.historyThrough }));
}

/** Records that this video's daily metrics are collected from its publish date through `historyThrough`; never moves a later value back. */
export async function advanceVideoHistory(input: StoredVideoHistory, database: AppDb = db): Promise<void> {
  await database
    .insert(analyticsVideoHistory)
    .values({ videoId: input.videoId, channelId: input.channelId, historyThrough: input.historyThrough })
    .onConflictDoUpdate({
      target: analyticsVideoHistory.videoId,
      set: {
        channelId: input.channelId,
        historyThrough: sql`CASE WHEN ${analyticsVideoHistory.historyThrough} > ${input.historyThrough} THEN ${analyticsVideoHistory.historyThrough} ELSE ${input.historyThrough} END`,
        updatedAt: new Date(),
      },
    });
}

export type StoredAnalyticsCollectionRun = {
  id: number;
  channelId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  videoCount: number;
  upsertsIssued: number;
  skippedVideoIds: string[];
  /** BL-118: this run also collected the channel-level daily totals. */
  channelLevel: boolean;
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
    channelLevel?: boolean;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(analyticsCollectionRuns).values({
    channelLevel: input.channelLevel ? 1 : null,
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
    channelLevel: row.channelLevel === 1,
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

/**
 * One asset by its reference within a channel (Phase 14 review round 7: the media job pipeline asks
 * "is this local file already cataloged?" per pulled output -- one query on
 * `creative_assets_reference_idx` (schema v56), never a full channel listing scanned in JS). Newest
 * first when several rows share a reference.
 */
export async function getCreativeAssetByReference(
  channelId: string,
  referenceKind: string,
  referenceValue: string,
  database: AppDb = db
): Promise<StoredCreativeAsset | null> {
  const [row] = await database
    .select()
    .from(creativeAssets)
    .where(and(eq(creativeAssets.channelId, channelId), eq(creativeAssets.referenceKind, referenceKind), eq(creativeAssets.referenceValue, referenceValue)))
    .orderBy(desc(creativeAssets.createdAt))
    .limit(1);
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
    /** Set ONLY when Google issued a new refresh token (a (re)connection): the 7-day Testing-status limit counts from
     * it. A plain access-token refresh leaves it out, so the original date stays. */
    connectedAt?: Date;
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

// ---------------------------------------------------------------------------
// Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- media generation: credentials singleton,
// the settings blob and the gateway toggle. Read/written only through
// `src/lib/media-generation/adapters/store.ts` and `src/lib/media-gateway/`.
// ---------------------------------------------------------------------------

const MEDIA_CREDENTIALS_SINGLETON_ID = "default";

export type StoredMediaCredentials = {
  ciphertext: string;
  iv: string;
  authTag: string;
  runpodKeyPrefix: string;
  s3AccessKeyId: string | null;
  verifiedAt: Date | null;
  updatedAt: Date;
};

export async function getStoredMediaCredentials(database: AppDb = db): Promise<StoredMediaCredentials | null> {
  const [row] = await database.select().from(mediaCredentials).where(eq(mediaCredentials.id, MEDIA_CREDENTIALS_SINGLETON_ID));
  if (!row) return null;
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    runpodKeyPrefix: row.runpodKeyPrefix,
    s3AccessKeyId: row.s3AccessKeyId ?? null,
    verifiedAt: row.verifiedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Replaces the whole blob (a new key set); `verifiedAt` resets, since nothing has been tested yet. */
export async function upsertStoredMediaCredentials(
  input: { ciphertext: string; iv: string; authTag: string; runpodKeyPrefix: string; s3AccessKeyId: string | null },
  database: AppDb = db
): Promise<void> {
  const now = new Date();
  await database
    .insert(mediaCredentials)
    .values({ id: MEDIA_CREDENTIALS_SINGLETON_ID, ...input, verifiedAt: null, updatedAt: now })
    .onConflictDoUpdate({
      target: mediaCredentials.id,
      set: { ...input, verifiedAt: null, updatedAt: now },
    });
}

export async function setStoredMediaCredentialsVerifiedAt(verifiedAt: Date, database: AppDb = db): Promise<void> {
  await database.update(mediaCredentials).set({ verifiedAt }).where(eq(mediaCredentials.id, MEDIA_CREDENTIALS_SINGLETON_ID));
}

export async function clearStoredMediaCredentials(database: AppDb = db): Promise<void> {
  await database.delete(mediaCredentials).where(eq(mediaCredentials.id, MEDIA_CREDENTIALS_SINGLETON_ID));
}

const MEDIA_GENERATION_SETTINGS_KEY = "media_generation_settings";
const MEDIA_GATEWAY_ENABLED_SETTING_KEY = "media_gateway_enabled";
const MEDIA_MODEL_PULLS_KEY = "media_model_pulls";

/** Phase 14 slice 4: the model pulls in flight (CPU pods downloading onto the volume), as a JSON list; `null` = none ever. */
export async function getMediaModelPullsJson(database: AppDb = db): Promise<string | null> {
  return await getAppSetting(MEDIA_MODEL_PULLS_KEY, database);
}

export type MediaControlEventRow = { id: number; at: Date; actor: string; action: string; subject: string; detailsJson: string | null };

/** BL-132: appends one audit row (model pull/cancel/delete, template install/update/remove/sync). Never updated or deleted. */
/** BL-133: one createPod attempt; rows older than 90 days are pruned on the way. */
/** Returns the new row's id (BL-159: the host's CUDA is written onto that `placed` row once known). */
export async function insertMediaCapacityAttempt(
  row: { at: Date; sessionId: string; datacenterId: string | null; gpuTypeId: string; pricePerHr: number | null; result: string; detail: string | null; hostCudaVersion?: string | null },
  database: AppDb = db
): Promise<number> {
  const [inserted] = await database.insert(mediaCapacityAttempts).values(row).returning({ id: mediaCapacityAttempts.id });
  // The prune is housekeeping: its failure must not hide the new row's id (BL-159 writes the host's CUDA onto it later).
  await database
    .delete(mediaCapacityAttempts)
    .where(lt(mediaCapacityAttempts.at, new Date(row.at.getTime() - 90 * 24 * 60 * 60 * 1000)))
    .catch(() => undefined);
  return inserted.id;
}

/** BL-159: the host's CUDA version, once the host check reads it, on that placement's own capacity-log row. */
export async function setMediaCapacityAttemptHostCuda(id: number, hostCudaVersion: string, database: AppDb = db): Promise<void> {
  await database.update(mediaCapacityAttempts).set({ hostCudaVersion }).where(eq(mediaCapacityAttempts.id, id));
}

/** Newest first, optionally since a time and for one GPU type. */
export async function listMediaCapacityAttempts(
  filter: { since?: Date; gpuTypeId?: string; limit: number },
  database: AppDb = db
): Promise<Array<typeof mediaCapacityAttempts.$inferSelect>> {
  const conditions = [filter.since ? gte(mediaCapacityAttempts.at, filter.since) : undefined, filter.gpuTypeId ? eq(mediaCapacityAttempts.gpuTypeId, filter.gpuTypeId) : undefined].filter((c) => c !== undefined);
  return database
    .select()
    .from(mediaCapacityAttempts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(mediaCapacityAttempts.at), desc(mediaCapacityAttempts.id))
    .limit(filter.limit);
}

export async function insertMediaControlEvent(
  row: { at: Date; actor: string; action: string; subject: string; detailsJson: string | null },
  database: AppDb = db
): Promise<void> {
  await database.insert(mediaControlEvents).values(row);
}

/** Newest first. */
export async function listMediaControlEvents(limit: number, database: AppDb = db): Promise<MediaControlEventRow[]> {
  return database.select().from(mediaControlEvents).orderBy(desc(mediaControlEvents.at), desc(mediaControlEvents.id)).limit(limit);
}

const MEDIA_VOLUME_LOCK_KEY = "media_volume_lock";

/**
 * Phase 14 review round 9 (`src/lib/media-generation/volume-lock.ts`): the one "network volume is busy"
 * row. `app_settings.key` is the primary key, so the insert is the atomic test-and-set -- a session
 * approve and a model pull cannot both hold it. Returns whoever holds it afterwards.
 */
/**
 * The row's value is JSON `{ owner, since }` (review round 13: the age tells a crash-stale lock from a fresh one;
 * round 16: JSON, so an owner name with spaces, `_`/`%`, or non-BMP characters is matched exactly by `json_extract`).
 */
function parseMediaVolumeLockValue(value: string): { owner: string; since: Date } {
  try {
    const parsed = JSON.parse(value) as { owner?: unknown; since?: unknown };
    if (typeof parsed.owner === "string" && typeof parsed.since === "number" && Number.isFinite(parsed.since)) return { owner: parsed.owner, since: new Date(parsed.since) };
  } catch {
    // a pre-JSON value (never shipped; defensive)
  }
  return { owner: value, since: new Date(0) };
}

export async function tryAcquireMediaVolumeLock(
  owner: string,
  at: Date,
  database: AppDb = db
): Promise<{ acquired: boolean; holder: { owner: string; since: Date } | null; activeSessions: number }> {
  // The holder may release between a no-op insert and the read-back; a null read-back then means "nobody holds it",
  // never "we do" -- insert again (review round 10). `acquired` is true only with OUR row in the table.
  // Slice 6: the row is the EXCLUSIVE hold (a pull, an operator pod); generation sessions hold the volume SHARED by
  // being active rows, so the insert itself is guarded by "no active session" -- the mirror of the approve UPDATE's
  // "no lock row" guard (`approveMediaSessionGuarded`), one statement each.
  const value = JSON.stringify({ owner, since: at.getTime() });
  for (let attempt = 0; attempt < 5; attempt++) {
    await database.run(
      sql`INSERT INTO app_settings (key, value) SELECT ${MEDIA_VOLUME_LOCK_KEY}, ${value} WHERE NOT EXISTS (SELECT 1 FROM media_sessions WHERE status IN ${[...MEDIA_SESSION_ACTIVE_STATUSES]}) ON CONFLICT(key) DO NOTHING`
    );
    const stored = await getAppSetting(MEDIA_VOLUME_LOCK_KEY, database);
    if (stored !== null) {
      const holder = parseMediaVolumeLockValue(stored);
      // Ours only if it is OUR row (owner and acquire time): a row the same owner inserted earlier is "already held".
      return { acquired: holder.owner === owner && holder.since.getTime() === at.getTime(), holder, activeSessions: 0 };
    }
    const activeSessions = await countActiveMediaSessions(database);
    if (activeSessions > 0) return { acquired: false, holder: null, activeSessions };
  }
  return { acquired: false, holder: { owner: "unknown (the lock row kept vanishing between insert and read)", since: at }, activeSessions: 0 };
}

/** Deletes the row only when `owner` holds it (never another owner's lock). */
export async function releaseMediaVolumeLock(owner: string, database: AppDb = db): Promise<boolean> {
  const rows = await database
    .delete(appSettings)
    // Exact owner match on the JSON field: never a prefix/LIKE comparison that a space, `_`/`%` or a non-BMP character could fool.
    .where(and(eq(appSettings.key, MEDIA_VOLUME_LOCK_KEY), sql`json_extract(${appSettings.value}, '$.owner') = ${owner}`))
    .returning({ key: appSettings.key });
  return rows.length > 0;
}

export async function getMediaVolumeLockHolder(database: AppDb = db): Promise<{ owner: string; since: Date } | null> {
  const stored = await getAppSetting(MEDIA_VOLUME_LOCK_KEY, database);
  return stored === null ? null : parseMediaVolumeLockValue(stored);
}

/**
 * The only writer: a read-modify-write of the pulls list as a compare-and-swap (the single guarded
 * UPDATE/INSERT idiom this file uses everywhere -- see `claimBatchExecution` and the note above
 * `claimVideoExecution` on why an explicit multi-statement transaction is NOT used across separate
 * connections), so the web server's watch loop and the operator CLI -- separate processes -- never
 * overwrite each other's change (review rounds 6 and 12). A lost race re-reads and re-applies `mutate`.
 */
export async function updateMediaModelPullsJson(mutate: (current: string | null) => string, database: AppDb = db): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await getAppSetting(MEDIA_MODEL_PULLS_KEY, database);
    const next = mutate(current);
    if (current === null) {
      await database.insert(appSettings).values({ key: MEDIA_MODEL_PULLS_KEY, value: next }).onConflictDoNothing();
      if ((await getAppSetting(MEDIA_MODEL_PULLS_KEY, database)) === next) return next;
      continue; // someone else inserted first: re-read and re-apply
    }
    const rows = await database
      .update(appSettings)
      .set({ value: next })
      .where(and(eq(appSettings.key, MEDIA_MODEL_PULLS_KEY), eq(appSettings.value, current)))
      .returning({ key: appSettings.key });
    if (rows.length > 0) return next;
  }
  throw new Error("the model pulls list kept changing under this update (10 attempts); try again");
}

/** The Settings → Media values as one JSON string (validated by `src/lib/media-generation/schemas.ts`); `null` = never saved. */
export async function getMediaGenerationSettingsJson(database: AppDb = db): Promise<string | null> {
  return await getAppSetting(MEDIA_GENERATION_SETTINGS_KEY, database);
}

export async function setMediaGenerationSettingsJson(json: string, database: AppDb = db): Promise<void> {
  await setAppSetting(MEDIA_GENERATION_SETTINGS_KEY, json, database);
}

/** Phase 14: the media gateway (RunPod API, S3 API, ComfyUI) toggle. On unless turned off, persistent, like the read toggles. */
export async function getMediaGatewayEnabled(database: AppDb = db): Promise<boolean> {
  return (await getAppSetting(MEDIA_GATEWAY_ENABLED_SETTING_KEY, database)) !== "false";
}

export async function setMediaGatewayEnabled(enabled: boolean, database: AppDb = db): Promise<void> {
  await setAppSetting(MEDIA_GATEWAY_ENABLED_SETTING_KEY, enabled ? "true" : "false", database);
}

// -- media_sessions (Phase 14 slice 2); read/written only by src/lib/media-generation/adapters/session-store.ts --

export type StoredMediaSession = typeof mediaSessions.$inferSelect;
export type NewStoredMediaSession = typeof mediaSessions.$inferInsert;


/** Slice 6: never a conflict any more -- concurrent sessions are bounded at approve, not at request. */
export async function insertMediaSession(row: NewStoredMediaSession, database: AppDb = db): Promise<StoredMediaSession> {
  const [inserted] = await database
    .insert(mediaSessions)
    .values({ ...row, openSlot: 1 })
    .returning();
  return inserted;
}

export async function getMediaSessionById(id: string, database: AppDb = db): Promise<StoredMediaSession | null> {
  const [row] = await database.select().from(mediaSessions).where(eq(mediaSessions.id, id));
  return row ?? null;
}

/** Every non-terminal session (pending included), oldest first. */
export async function listOpenMediaSessions(database: AppDb = db): Promise<StoredMediaSession[]> {
  return database.select().from(mediaSessions).where(eq(mediaSessions.openSlot, 1)).orderBy(asc(mediaSessions.createdAt), asc(mediaSessions.id));
}

/**
 * Slice 6 (PHASE_14_PLAN.md §5.2, AC-P14-22/23): `pending -> approved` as ONE statement guarded by
 * (a) fewer than `maxActive` sessions holding a pod and (b) no exclusive volume-lock row (a model pull or an
 * operator pod writing the volume). SQLite serializes writers, so two approves -- or an approve and a pull's
 * lock insert (`tryAcquireMediaVolumeLock`, guarded the other way round) -- can never both pass. `null` = one of
 * the guards (or the row's status) refused; the caller re-reads to say which.
 */
export async function approveMediaSessionGuarded(
  id: string,
  set: Partial<Omit<NewStoredMediaSession, "id" | "openSlot" | "status">>,
  maxActive: number,
  database: AppDb = db
): Promise<StoredMediaSession | null> {
  const rows = await database
    .update(mediaSessions)
    .set({ ...set, status: "approved", openSlot: 1 })
    .where(
      and(
        eq(mediaSessions.id, id),
        eq(mediaSessions.status, "pending"),
        sql`(SELECT count(*) FROM media_sessions WHERE status IN ${[...MEDIA_SESSION_ACTIVE_STATUSES]}) < ${maxActive}`,
        sql`NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ${MEDIA_VOLUME_LOCK_KEY})`
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function countActiveMediaSessions(database: AppDb = db): Promise<number> {
  const [row] = await database.select({ n: sql<number>`count(*)` }).from(mediaSessions).where(inArray(mediaSessions.status, [...MEDIA_SESSION_ACTIVE_STATUSES]));
  return Number(row?.n ?? 0);
}

/** Newest first; `channelId` filters IN the query (never a post-filter of a capped page -- review round 6). */
export async function listMediaSessions(limit = 50, channelId?: string, database: AppDb = db): Promise<StoredMediaSession[]> {
  return database
    .select()
    .from(mediaSessions)
    .where(channelId ? eq(mediaSessions.channelId, channelId) : undefined)
    .orderBy(desc(mediaSessions.createdAt))
    .limit(limit);
}

/** Sessions whose pod bills in the window (for the daily spend): started, with no stop yet, or started/stopped on or after `since`. */
export async function listMediaSessionsBillableSince(since: Date, database: AppDb = db): Promise<StoredMediaSession[]> {
  return database
    .select()
    .from(mediaSessions)
    .where(and(isNotNull(mediaSessions.startedAt), or(isNull(mediaSessions.stoppedAt), gte(mediaSessions.startedAt, since), gte(mediaSessions.stoppedAt, since))));
}

/**
 * The one atomic transition: `UPDATE ... WHERE id = ? AND status IN (from) RETURNING`. A terminal
 * target frees the open slot in the same statement. `null` = the row was not in one of `from`.
 */
export async function transitionMediaSession(
  id: string,
  from: readonly MediaSessionStatusValue[],
  set: Partial<Omit<NewStoredMediaSession, "id" | "openSlot">> & { status: MediaSessionStatusValue },
  database: AppDb = db
): Promise<StoredMediaSession | null> {
  const rows = await database
    .update(mediaSessions)
    .set({ ...set, openSlot: MEDIA_SESSION_TERMINAL_STATUSES.includes(set.status) ? null : 1 })
    .where(and(eq(mediaSessions.id, id), inArray(mediaSessions.status, [...from])))
    .returning();
  return rows[0] ?? null;
}

export async function touchMediaSessionActivity(id: string, at: Date, database: AppDb = db): Promise<void> {
  await database.update(mediaSessions).set({ lastActivityAt: at }).where(and(eq(mediaSessions.id, id), eq(mediaSessions.status, "running")));
}

/** The watcher saw the pod alive (schema v54); only a non-terminal row takes it. */
export async function markMediaSessionSeenAlive(id: string, at: Date, database: AppDb = db): Promise<void> {
  await database
    .update(mediaSessions)
    .set({ lastSeenAliveAt: at })
    .where(and(eq(mediaSessions.id, id), notInArray(mediaSessions.status, [...MEDIA_SESSION_TERMINAL_STATUSES])));
}

// -- media_workflow_templates / media_jobs / media_exchange_files (Phase 14 slice 3); read/written only by
// src/lib/media-generation/adapters/job-store.ts --

export type StoredMediaWorkflowTemplate = typeof mediaWorkflowTemplates.$inferSelect;
export type StoredMediaJob = typeof mediaJobs.$inferSelect;
export type NewStoredMediaJob = typeof mediaJobs.$inferInsert;
export type StoredMediaExchangeFile = typeof mediaExchangeFiles.$inferSelect;

export async function insertMediaWorkflowTemplate(
  row: { id: string; name: string; description: string | null; workflowJson: string; parametersJson: string; outputNodeIdsJson?: string; nodeCount?: number; modelsJson?: string },
  database: AppDb = db
): Promise<StoredMediaWorkflowTemplate> {
  const now = new Date();
  const [inserted] = await database
    .insert(mediaWorkflowTemplates)
    .values({ ...row, version: 1, createdAt: now, updatedAt: now })
    .returning();
  return inserted;
}

/** Replaces the graph/parameters and bumps `version`; `null` = no such template. */
export async function updateMediaWorkflowTemplate(
  id: string,
  patch: { name?: string; description?: string | null; workflowJson?: string; parametersJson?: string; outputNodeIdsJson?: string; nodeCount?: number; modelsJson?: string },
  database: AppDb = db
): Promise<StoredMediaWorkflowTemplate | null> {
  const rows = await database
    .update(mediaWorkflowTemplates)
    // `version` is what job provenance records: it moves only when the graph or the parameters change (review round 9).
    .set({ ...patch, ...(patch.workflowJson !== undefined || patch.parametersJson !== undefined ? { version: sql`${mediaWorkflowTemplates.version} + 1` } : {}), updatedAt: new Date() })
    .where(eq(mediaWorkflowTemplates.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function getMediaWorkflowTemplateById(id: string, database: AppDb = db): Promise<StoredMediaWorkflowTemplate | null> {
  const [row] = await database.select().from(mediaWorkflowTemplates).where(eq(mediaWorkflowTemplates.id, id));
  return row ?? null;
}

export async function listMediaWorkflowTemplates(database: AppDb = db): Promise<StoredMediaWorkflowTemplate[]> {
  return database.select().from(mediaWorkflowTemplates).orderBy(asc(mediaWorkflowTemplates.name));
}

/**
 * BL-132: installs or replaces a template from the factory registry under its registry id and version. Never touches an
 * owner-imported row with the same id: the upsert's update applies only to a `factory` row, and `null` means the id is
 * taken by a local template.
 */
export async function upsertFactoryMediaWorkflowTemplate(
  row: { id: string; name: string; description: string | null; version: number; workflowJson: string; parametersJson: string; outputNodeIdsJson: string; nodeCount: number; registrySha256: string; modelsJson: string; gpuJson: string | null; minCudaVersion: string | null },
  database: AppDb = db
): Promise<StoredMediaWorkflowTemplate | null> {
  const now = new Date();
  const { id, ...rest } = row;
  const rows = await database
    .insert(mediaWorkflowTemplates)
    .values({ ...row, source: "factory", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: mediaWorkflowTemplates.id, set: { ...rest, updatedAt: now }, setWhere: eq(mediaWorkflowTemplates.source, "factory") })
    .returning();
  return rows[0] && rows[0].id === id && rows[0].source === "factory" ? rows[0] : null;
}

const MEDIA_TEMPLATE_SYNC_LAST_KEY = "media_template_sync_last";

/** BL-132: the last template-registry sync result (JSON), shown in the Web UI and the factory tool. */
export async function getMediaTemplateSyncLastJson(database: AppDb = db): Promise<string | null> {
  return getAppSetting(MEDIA_TEMPLATE_SYNC_LAST_KEY, database);
}

export async function setMediaTemplateSyncLastJson(json: string, database: AppDb = db): Promise<void> {
  await setAppSetting(MEDIA_TEMPLATE_SYNC_LAST_KEY, json, database);
}

/** FO-REQ-0005: local templates the Factory Operator is taking over into the registry (`parseTemplateAdoptions`). */
const MEDIA_TEMPLATE_ADOPTIONS_KEY = "media_template_adoptions";

export async function getMediaTemplateAdoptionsJson(database: AppDb = db): Promise<string | null> {
  return getAppSetting(MEDIA_TEMPLATE_ADOPTIONS_KEY, database);
}

export async function setMediaTemplateAdoptionsJson(json: string, database: AppDb = db): Promise<void> {
  await setAppSetting(MEDIA_TEMPLATE_ADOPTIONS_KEY, json, database);
}

export async function deleteMediaWorkflowTemplate(id: string, database: AppDb = db): Promise<boolean> {
  const rows = await database.delete(mediaWorkflowTemplates).where(eq(mediaWorkflowTemplates.id, id)).returning({ id: mediaWorkflowTemplates.id });
  return rows.length > 0;
}

/** BL-135: how many jobs a session has, how many are not finished, how many failed (BL-155), and when the last one finished. */
export async function getMediaSessionJobSummary(sessionId: string, database: AppDb = db): Promise<{ total: number; open: number; failed: number; lastFinishedAt: Date | null }> {
  const rows = await database.select({ status: mediaJobs.status, finishedAt: mediaJobs.finishedAt }).from(mediaJobs).where(eq(mediaJobs.sessionId, sessionId));
  const finished = rows.map((r) => r.finishedAt).filter((d): d is Date => d instanceof Date);
  return {
    total: rows.length,
    open: rows.filter((r) => !["done", "failed", "cancelled"].includes(r.status)).length,
    failed: rows.filter((r) => r.status === "failed").length,
    lastFinishedAt: finished.length > 0 ? new Date(Math.max(...finished.map((d) => d.getTime()))) : null,
  };
}

export async function insertMediaJob(row: NewStoredMediaJob, database: AppDb = db): Promise<StoredMediaJob> {
  const [inserted] = await database.insert(mediaJobs).values(row).returning();
  return inserted;
}

export async function getMediaJobById(id: string, database: AppDb = db): Promise<StoredMediaJob | null> {
  const [row] = await database.select().from(mediaJobs).where(eq(mediaJobs.id, id));
  return row ?? null;
}

export async function listMediaJobs(filter: { sessionId?: string; channelId?: string; limit?: number }, database: AppDb = db): Promise<StoredMediaJob[]> {
  const conditions = [];
  if (filter.sessionId) conditions.push(eq(mediaJobs.sessionId, filter.sessionId));
  if (filter.channelId) conditions.push(eq(mediaJobs.channelId, filter.channelId));
  const query = database.select().from(mediaJobs);
  const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;
  return filtered.orderBy(desc(mediaJobs.createdAt)).limit(filter.limit ?? 50);
}

/** BL-148: a session's job count per status (all of its jobs, no cap). */
export async function countMediaJobsForSessionByStatus(sessionId: string, database: AppDb = db): Promise<Record<string, number>> {
  const rows = await database.select({ status: mediaJobs.status, n: sql<number>`count(*)` }).from(mediaJobs).where(eq(mediaJobs.sessionId, sessionId)).groupBy(mediaJobs.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/** BL-148: a session's unfinished jobs in the order they run -- the running ones first, then the queue, oldest first. */
export async function listOpenMediaJobsForSession(sessionId: string, limit: number, database: AppDb = db): Promise<StoredMediaJob[]> {
  return database
    .select()
    .from(mediaJobs)
    .where(and(eq(mediaJobs.sessionId, sessionId), inArray(mediaJobs.status, ["queued", "submitted", "generating", "transferring"])))
    .orderBy(sql`CASE WHEN ${mediaJobs.status} = 'queued' THEN 1 ELSE 0 END`, asc(mediaJobs.createdAt), sql`rowid`)
    .limit(limit);
}

export async function listNonTerminalMediaJobs(database: AppDb = db): Promise<StoredMediaJob[]> {
  return database.select().from(mediaJobs).where(inArray(mediaJobs.status, ["queued", "submitted", "generating", "transferring"]));
}

export async function transitionMediaJob(
  id: string,
  from: readonly MediaJobStatusValue[],
  set: Partial<Omit<NewStoredMediaJob, "id">> & { status: MediaJobStatusValue },
  database: AppDb = db
): Promise<StoredMediaJob | null> {
  const rows = await database
    .update(mediaJobs)
    .set(set)
    .where(and(eq(mediaJobs.id, id), inArray(mediaJobs.status, [...from])))
    .returning();
  return rows[0] ?? null;
}

// -- BL-143 (ADR 0029): generation plans ----------------------------------------------------------------------------------

export type StoredGenerationPlan = typeof generationPlans.$inferSelect;
export type StoredGenerationPlanResult = typeof generationPlanResults.$inferSelect;
export type StoredGenerationPlanEvent = typeof generationPlanEvents.$inferSelect;

/** `null` when a plan with this id already exists (the id is chosen by the caller). */
export async function insertGenerationPlan(row: typeof generationPlans.$inferInsert, database: AppDb = db): Promise<StoredGenerationPlan | null> {
  const rows = await database.insert(generationPlans).values(row).onConflictDoNothing().returning();
  return rows[0] ?? null;
}

export async function getGenerationPlan(id: string, database: AppDb = db): Promise<StoredGenerationPlan | null> {
  const [row] = await database.select().from(generationPlans).where(eq(generationPlans.id, id));
  return row ?? null;
}

export async function listGenerationPlans(filter: { status?: StoredGenerationPlan["status"]; channelId?: string }, database: AppDb = db): Promise<StoredGenerationPlan[]> {
  const conditions = [filter.status ? eq(generationPlans.status, filter.status) : undefined, filter.channelId ? eq(generationPlans.channelId, filter.channelId) : undefined].filter((c) => c !== undefined);
  const query = database.select().from(generationPlans);
  return (conditions.length > 0 ? query.where(and(...conditions)) : query).orderBy(desc(generationPlans.updatedAt)).limit(500);
}

/** Compare-and-swap on `revision`: `null` when the plan changed meanwhile (or does not exist). */
export async function updateGenerationPlan(
  id: string,
  expectedRevision: number,
  set: Partial<Omit<typeof generationPlans.$inferInsert, "id" | "revision">>,
  database: AppDb = db
): Promise<StoredGenerationPlan | null> {
  const rows = await database
    .update(generationPlans)
    .set({ ...set, revision: expectedRevision + 1 })
    .where(and(eq(generationPlans.id, id), eq(generationPlans.revision, expectedRevision)))
    .returning();
  return rows[0] ?? null;
}

/** Inserts or replaces each (plan, stage, item, attempt) row, all in one transaction. */
export async function upsertGenerationPlanResults(rows: Array<typeof generationPlanResults.$inferInsert>, database: AppDb = db): Promise<void> {
  if (rows.length === 0) return;
  await database.transaction(async (tx) => {
    for (const row of rows) {
      const replaced = {
        result: row.result,
        reportedBy: row.reportedBy,
        note: row.note ?? null,
        rating: row.rating ?? null,
        reasonsJson: row.reasonsJson ?? null,
        markersJson: row.markersJson ?? null,
        auditionFile: row.auditionFile ?? null,
        checksJson: row.checksJson ?? null,
        metricsJson: row.metricsJson ?? null,
        referenceIdsJson: row.referenceIdsJson ?? null,
        at: row.at,
      };
      await tx
        .insert(generationPlanResults)
        .values(row)
        .onConflictDoUpdate({ target: [generationPlanResults.planId, generationPlanResults.stageId, generationPlanResults.itemKey, generationPlanResults.attemptRef], set: replaced });
    }
  });
}

export async function listGenerationPlanResults(planId: string, database: AppDb = db): Promise<StoredGenerationPlanResult[]> {
  return database.select().from(generationPlanResults).where(eq(generationPlanResults.planId, planId)).orderBy(asc(generationPlanResults.at));
}

export async function insertGenerationPlanEvent(row: Omit<typeof generationPlanEvents.$inferInsert, "id">, database: AppDb = db): Promise<void> {
  await database.insert(generationPlanEvents).values(row);
}

export async function listGenerationPlanEvents(planId: string, database: AppDb = db): Promise<StoredGenerationPlanEvent[]> {
  // The newest 5000 (a long plan's oldest events drop off, never its new ones), returned oldest first.
  const rows = await database.select().from(generationPlanEvents).where(eq(generationPlanEvents.planId, planId)).orderBy(desc(generationPlanEvents.at), desc(generationPlanEvents.id)).limit(5000);
  return rows.reverse();
}

export type StoredGenerationPlanPeerVerdict = typeof generationPlanPeerVerdicts.$inferSelect;

export async function insertGenerationPlanPeerVerdict(row: typeof generationPlanPeerVerdicts.$inferInsert, database: AppDb = db): Promise<void> {
  await database.insert(generationPlanPeerVerdicts).values(row);
}

/** The peer verdicts given since `sinceIso` (newest 1000), oldest first; older ones are deleted (kept 30 days by the caller). */
export async function listGenerationPlanPeerVerdicts(sinceIso: string, database: AppDb = db): Promise<StoredGenerationPlanPeerVerdict[]> {
  await database.delete(generationPlanPeerVerdicts).where(lt(generationPlanPeerVerdicts.at, sinceIso));
  const rows = await database.select().from(generationPlanPeerVerdicts).orderBy(desc(generationPlanPeerVerdicts.at)).limit(1000);
  return rows.reverse();
}

export type StoredGenerationPlanVerdictHistory = typeof generationPlanVerdictHistory.$inferSelect;

/** BL-157 (AC-TC-05): one owner verdict appended to the plan's verdict history. */
export async function insertGenerationPlanVerdictHistory(row: typeof generationPlanVerdictHistory.$inferInsert, database: AppDb = db): Promise<void> {
  await database.insert(generationPlanVerdictHistory).values(row);
}

/** A plan's verdict history, oldest first (by the time given, then the order recorded). */
export async function listGenerationPlanVerdictHistory(planId: string, database: AppDb = db): Promise<StoredGenerationPlanVerdictHistory[]> {
  return database.select().from(generationPlanVerdictHistory).where(eq(generationPlanVerdictHistory.planId, planId)).orderBy(asc(generationPlanVerdictHistory.at), asc(generationPlanVerdictHistory.id)).limit(20_000);
}

export type StoredGenerationPlanReviewClaim = typeof generationPlanReviewClaims.$inferSelect;

/** BL-157 (AC-TC-01): sets this device's claim (one per id; the caller decides the id, so a track claim moves in place). */
export async function upsertGenerationPlanReviewClaim(row: typeof generationPlanReviewClaims.$inferInsert, database: AppDb = db): Promise<void> {
  await database
    .insert(generationPlanReviewClaims)
    .values(row)
    .onConflictDoUpdate({ target: generationPlanReviewClaims.claimId, set: { planId: row.planId, ownerDeviceId: row.ownerDeviceId, scope: row.scope, itemKey: row.itemKey ?? null, attemptRef: row.attemptRef ?? null, groupId: row.groupId ?? null, since: row.since, until: row.until } });
}

export async function deleteGenerationPlanReviewClaim(claimId: string, database: AppDb = db): Promise<void> {
  await database.delete(generationPlanReviewClaims).where(eq(generationPlanReviewClaims.claimId, claimId));
}

/** This device's live claims (expired ones are deleted first). */
export async function listGenerationPlanReviewClaims(now: Date, database: AppDb = db): Promise<StoredGenerationPlanReviewClaim[]> {
  await database.delete(generationPlanReviewClaims).where(lte(generationPlanReviewClaims.until, now));
  return database.select().from(generationPlanReviewClaims).orderBy(asc(generationPlanReviewClaims.since)).limit(200);
}

/** Every job of a plan (no limit beyond a safety cap: a plan has at most a few thousand attempts). */
export async function listMediaJobsByPlan(planId: string, database: AppDb = db): Promise<StoredMediaJob[]> {
  return database.select().from(mediaJobs).where(eq(mediaJobs.planId, planId)).orderBy(asc(mediaJobs.createdAt)).limit(10_000);
}

/**
 * Links an existing job to a plan attempt (a plan import naming `job:<id>`): only a job of the plan's channel that is not
 * part of a plan yet. `true` when this call linked it.
 */
export async function linkMediaJobToPlan(
  jobId: string,
  link: { planId: string; stageId: string; itemKey: string; channelId: string },
  database: AppDb = db
): Promise<boolean> {
  const rows = await database
    .update(mediaJobs)
    .set({ planId: link.planId, planStageId: link.stageId, planItemKey: link.itemKey })
    .where(and(eq(mediaJobs.id, jobId), eq(mediaJobs.channelId, link.channelId), isNull(mediaJobs.planId)))
    .returning({ id: mediaJobs.id });
  return rows.length > 0;
}

/** Sets a session's plan when it has none (or already this one); `true` when the session now works for this plan. */
export async function linkMediaSessionToPlan(sessionId: string, planId: string, database: AppDb = db): Promise<boolean> {
  const rows = await database
    .update(mediaSessions)
    .set({ planId })
    .where(and(eq(mediaSessions.id, sessionId), or(isNull(mediaSessions.planId), eq(mediaSessions.planId, planId))))
    .returning({ id: mediaSessions.id });
  return rows.length > 0;
}

/**
 * The sessions a plan's spend counts: those linked to it, plus sessions in no plan that ran one of its jobs (FO-MSG-0010: an
 * imported plan's jobs came from sessions started before the plan existed). A session of another plan is never counted here.
 */
export async function listMediaSessionsByPlan(planId: string, database: AppDb = db): Promise<Array<typeof mediaSessions.$inferSelect>> {
  const ranJobs = database.select({ sessionId: mediaJobs.sessionId }).from(mediaJobs).where(eq(mediaJobs.planId, planId));
  return database
    .select()
    .from(mediaSessions)
    .where(or(eq(mediaSessions.planId, planId), and(isNull(mediaSessions.planId), inArray(mediaSessions.id, ranJobs))))
    .orderBy(asc(mediaSessions.createdAt))
    .limit(1000);
}

export async function upsertMediaExchangeFile(
  row: { remoteKey: string; jobId: string; localPath: string; bytes: number; sha256: string; pulledAt: Date },
  database: AppDb = db
): Promise<void> {
  await database
    .insert(mediaExchangeFiles)
    .values({ ...row, remoteDeletedAt: null })
    .onConflictDoUpdate({ target: mediaExchangeFiles.remoteKey, set: { ...row, remoteDeletedAt: null } });
}

export async function markMediaExchangeFileRemoteDeleted(remoteKey: string, at: Date, database: AppDb = db): Promise<void> {
  await database.update(mediaExchangeFiles).set({ remoteDeletedAt: at }).where(eq(mediaExchangeFiles.remoteKey, remoteKey));
}

export type StoredMediaExchangeInput = typeof mediaExchangeInputs.$inferSelect;

/** BL-132: one job input file uploaded to the volume (the janitor deletes it by this ledger once the job is terminal). */
export async function insertMediaExchangeInput(
  row: { remoteKey: string; jobId: string; parameter: string; sourcePath: string; bytes: number; sha256: string; uploadedAt: Date },
  database: AppDb = db
): Promise<void> {
  await database.insert(mediaExchangeInputs).values({ ...row, remoteDeletedAt: null }).onConflictDoNothing();
}

export async function listMediaExchangeInputsByJob(jobId: string, database: AppDb = db): Promise<StoredMediaExchangeInput[]> {
  return database.select().from(mediaExchangeInputs).where(eq(mediaExchangeInputs.jobId, jobId)).orderBy(asc(mediaExchangeInputs.parameter));
}

export async function getMediaExchangeInput(remoteKey: string, database: AppDb = db): Promise<StoredMediaExchangeInput | null> {
  const [row] = await database.select().from(mediaExchangeInputs).where(eq(mediaExchangeInputs.remoteKey, remoteKey));
  return row ?? null;
}

export async function markMediaExchangeInputRemoteDeleted(remoteKey: string, at: Date, database: AppDb = db): Promise<void> {
  await database.update(mediaExchangeInputs).set({ remoteDeletedAt: at }).where(eq(mediaExchangeInputs.remoteKey, remoteKey));
}

export async function getMediaExchangeFile(remoteKey: string, database: AppDb = db): Promise<StoredMediaExchangeFile | null> {
  const [row] = await database.select().from(mediaExchangeFiles).where(eq(mediaExchangeFiles.remoteKey, remoteKey));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Phase 9 slice 1 (`docs/roadmap/plans/PHASE_9_PLAN.md`) -- market-research watchlist. Read/
// written only by `src/lib/market-intelligence/adapters/store.ts`.
// ---------------------------------------------------------------------------

export type StoredResearchChannel = {
  id: string;
  handleOrUrl: string | null;
  reason: string;
  createdVia: string;
  addedAt: Date;
  lastAutoCollectedAt: Date | null;
  collectionClaimedAt: Date | null;
  maxVideosPerChannel: number | null;
  publishedAfter: string | null;
  videosComplete: number | null;
  videosCompleteReason: string | null;
  videosNextPageToken: string | null;
  videosCapAtRun: number | null;
  videosPublishedAfterAtRun: string | null;
};

export async function insertResearchChannel(
  input: { id: string; handleOrUrl?: string | null; reason: string; createdVia: string },
  database: AppDb = db
): Promise<void> {
  await database.insert(researchChannels).values({
    id: input.id,
    handleOrUrl: input.handleOrUrl ?? null,
    reason: input.reason,
    createdVia: input.createdVia,
  });
}

export async function listResearchChannels(database: AppDb = db): Promise<StoredResearchChannel[]> {
  return database.select().from(researchChannels).orderBy(desc(researchChannels.addedAt));
}

export async function getResearchChannelById(
  id: string,
  database: AppDb = db
): Promise<StoredResearchChannel | null> {
  const [row] = await database.select().from(researchChannels).where(eq(researchChannels.id, id));
  return row ?? null;
}

export type StoredResearchEvidence = {
  id: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  createdVia: string;
  collectedAt: Date;
};

export async function insertResearchEvidence(
  input: {
    id: string;
    researchChannelId: string;
    observation: string;
    source: string;
    confidence?: string | null;
    createdVia: string;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(researchEvidence).values({
    id: input.id,
    researchChannelId: input.researchChannelId,
    observation: input.observation,
    source: input.source,
    confidence: input.confidence ?? null,
    createdVia: input.createdVia,
  });
}

export async function listResearchEvidenceByChannel(
  researchChannelId: string,
  database: AppDb = db
): Promise<StoredResearchEvidence[]> {
  return database
    .select()
    .from(researchEvidence)
    .where(
      and(
        eq(researchEvidence.researchChannelId, researchChannelId),
        // Phase 13 (review round 5): see listMarketChannelSnapshotsByChannel.
        or(
          gte(researchEvidence.collectedAt, apiRetentionCutoff()),
          notInArray(researchEvidence.source, API_SNAPSHOT_SOURCES)
        )
      )
    )
    .orderBy(desc(researchEvidence.collectedAt));
}

/**
 * Added by independent review (2026-09-26, Phase 9 slice 1 follow-up): the first version of this
 * module had no way to correct or remove a watchlist entry once added, permanent for the life of
 * the local database. Deletes evidence rows BEFORE the channel row, in one transaction -- the same
 * FK-ordering discipline this codebase already learned the hard way in
 * `sync-gateway/change-drafts/services.ts`'s `discardLocalAndAdoptPeer` (RISK-46): deleting the
 * parent first, under `foreign_keys=ON`, would either fail the constraint or (if constraints were
 * ever relaxed) silently orphan evidence rows. Widened for slice 9A to also cascade-delete both new
 * snapshot tables, for the identical reason -- they carry the same FK onto `researchChannels.id`.
 */
export async function deleteResearchChannel(id: string, database: AppDb = db): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(researchEvidence).where(eq(researchEvidence.researchChannelId, id));
    await tx.delete(marketChannelSnapshots).where(eq(marketChannelSnapshots.researchChannelId, id));
    await tx.delete(marketVideoSnapshots).where(eq(marketVideoSnapshots.researchChannelId, id));
    // Phase 9 slice 9B -- widened for the same FK-ordering reason as the two tables above.
    await tx.delete(marketIntelligenceCollectionRuns).where(eq(marketIntelligenceCollectionRuns.researchChannelId, id));
    // Phase 9 slice 9E -- market_topic_assignments carries no FK for subjectId (see its own doc
    // comment), so this delete would not fail without this line -- cascaded anyway for data
    // hygiene, the same discipline every other channel-scoped table here already follows (found
    // necessary by advisor review: an orphaned assignment row pointing at a deleted channel id is
    // exactly the kind of stale reference this codebase's own cascade-delete convention exists to
    // prevent).
    await tx
      .delete(marketTopicAssignments)
      .where(and(eq(marketTopicAssignments.subjectType, "channel"), eq(marketTopicAssignments.subjectId, id)));
    // Found by independent review (2026-09-29): a discovery candidate's own `id` IS the real
    // channel id (no FK), and `promoteDiscoveryCandidate` leaves its row at `status: "promoted"`
    // after creating the matching `researchChannels` row -- without this, removing that channel
    // from the watchlist left the candidate permanently stuck at "promoted" with no way back
    // (`promoteDiscoveryCandidate` refuses re-promotion, `updateDiscoveryCandidateStatus` refuses
    // to touch an already-"promoted" row). Scoped to `status: "promoted"` only -- a non-promoted
    // candidate that merely happens to share this id from an unrelated, later discovery search is
    // a separate, still-actionable candidate and must not be deleted just because this channel was
    // also (separately) removed from the watchlist.
    await tx
      .delete(marketDiscoveryCandidates)
      .where(and(eq(marketDiscoveryCandidates.id, id), eq(marketDiscoveryCandidates.status, "promoted")));
    await tx.delete(researchChannels).where(eq(researchChannels.id, id));
  });
}

// ---------------------------------------------------------------------------
// Phase 9 slice 9A (`docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md`) -- structured, append-only
// market snapshots. Read/written only by `src/lib/market-intelligence/adapters/store.ts`.
// ---------------------------------------------------------------------------

export type StoredMarketChannelSnapshot = {
  id: string;
  researchChannelId: string;
  observedAt: Date;
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  hiddenSubscriberCount: boolean;
  source: string;
  createdVia: string;
};

export async function insertMarketChannelSnapshot(
  input: {
    id: string;
    researchChannelId: string;
    subscriberCount?: number | null;
    viewCount?: number | null;
    videoCount?: number | null;
    hiddenSubscriberCount?: boolean;
    source: string;
    createdVia: string;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketChannelSnapshots).values({
    id: input.id,
    researchChannelId: input.researchChannelId,
    subscriberCount: input.subscriberCount ?? null,
    viewCount: input.viewCount ?? null,
    videoCount: input.videoCount ?? null,
    hiddenSubscriberCount: input.hiddenSubscriberCount ?? false,
    source: input.source,
    createdVia: input.createdVia,
  });
}

// Oldest first -- deliberately the opposite order from `listResearchEvidenceByChannel`'s
// newest-first convention: this is the natural order `derived-metrics.ts`'s delta/velocity
// functions expect once a future slice wires them up to a real read path (not yet done as of
// slice 9A -- corrected 2026-09-26, independent review round 2, after an earlier version of this
// comment claimed derived-metrics.ts already consumes this list, which no production code does).
/**
 * Phase 13 (review round 5): reads never return another channel's API-sourced rows older than the
 * policy window, even if the purge has not run yet (it runs only while the web server is up, and an
 * MCP/CLI process may read the database for days without it). Operator-entered rows are unaffected.
 */
function apiRetentionCutoff(): Date {
  return new Date(Date.now() - API_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
const API_SNAPSHOT_SOURCES: string[] = [...YOUTUBE_API_SNAPSHOT_SOURCES];

export async function listMarketChannelSnapshotsByChannel(
  researchChannelId: string,
  database: AppDb = db
): Promise<StoredMarketChannelSnapshot[]> {
  return database
    .select()
    .from(marketChannelSnapshots)
    .where(
      and(
        eq(marketChannelSnapshots.researchChannelId, researchChannelId),
        or(gte(marketChannelSnapshots.observedAt, apiRetentionCutoff()), notInArray(marketChannelSnapshots.source, API_SNAPSHOT_SOURCES))
      )
    )
    .orderBy(asc(marketChannelSnapshots.observedAt));
}

export type StoredMarketVideoSnapshot = {
  id: string;
  researchChannelId: string;
  videoId: string;
  observedAt: Date;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishedAt: Date | null;
  title: string | null;
  /** NULL = not captured (see the column's comment). */
  durationSeconds: number | null;
  liveBroadcastContent: string | null;
  source: string;
  createdVia: string;
};

export async function insertMarketVideoSnapshot(
  input: {
    id: string;
    researchChannelId: string;
    videoId: string;
    viewCount?: number | null;
    likeCount?: number | null;
    commentCount?: number | null;
    publishedAt?: Date | null;
    title?: string | null;
    durationSeconds?: number | null;
    liveBroadcastContent?: string | null;
    source: string;
    createdVia: string;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketVideoSnapshots).values({
    id: input.id,
    researchChannelId: input.researchChannelId,
    videoId: input.videoId,
    viewCount: input.viewCount ?? null,
    likeCount: input.likeCount ?? null,
    commentCount: input.commentCount ?? null,
    publishedAt: input.publishedAt ?? null,
    title: input.title ?? null,
    durationSeconds: input.durationSeconds ?? null,
    liveBroadcastContent: input.liveBroadcastContent ?? null,
    source: input.source,
    createdVia: input.createdVia,
  });
}

// Oldest first -- same rationale as listMarketChannelSnapshotsByChannel above.
export async function listMarketVideoSnapshotsByChannel(
  researchChannelId: string,
  database: AppDb = db
): Promise<StoredMarketVideoSnapshot[]> {
  return database
    .select()
    .from(marketVideoSnapshots)
    .where(
      and(
        eq(marketVideoSnapshots.researchChannelId, researchChannelId),
        // Phase 13 (review round 5): see listMarketChannelSnapshotsByChannel.
        or(gte(marketVideoSnapshots.observedAt, apiRetentionCutoff()), notInArray(marketVideoSnapshots.source, API_SNAPSHOT_SOURCES))
      )
    )
    .orderBy(asc(marketVideoSnapshots.observedAt));
}

// ---------------------------------------------------------------------------
// Phase 9 slice 9B (`docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md`) -- repeatable-refresh staleness
// tracking and the append-only collection-run audit/quota log. Read/written only by
// `src/lib/market-intelligence/adapters/store.ts`.
// ---------------------------------------------------------------------------

/**
 * Mirrors `markAnalyticsAutoCollected`'s own shape exactly, scoped to `research_channels`. Called
 * ONLY after a genuine successful refresh of this specific channel -- never as a side effect of
 * the overall collection run, so a channel skipped for budget reasons stays stale for next time.
 */
export async function markResearchChannelAutoCollected(
  researchChannelId: string,
  at: Date,
  database: AppDb = db
): Promise<void> {
  await database
    .update(researchChannels)
    .set({ lastAutoCollectedAt: at })
    .where(eq(researchChannels.id, researchChannelId));
}

/**
 * The atomic mark-then-run concurrency claim (see `researchChannels.collectionClaimedAt`'s own
 * doc comment for why this is a separate column from `lastAutoCollectedAt`, rather than reusing
 * `markResearchChannelAutoCollected` above for both roles). A single `UPDATE ... WHERE ...
 * RETURNING` -- never a separate read followed by a write -- so two callers racing this exact
 * statement can never both see themselves as the winner for the same channel id: SQLite serializes
 * the two statements, and only the first to actually run matches the `WHERE` clause's own
 * "not already claimed" condition, so the second's `RETURNING` set excludes it (verified directly
 * against this project's own libsql driver, not assumed from SQLite's general reputation, before
 * this function was written).
 *
 * `excludeResearchChannelIds` is the caller's own "recently failed" backoff list
 * (`listRecentlyFailedResearchChannelIds` below) -- computed as a separate, plain read rather than
 * folded into this one atomic statement, since it is a soft prioritization heuristic, not a
 * correctness-critical lock (a channel that slips through this exclusion by a race is merely
 * retried a little sooner than ideal, never double-charged).
 */
export async function claimStaleResearchChannelsForCollection(
  args: {
    now: Date;
    staleCutoff: Date;
    claimExpiryCutoff: Date;
    excludeResearchChannelIds: string[];
    /** When set, only these channels may be claimed (an approved collection request); everything else about the claim is unchanged. */
    onlyResearchChannelIds?: string[];
  },
  database: AppDb = db
): Promise<string[]> {
  if (args.onlyResearchChannelIds && args.onlyResearchChannelIds.length === 0) return [];
  const conditions = [
    or(isNull(researchChannels.lastAutoCollectedAt), lt(researchChannels.lastAutoCollectedAt, args.staleCutoff)),
    or(isNull(researchChannels.collectionClaimedAt), lt(researchChannels.collectionClaimedAt, args.claimExpiryCutoff)),
  ];
  if (args.excludeResearchChannelIds.length > 0) {
    conditions.push(notInArray(researchChannels.id, args.excludeResearchChannelIds));
  }
  if (args.onlyResearchChannelIds) {
    conditions.push(inArray(researchChannels.id, args.onlyResearchChannelIds));
  }

  const rows = await database
    .update(researchChannels)
    .set({ collectionClaimedAt: args.now })
    .where(and(...conditions))
    .returning({ id: researchChannels.id });

  return rows.map((row) => row.id);
}

/**
 * Keeps a long run's claims alive: moves `collectionClaimedAt` from `expectedClaimedAt` (the value this run itself last wrote) to
 * `newClaimedAt` for the given channels, ONLY where they still carry that value -- a channel another run reclaimed (or that was released)
 * is left alone and is not returned. One atomic `UPDATE ... WHERE ... RETURNING`.
 */
export async function renewResearchChannelCollectionClaims(
  ids: string[],
  expectedClaimedAt: Date,
  newClaimedAt: Date,
  database: AppDb = db
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await database
    .update(researchChannels)
    .set({ collectionClaimedAt: newClaimedAt })
    .where(and(inArray(researchChannels.id, ids), eq(researchChannels.collectionClaimedAt, expectedClaimedAt)))
    .returning({ id: researchChannels.id });
  return rows.map((row) => row.id);
}

/**
 * Releases one channel's claim once its attempt reaches ANY terminal outcome (success, failure, or
 * a quota-limited skip) -- called unconditionally in the orchestration's own `finally`, so a claim
 * never outlives the single collection pass that took it, regardless of that pass's own duration
 * (`claimExpiryCutoff` above exists only as a crash-safety fallback, not as the normal release
 * path).
 */
export async function releaseResearchChannelCollectionClaim(
  researchChannelId: string,
  database: AppDb = db
): Promise<void> {
  await database
    .update(researchChannels)
    .set({ collectionClaimedAt: null })
    .where(eq(researchChannels.id, researchChannelId));
}

/**
 * The failure-retry backoff (advisor review before implementation: without this, a permanently
 * broken channel -- e.g. deleted or made private -- would be re-attempted, spending at least one
 * real YouTube API unit, on every single dashboard mount, all day, forever). A channel with ANY
 * `status: "failed"` row within `since` is excluded from the next claim -- not specifically its
 * MOST RECENT row (found by independent review: the two are equivalent today, since a failure
 * itself blocks re-claiming that same channel again within this same window, so no later row can
 * exist yet -- but this function's own behavior, not that current-callsite equivalence, is what's
 * documented here, so a future second writer to this table doesn't inherit a stale assumption).
 * Reuses the same window as the staleness check itself (this module owns no separate
 * backoff-duration concept, `AGENTS.md` §M: no new shared constant introduced for one caller).
 */
export async function listRecentlyFailedResearchChannelIds(since: Date, database: AppDb = db): Promise<string[]> {
  const rows = await database
    .select({ researchChannelId: marketIntelligenceCollectionRuns.researchChannelId })
    .from(marketIntelligenceCollectionRuns)
    .where(and(eq(marketIntelligenceCollectionRuns.status, "failed"), gte(marketIntelligenceCollectionRuns.ranAt, since)));
  return [...new Set(rows.map((row) => row.researchChannelId))];
}

/**
 * Appends one audit/quota-ledger row (`marketIntelligenceCollectionRuns`'s own doc comment
 * explains the dual role). Never updated once written -- a genuinely new attempt is always a new
 * row, matching every other append-only table this module owns.
 */
export async function insertMarketIntelligenceCollectionRun(
  input: {
    researchChannelId: string;
    status: "success" | "skipped_quota_limited" | "failed";
    unitsSpent: number;
    videosRequested?: number | null;
    videosReturned?: number | null;
    errorMessage?: string | null;
    /** True when the RSS feed (~15 newest) was used because the playlist call failed. */
    feedFallback?: boolean;
    // Injectable so the orchestration's own staleness/backoff-window tests can control exactly
    // what this row's ranAt reads as -- omitted (real callers outside a test) defaults to the
    // table's own `$defaultFn(() => new Date())`, unchanged from before this parameter existed.
    ranAt?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketIntelligenceCollectionRuns).values({
    researchChannelId: input.researchChannelId,
    status: input.status,
    unitsSpent: input.unitsSpent,
    videosRequested: input.videosRequested ?? null,
    videosReturned: input.videosReturned ?? null,
    errorMessage: input.errorMessage ?? null,
    feedFallback: input.feedFallback ?? false,
    ...(input.ranAt ? { ranAt: input.ranAt } : {}),
  });
}

export type StoredMarketIntelligenceCollectionRun = {
  id: number;
  researchChannelId: string;
  ranAt: Date;
  status: "success" | "skipped_quota_limited" | "failed";
  unitsSpent: number;
  videosRequested: number | null;
  videosReturned: number | null;
  errorMessage: string | null;
  feedFallback: boolean;
};

/**
 * Phase 9 slice 9G, part A -- the one row-per-channel lookup this table never had before (only the
 * aggregate `getMarketIntelligenceUnitsSpentSince` sum existed). Used to derive this channel's own
 * `dataQualityFlags` (`missing_snapshot`/`quota_limited`) in `getWatchlistEntryContext`. `null` when
 * this channel has never been collected at all -- a plain, unremarkable fact, not itself a flag.
 */
/** Phase 13 (review round 9): whether this channel was ever collected successfully -- since API
 * snapshots expire after 30 days, "no snapshot visible" no longer implies "never observed". */
export async function hasSuccessfulMarketIntelligenceCollectionRun(researchChannelId: string, database: AppDb = db): Promise<boolean> {
  const [row] = await database
    .select({ id: marketIntelligenceCollectionRuns.id })
    .from(marketIntelligenceCollectionRuns)
    .where(and(eq(marketIntelligenceCollectionRuns.researchChannelId, researchChannelId), eq(marketIntelligenceCollectionRuns.status, "success")))
    .limit(1);
  return row !== undefined;
}

export async function getLatestMarketIntelligenceCollectionRunForChannel(
  researchChannelId: string,
  database: AppDb = db
): Promise<StoredMarketIntelligenceCollectionRun | null> {
  const [row] = await database
    .select()
    .from(marketIntelligenceCollectionRuns)
    .where(eq(marketIntelligenceCollectionRuns.researchChannelId, researchChannelId))
    .orderBy(desc(marketIntelligenceCollectionRuns.ranAt))
    .limit(1);
  return row ?? null;
}

/**
 * The quota ledger's read side for the general pool: real YouTube API units spent by collection
 * (`market_intelligence_collection_runs`) since `since` -- the caller passes the start of the YouTube
 * quota day (midnight Pacific, `startOfYoutubeQuotaDay`, Phase 13 slice 13.4). Sums every row
 * regardless of `status`: a `skipped_quota_limited`/`failed` row still spent real units. Discovery
 * (`search.list`) has its own bucket since 13.4 and is counted by `countMarketDiscoverySearchesSince`.
 */
export async function getMarketIntelligenceUnitsSpentSince(since: Date, database: AppDb = db): Promise<number> {
  // Phase 13 slice 13.4: since 2026-06-01 `search.list` has its own quota bucket, so discovery runs
  // no longer count against the shared 10k-unit pool this budget guards -- collection runs only.
  // Searches are counted by `countMarketDiscoverySearchesSince` against their own daily limit.
  const [collectionRow] = await database
    .select({ total: sql<number | null>`SUM(${marketIntelligenceCollectionRuns.unitsSpent})` })
    .from(marketIntelligenceCollectionRuns)
    .where(gte(marketIntelligenceCollectionRuns.ranAt, since));
  // BL-145: a search's own pool units (channel counts, video views) are part of this budget too.
  const [discoveryRow] = await database
    .select({ total: sql<number | null>`SUM(${marketDiscoveryRuns.poolUnitsSpent})` })
    .from(marketDiscoveryRuns)
    .where(gte(marketDiscoveryRuns.ranAt, since));
  return (collectionRow?.total ?? 0) + (discoveryRow?.total ?? 0);
}

/** Phase 13 slice 13.4: `search.list` calls made since `since` -- each `market_discovery_runs` row is
 * exactly one call (a row is only written once the call was attempted). */
export async function countMarketDiscoverySearchesSince(since: Date, database: AppDb = db): Promise<number> {
  const [row] = await database
    .select({ total: sql<number>`COUNT(*)` })
    .from(marketDiscoveryRuns)
    .where(gte(marketDiscoveryRuns.ranAt, since));
  return Number(row?.total ?? 0);
}

const MARKET_INTELLIGENCE_DAILY_QUOTA_BUDGET_SETTING_KEY = "market_intelligence_daily_quota_budget_units";

/**
 * `null` (never set, or explicitly cleared) means auto-collection is OFF -- "the operator sets the
 * number, no hardcoded default" (owner decision, `PHASE_9_PLAN.md` §12 item 2). Stored as a plain
 * string in `app_settings` like every other setting; parsed defensively (a corrupted/non-numeric
 * stored value is treated as unset rather than throwing on every dashboard load).
 */
export async function getMarketIntelligenceDailyQuotaBudgetUnits(database: AppDb = db): Promise<number | null> {
  const raw = await getAppSetting(MARKET_INTELLIGENCE_DAILY_QUOTA_BUDGET_SETTING_KEY, database);
  // `""` (an explicitly-cleared setting, see the setter below) must be treated the same as a
  // never-set row (`null`) -- `Number("")` is `0`, not `NaN`, so this check cannot be folded into
  // the `Number.isFinite`/`> 0` guard below without relying on that coincidence.
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

/** `null` clears the setting (equivalent to "off"); validation of the range is the caller's job
 * (the API route boundary), same convention `setAnalyticsSyncSettings` already uses. */
export async function setMarketIntelligenceDailyQuotaBudgetUnits(units: number | null, database: AppDb = db): Promise<void> {
  await setAppSetting(MARKET_INTELLIGENCE_DAILY_QUOTA_BUDGET_SETTING_KEY, units === null ? "" : String(units), database);
}

const MARKET_INTELLIGENCE_DEFAULT_MAX_VIDEOS_SETTING_KEY = "market_intelligence_default_max_videos_per_channel";
const MARKET_INTELLIGENCE_DEFAULT_PUBLISHED_AFTER_SETTING_KEY = "market_intelligence_default_published_after";

/**
 * The global default collection depth (operator request 2026-10-04). `null` = not set: 50 videos / no date. A corrupted stored
 * value reads as unset (same defensive parse as the daily budget above). Range validation is the caller's job.
 */
export async function getMarketIntelligenceCollectionDepthDefaults(
  database: AppDb = db
): Promise<{ maxVideosPerChannel: number | null; publishedAfter: string | null }> {
  const rawMax = await getAppSetting(MARKET_INTELLIGENCE_DEFAULT_MAX_VIDEOS_SETTING_KEY, database);
  const rawDate = await getAppSetting(MARKET_INTELLIGENCE_DEFAULT_PUBLISHED_AFTER_SETTING_KEY, database);
  const parsed = rawMax === null || rawMax === "" ? NaN : Number(rawMax);
  return {
    maxVideosPerChannel: Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null,
    publishedAfter: rawDate === null || rawDate === "" ? null : rawDate,
  };
}

export async function setMarketIntelligenceCollectionDepthDefaults(
  input: { maxVideosPerChannel: number | null; publishedAfter: string | null },
  database: AppDb = db
): Promise<void> {
  await setAppSetting(
    MARKET_INTELLIGENCE_DEFAULT_MAX_VIDEOS_SETTING_KEY,
    input.maxVideosPerChannel === null ? "" : String(input.maxVideosPerChannel),
    database
  );
  await setAppSetting(MARKET_INTELLIGENCE_DEFAULT_PUBLISHED_AFTER_SETTING_KEY, input.publishedAfter ?? "", database);
}

/** The per-channel override of the depth settings (`null` = use the global default). Range validation is the caller's job. */
export async function setResearchChannelCollectionDepth(
  researchChannelId: string,
  input: { maxVideosPerChannel: number | null; publishedAfter: string | null },
  database: AppDb = db
): Promise<void> {
  await database
    .update(researchChannels)
    .set({ maxVideosPerChannel: input.maxVideosPerChannel, publishedAfter: input.publishedAfter })
    .where(eq(researchChannels.id, researchChannelId));
}

/**
 * Persists how far a channel's deep collection has got (cursor + completion state). Written after every fully processed page
 * of a backfill and once at the end; never touched by an incremental run or the RSS fallback.
 */
export async function saveResearchChannelCollectionProgress(
  researchChannelId: string,
  input: {
    complete: boolean;
    completeReason: "exhausted" | "cap" | "date" | null;
    nextPageToken: string | null;
    capAtRun: number;
    publishedAfterAtRun: string | null;
  },
  database: AppDb = db
): Promise<void> {
  await database
    .update(researchChannels)
    .set({
      videosComplete: input.complete ? 1 : 0,
      videosCompleteReason: input.completeReason,
      videosNextPageToken: input.nextPageToken,
      videosCapAtRun: input.capAtRun,
      videosPublishedAfterAtRun: input.publishedAfterAtRun,
    })
    .where(eq(researchChannels.id, researchChannelId));
}

// ---------------------------------------------------------------------------
// Phase 9 slice 9C (`docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md`) -- search.list-based discovery
// and the candidate lifecycle. Read/written only by `src/lib/market-intelligence/adapters/store.ts`.
// ---------------------------------------------------------------------------

export type DiscoveryCandidateStatus = "new" | "watching" | "ignored" | "archived" | "promoted";

export type StoredMarketDiscoveryCandidate = {
  id: string;
  title: string;
  status: DiscoveryCandidateStatus;
  discoverySource: string;
  discoveryQuery: string;
  reasonDiscovered: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdVia: string;
  subscriberCount?: number | null;
  hiddenSubscriberCount?: boolean | null;
  videoCount?: number | null;
  viewCount?: number | null;
  channelPublishedAt?: string | null;
  statsObservedAt?: Date | null;
  matchQuery?: string | null;
  matchVideoCount?: number | null;
  matchViewCount?: number | null;
};

/** BL-145: what the latest genre search found of this channel (overwrites the previous one). */
export async function setMarketDiscoveryCandidateMatch(
  channelId: string,
  match: { query: string; videoCount: number; viewCount: number | null },
  database: AppDb = db
): Promise<void> {
  await database
    .update(marketDiscoveryCandidates)
    .set({ matchQuery: match.query, matchVideoCount: match.videoCount, matchViewCount: match.viewCount })
    .where(eq(marketDiscoveryCandidates.id, channelId));
}

export type MarketDiscoveryCandidateStats = {
  subscriberCount: number | null;
  hiddenSubscriberCount: boolean;
  videoCount: number | null;
  viewCount: number | null;
  channelPublishedAt: string | null;
  observedAt: Date;
};

/** BL-145: records a candidate's public counts as just observed (overwrites the previous observation). */
export async function setMarketDiscoveryCandidateStats(channelId: string, stats: MarketDiscoveryCandidateStats, database: AppDb = db): Promise<void> {
  await database
    .update(marketDiscoveryCandidates)
    .set({
      subscriberCount: stats.subscriberCount,
      hiddenSubscriberCount: stats.hiddenSubscriberCount,
      videoCount: stats.videoCount,
      viewCount: stats.viewCount,
      channelPublishedAt: stats.channelPublishedAt,
      statsObservedAt: stats.observedAt,
    })
    .where(eq(marketDiscoveryCandidates.id, channelId));
}

export async function getMarketDiscoveryCandidateById(
  channelId: string,
  database: AppDb = db
): Promise<StoredMarketDiscoveryCandidate | null> {
  const [row] = await database.select().from(marketDiscoveryCandidates).where(eq(marketDiscoveryCandidates.id, channelId));
  return row ?? null;
}

// Newest lastSeenAt first -- a rediscovered (still-relevant) candidate surfaces above one nobody
// has seen again in a long time, unlike the append-only snapshot tables' oldest-first convention
// (which exists there to replay a time series in order; this is a lifecycle list, not a series).
export async function listMarketDiscoveryCandidates(database: AppDb = db): Promise<StoredMarketDiscoveryCandidate[]> {
  return database.select().from(marketDiscoveryCandidates).orderBy(desc(marketDiscoveryCandidates.lastSeenAt));
}

export async function insertMarketDiscoveryCandidate(
  input: {
    id: string;
    title: string;
    discoverySource: string;
    discoveryQuery: string;
    reasonDiscovered?: string | null;
    createdVia: string;
    /** When given (a search's own clock time), stamps first/last seen with it instead of the insert's wall clock,
     * so every candidate one search finds shares one `lastSeenAt` (BL-156) -- otherwise a second boundary crossed
     * mid-search listed a later-inserted, less-matching channel first. */
    seenAt?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketDiscoveryCandidates).values({
    id: input.id,
    title: input.title,
    status: "new",
    discoverySource: input.discoverySource,
    discoveryQuery: input.discoveryQuery,
    reasonDiscovered: input.reasonDiscovered ?? null,
    createdVia: input.createdVia,
    ...(input.seenAt ? { firstSeenAt: input.seenAt, lastSeenAt: input.seenAt } : {}),
  });
}

/** Rediscovery never duplicates the row or touches `status` -- `lastSeenAt` moves, and (Phase 13) the
 * API-sourced `title`/`reasonDiscovered` are refreshed with it, restarting their 30-day clock. */
export async function touchMarketDiscoveryCandidateLastSeen(
  channelId: string,
  at: Date,
  /** Phase 13 (review round 1): the fresh title from the same search -- the 30-day clock may only be
   * restarted by a real refresh of the API-sourced data, never by a timestamp bump alone. */
  title: string,
  /** The fresh channel description from the same search (stored as `reason_discovered`). */
  reasonDiscovered: string | null,
  database: AppDb = db
): Promise<void> {
  // BL-145 review: the observed counts and the genre match belong to the observation the 30-day clock dates. A refresh
  // restarts that clock, so the older counts/match are dropped here; the same search re-observes them right after
  // (or leaves them empty when that lookup fails) -- never older API data served under a newer date.
  await database
    .update(marketDiscoveryCandidates)
    .set({
      lastSeenAt: at,
      title,
      reasonDiscovered,
      subscriberCount: null,
      hiddenSubscriberCount: null,
      videoCount: null,
      viewCount: null,
      channelPublishedAt: null,
      statsObservedAt: null,
      matchQuery: null,
      matchVideoCount: null,
      matchViewCount: null,
    })
    .where(eq(marketDiscoveryCandidates.id, channelId));
}

export async function setMarketDiscoveryCandidateStatus(
  channelId: string,
  status: DiscoveryCandidateStatus,
  database: AppDb = db
): Promise<void> {
  await database.update(marketDiscoveryCandidates).set({ status }).where(eq(marketDiscoveryCandidates.id, channelId));
}

/**
 * Appends one audit/quota-ledger row -- this slice's own `insertMarketIntelligenceCollectionRun`
 * counterpart. Never updated once written.
 */
export async function insertMarketDiscoveryRun(
  input: {
    query: string;
    status: "success" | "failed";
    unitsSpent: number;
    candidatesFound?: number | null;
    candidatesNew?: number | null;
    errorMessage?: string | null;
    ranAt?: Date;
    poolUnitsSpent?: number | null;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketDiscoveryRuns).values({
    query: input.query,
    status: input.status,
    unitsSpent: input.unitsSpent,
    poolUnitsSpent: input.poolUnitsSpent ?? null,
    candidatesFound: input.candidatesFound ?? null,
    candidatesNew: input.candidatesNew ?? null,
    errorMessage: input.errorMessage ?? null,
    ...(input.ranAt ? { ranAt: input.ranAt } : {}),
  });
}

// ---------------------------------------------------------------------------
// Phase 9 slice 9E (`docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md`) -- topic model and manual/
// structural trend candidates. Read/written only by `src/lib/market-intelligence/adapters/store.ts`.
// ---------------------------------------------------------------------------

export type TopicAssignmentSubjectType = "channel" | "video";
export type TopicAssignmentSource = "manual" | "ai_assisted";
export type TrendCandidateStatus = "emerging" | "growing" | "established" | "declining" | "stale";
export type TrendEvidenceType = "supporting_channel" | "supporting_video" | "signal";

export type StoredMarketTopic = {
  id: string;
  name: string;
  createdVia: string;
  createdAt: Date;
};

export async function listMarketTopics(database: AppDb = db): Promise<StoredMarketTopic[]> {
  return database.select().from(marketTopics).orderBy(asc(marketTopics.name));
}

export async function getMarketTopicById(topicId: string, database: AppDb = db): Promise<StoredMarketTopic | null> {
  const [row] = await database.select().from(marketTopics).where(eq(marketTopics.id, topicId));
  return row ?? null;
}

export async function insertMarketTopic(
  input: { id: string; name: string; createdVia: string },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketTopics).values({ id: input.id, name: input.name, createdVia: input.createdVia });
}

/**
 * Cascades its own assignments first, same FK-ordering discipline as `deleteResearchChannel`.
 * `market_trend_candidates.topic_id` is a NULLABLE FK -- a trend candidate tagged with this topic
 * is detached (its own `topic_id` set `NULL`), never deleted, since removing a topic label is not a
 * reason to lose an otherwise-independent trend candidate's own evidence history.
 */
export async function deleteMarketTopic(topicId: string, database: AppDb = db): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(marketTopicAssignments).where(eq(marketTopicAssignments.topicId, topicId));
    await tx.update(marketTrendCandidates).set({ topicId: null }).where(eq(marketTrendCandidates.topicId, topicId));
    await tx.delete(marketTopics).where(eq(marketTopics.id, topicId));
  });
}

export type StoredMarketTopicAssignment = {
  id: string;
  topicId: string;
  subjectType: TopicAssignmentSubjectType;
  subjectId: string;
  source: TopicAssignmentSource;
  createdVia: string;
  assignedAt: Date;
};

export async function listAssignmentsForTopic(topicId: string, database: AppDb = db): Promise<StoredMarketTopicAssignment[]> {
  return database
    .select()
    .from(marketTopicAssignments)
    .where(eq(marketTopicAssignments.topicId, topicId))
    .orderBy(desc(marketTopicAssignments.assignedAt));
}

export async function listTopicsForSubject(
  subjectType: TopicAssignmentSubjectType,
  subjectId: string,
  database: AppDb = db
): Promise<StoredMarketTopicAssignment[]> {
  return database
    .select()
    .from(marketTopicAssignments)
    .where(and(eq(marketTopicAssignments.subjectType, subjectType), eq(marketTopicAssignments.subjectId, subjectId)));
}

/**
 * Phase 9 slice 9H part C -- every assignment for one `subjectType` regardless of `subjectId`,
 * covered by the existing `market_topic_assignments_subject_idx(subject_type, subject_id)`
 * composite index. `listTopicsForSubject` above takes one `subjectId` at a time; a caller needing
 * every video-subject assignment across a whole watchlist (this slice's own `getMarketVideosOverview`)
 * would otherwise have to call it once per video (a real N+1) -- this is the single bulk read
 * instead.
 */
export async function listMarketTopicAssignmentsBySubjectType(
  subjectType: TopicAssignmentSubjectType,
  database: AppDb = db
): Promise<StoredMarketTopicAssignment[]> {
  return database.select().from(marketTopicAssignments).where(eq(marketTopicAssignments.subjectType, subjectType));
}

export async function getTopicAssignment(
  topicId: string,
  subjectType: TopicAssignmentSubjectType,
  subjectId: string,
  database: AppDb = db
): Promise<StoredMarketTopicAssignment | null> {
  const [row] = await database
    .select()
    .from(marketTopicAssignments)
    .where(
      and(
        eq(marketTopicAssignments.topicId, topicId),
        eq(marketTopicAssignments.subjectType, subjectType),
        eq(marketTopicAssignments.subjectId, subjectId)
      )
    );
  return row ?? null;
}

export async function insertMarketTopicAssignment(
  input: {
    id: string;
    topicId: string;
    subjectType: TopicAssignmentSubjectType;
    subjectId: string;
    source: TopicAssignmentSource;
    createdVia: string;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketTopicAssignments).values({
    id: input.id,
    topicId: input.topicId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    source: input.source,
    createdVia: input.createdVia,
  });
}

export async function deleteMarketTopicAssignment(assignmentId: string, database: AppDb = db): Promise<void> {
  await database.delete(marketTopicAssignments).where(eq(marketTopicAssignments.id, assignmentId));
}

export type StoredMarketTrendCandidate = {
  id: string;
  title: string;
  description: string | null;
  topicId: string | null;
  status: TrendCandidateStatus;
  firstObservedAt: Date;
  lastObservedAt: Date;
  createdVia: string;
};

export async function listMarketTrendCandidates(database: AppDb = db): Promise<StoredMarketTrendCandidate[]> {
  return database.select().from(marketTrendCandidates).orderBy(desc(marketTrendCandidates.lastObservedAt));
}

export async function getMarketTrendCandidateById(
  trendCandidateId: string,
  database: AppDb = db
): Promise<StoredMarketTrendCandidate | null> {
  const [row] = await database.select().from(marketTrendCandidates).where(eq(marketTrendCandidates.id, trendCandidateId));
  return row ?? null;
}

/**
 * Atomic wrapper -- inserts a trend candidate AND its required initial evidence row in a single
 * `database.transaction()`, mirroring `deleteResearchChannel`'s own established cascade-transaction
 * pattern (found by independent review: an earlier version called `insertMarketTrendCandidate`/
 * `insertMarketTrendEvidence` as two separate top-level writes, which let a throw between them
 * leave a trend candidate with zero evidence rows -- the exact invariant spec §14 and this
 * table's own schema-level `initialEvidence` requirement exist to prevent). Closes
 * `docs/TECHNICAL_DEBT.md` RISK-70.
 */
export async function insertMarketTrendCandidateWithInitialEvidence(
  candidate: {
    id: string;
    title: string;
    description?: string | null;
    topicId?: string | null;
    createdVia: string;
    at?: Date;
  },
  initialEvidence: {
    id: string;
    evidenceType: TrendEvidenceType;
    referenceId?: string | null;
    description: string;
    createdVia: string;
  },
  database: AppDb = db
): Promise<void> {
  // Builds queries directly against `tx` (matching `deleteResearchChannel`'s own established
  // convention) rather than delegating to `insertMarketTrendCandidate`/`insertMarketTrendEvidence`
  // -- drizzle's transaction callback type lacks `AppDb`'s top-level `.batch()` method, so it is not
  // assignable to those functions' `database: AppDb` parameter.
  await database.transaction(async (tx) => {
    await tx.insert(marketTrendCandidates).values({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description ?? null,
      topicId: candidate.topicId ?? null,
      status: "emerging",
      createdVia: candidate.createdVia,
      ...(candidate.at ? { firstObservedAt: candidate.at, lastObservedAt: candidate.at } : {}),
    });
    await tx.insert(marketTrendEvidence).values({
      id: initialEvidence.id,
      trendCandidateId: candidate.id,
      evidenceType: initialEvidence.evidenceType,
      referenceId: initialEvidence.referenceId ?? null,
      description: initialEvidence.description,
      createdVia: initialEvidence.createdVia,
      // Same clock-source fix as firstObservedAt/lastObservedAt above (found by independent
      // review): without this, the evidence row's own recordedAt fell back to real wall-clock
      // time even under an injected/frozen clock, so it could sort as "recorded before" the
      // candidate it documents ever existed.
      ...(candidate.at ? { recordedAt: candidate.at } : {}),
    });
  });
}

export async function insertMarketTrendCandidate(
  input: {
    id: string;
    title: string;
    description?: string | null;
    topicId?: string | null;
    createdVia: string;
    /** Explicit creation instant for both `firstObservedAt`/`lastObservedAt` -- accepted so the
     * service layer's injected clock is the single source of truth for this row's timestamps,
     * never this column's own `$defaultFn` real-wall-clock default (found by independent code
     * review: the service layer's very next call, `touchMarketTrendCandidateLastObservedAt`,
     * already used `deps.clock.now()`, so omitting this parameter let `firstObservedAt` and
     * `lastObservedAt` end up stamped from two different clock sources for the same creation
     * moment). Falls back to the column default only when a caller genuinely has no clock to
     * inject.
     */
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketTrendCandidates).values({
    id: input.id,
    title: input.title,
    description: input.description ?? null,
    topicId: input.topicId ?? null,
    status: "emerging",
    createdVia: input.createdVia,
    ...(input.at ? { firstObservedAt: input.at, lastObservedAt: input.at } : {}),
  });
}

export async function touchMarketTrendCandidateLastObservedAt(
  trendCandidateId: string,
  at: Date,
  database: AppDb = db
): Promise<void> {
  await database.update(marketTrendCandidates).set({ lastObservedAt: at }).where(eq(marketTrendCandidates.id, trendCandidateId));
}

/**
 * Atomic wrapper -- changes status AND records its own `signal` evidence row in a single
 * `database.transaction()` (found by independent review: two separate top-level writes let either
 * ordering fail honestly in only one direction -- evidence-then-status left a false "status
 * changed" narrative if the status write then failed; status-then-evidence left a real status
 * change with no evidence trail if the evidence write then failed, contradicting this table's own
 * "a status can never move without a corresponding evidence trail" invariant documented throughout
 * this module). A transaction makes both problems moot -- either both writes land or neither does.
 */
export async function updateMarketTrendCandidateStatusWithEvidence(
  trendCandidateId: string,
  status: TrendCandidateStatus,
  at: Date,
  evidence: { id: string; description: string; createdVia: string },
  database: AppDb = db
): Promise<void> {
  // Builds queries directly against `tx` -- see `insertMarketTrendCandidateWithInitialEvidence`'s own
  // doc comment for why this doesn't delegate to the single-write functions above.
  await database.transaction(async (tx) => {
    await tx.update(marketTrendCandidates).set({ status, lastObservedAt: at }).where(eq(marketTrendCandidates.id, trendCandidateId));
    await tx.insert(marketTrendEvidence).values({
      id: evidence.id,
      trendCandidateId,
      evidenceType: "signal",
      referenceId: null,
      description: evidence.description,
      createdVia: evidence.createdVia,
      // Same clock-source fix as insertMarketTrendCandidateWithInitialEvidence above (found by
      // independent review): this evidence row documents the status change happening at `at`, so
      // it must be stamped from the same clock, not real wall-clock time.
      recordedAt: at,
    });
  });
}

export type StoredMarketTrendEvidence = {
  id: string;
  trendCandidateId: string;
  evidenceType: TrendEvidenceType;
  referenceId: string | null;
  description: string;
  createdVia: string;
  recordedAt: Date;
};

export async function listTrendEvidence(trendCandidateId: string, database: AppDb = db): Promise<StoredMarketTrendEvidence[]> {
  return database
    .select()
    .from(marketTrendEvidence)
    .where(eq(marketTrendEvidence.trendCandidateId, trendCandidateId))
    .orderBy(asc(marketTrendEvidence.recordedAt));
}

export async function insertMarketTrendEvidence(
  input: {
    id: string;
    trendCandidateId: string;
    evidenceType: TrendEvidenceType;
    referenceId?: string | null;
    description: string;
    createdVia: string;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketTrendEvidence).values({
    id: input.id,
    trendCandidateId: input.trendCandidateId,
    evidenceType: input.evidenceType,
    referenceId: input.referenceId ?? null,
    description: input.description,
    createdVia: input.createdVia,
  });
}

// ---------------------------------------------------------------------------
// Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md) --
// agent-created research requests. Read/written only by `src/lib/market-intelligence/
// adapters/store.ts`.
// ---------------------------------------------------------------------------

export type MarketResearchRequestStatus = "pending" | "approved" | "rejected" | "executed" | "execution_failed";

export type StoredMarketResearchRequest = {
  id: string;
  query: string;
  rationale: string;
  monitorDurationDays: number | null;
  status: MarketResearchRequestStatus;
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  candidatesFound: number | null;
  candidatesNew: number | null;
  executionError: string | null;
};

export async function insertMarketResearchRequest(
  input: {
    id: string;
    query: string;
    rationale: string;
    monitorDurationDays?: number | null;
    createdVia: string;
    agentApiVersion?: string | null;
    /** Explicit creation instant for `createdAt` -- accepted for the same reason
     * `insertMarketTrendCandidate` accepts one (found by independent code review): a later
     * approve/reject transition stamps `resolvedAt` from the service layer's injected
     * `deps.clock.now()`, so leaving this row's own `createdAt` to the column's real-wall-clock
     * `$defaultFn` default risks a `resolvedAt` earlier than `createdAt` under a mocked/frozen
     * clock. Falls back to the column default only when a caller genuinely has no clock to inject.
     */
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketResearchRequests).values({
    id: input.id,
    query: input.query,
    rationale: input.rationale,
    monitorDurationDays: input.monitorDurationDays ?? null,
    status: "pending",
    createdVia: input.createdVia,
    agentApiVersion: input.agentApiVersion ?? null,
    ...(input.at ? { createdAt: input.at } : {}),
  });
}

export async function getMarketResearchRequestById(
  id: string,
  database: AppDb = db
): Promise<StoredMarketResearchRequest | null> {
  const [row] = await database.select().from(marketResearchRequests).where(eq(marketResearchRequests.id, id));
  return row ?? null;
}

export async function listMarketResearchRequests(database: AppDb = db): Promise<StoredMarketResearchRequest[]> {
  return database.select().from(marketResearchRequests).orderBy(desc(marketResearchRequests.createdAt));
}

/**
 * The one atomic conditional transition this slice's own approval integrity depends on --
 * `WHERE status='pending'` means a double-click or two-tab race can never both succeed (mirrors
 * `claimStaleResearchChannelsForCollection`'s own established shape). `null` covers both "already
 * resolved by a concurrent call" and "already resolved earlier" -- the caller distinguishes a
 * genuinely unknown id via its own upfront existence read, not from this function's return value.
 */
export async function approveMarketResearchRequestIfPending(
  id: string,
  at: Date,
  database: AppDb = db
): Promise<StoredMarketResearchRequest | null> {
  const rows = await database
    .update(marketResearchRequests)
    .set({ status: "approved", resolvedAt: at })
    .where(and(eq(marketResearchRequests.id, id), eq(marketResearchRequests.status, "pending")))
    .returning();
  return rows[0] ?? null;
}

/** Same atomic shape as the function above, transitioning `pending -> rejected` instead. */
export async function rejectMarketResearchRequestIfPending(
  id: string,
  reason: string,
  at: Date,
  database: AppDb = db
): Promise<StoredMarketResearchRequest | null> {
  const rows = await database
    .update(marketResearchRequests)
    .set({ status: "rejected", resolvedAt: at, resolvedReason: reason })
    .where(and(eq(marketResearchRequests.id, id), eq(marketResearchRequests.status, "pending")))
    .returning();
  return rows[0] ?? null;
}

/**
 * Records the real outcome of the one `discoverChannels` run an approval triggers -- called only
 * after `approveMarketResearchRequestIfPending` already succeeded.
 *
 * Guarded by `WHERE status='approved'` -- found by independent review: an earlier version matched
 * on `id` alone, which meant this function itself could move a request straight from `pending` to
 * `executed`/`execution_failed`, completely bypassing the approval gate this slice exists to
 * enforce. That gap was only closed by convention (only `approveMarketResearchRequest` happens to
 * call this today) -- exactly the "true because nobody happened to call it" state
 * `PHASE9-INV-03` was built to eliminate for the approve/reject actions themselves; this function
 * needed the identical structural guard, not just those two. Returns the updated row, or `null` if
 * the row was not `"approved"` (already recorded, or never actually approved) -- the caller must
 * treat `null` as an error, never as "nothing to do."
 */
export async function recordMarketResearchRequestExecutionOutcome(
  id: string,
  outcome:
    | { status: "executed"; candidatesFound: number; candidatesNew: number }
    | { status: "execution_failed"; executionError: string },
  database: AppDb = db
): Promise<StoredMarketResearchRequest | null> {
  if (outcome.status === "executed") {
    const rows = await database
      .update(marketResearchRequests)
      .set({ status: "executed", candidatesFound: outcome.candidatesFound, candidatesNew: outcome.candidatesNew })
      .where(and(eq(marketResearchRequests.id, id), eq(marketResearchRequests.status, "approved")))
      .returning();
    return rows[0] ?? null;
  }
  const rows = await database
    .update(marketResearchRequests)
    .set({ status: "execution_failed", executionError: outcome.executionError })
    .where(and(eq(marketResearchRequests.id, id), eq(marketResearchRequests.status, "approved")))
    .returning();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md). Read/written only by
// `src/lib/market-intelligence/adapters/store.ts`. Every transition is one atomic `UPDATE ... WHERE status = <expected> RETURNING`
// (never a read followed by a write), so two racing callers can never both win the same transition.
// ---------------------------------------------------------------------------

export type MarketCollectionRequestStatus = "pending" | "approved" | "running" | "done" | "rejected" | "failed";

export type StoredMarketCollectionRequest = {
  id: string;
  channelIdsJson: string;
  reason: string;
  status: MarketCollectionRequestStatus;
  estimateJson: string;
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  resultJson: string | null;
  unitsSpentTotal: number | null;
  error: string | null;
};

export async function insertMarketCollectionRequest(
  input: {
    id: string;
    channelIdsJson: string;
    reason: string;
    estimateJson: string;
    createdVia: string;
    agentApiVersion?: string | null;
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(marketCollectionRequests).values({
    id: input.id,
    channelIdsJson: input.channelIdsJson,
    reason: input.reason,
    status: "pending",
    estimateJson: input.estimateJson,
    createdVia: input.createdVia,
    agentApiVersion: input.agentApiVersion ?? null,
    ...(input.at ? { createdAt: input.at } : {}),
  });
}

export async function getMarketCollectionRequestById(
  id: string,
  database: AppDb = db
): Promise<StoredMarketCollectionRequest | null> {
  const [row] = await database.select().from(marketCollectionRequests).where(eq(marketCollectionRequests.id, id));
  return row ?? null;
}

export async function listMarketCollectionRequests(database: AppDb = db): Promise<StoredMarketCollectionRequest[]> {
  return database.select().from(marketCollectionRequests).orderBy(desc(marketCollectionRequests.createdAt));
}

/** The open (pending/approved/running) request whose fixed channel list contains `channelId`, or null. Exact membership, checked on the parsed list. */
export async function findOpenMarketCollectionRequestForChannel(
  channelId: string,
  database: AppDb = db
): Promise<StoredMarketCollectionRequest | null> {
  const rows = await database
    .select()
    .from(marketCollectionRequests)
    .where(inArray(marketCollectionRequests.status, ["pending", "approved", "running"]))
    .orderBy(asc(marketCollectionRequests.createdAt));
  for (const row of rows) {
    try {
      const ids: unknown = JSON.parse(row.channelIdsJson);
      if (Array.isArray(ids) && ids.includes(channelId)) return row;
    } catch {
      // A row with unreadable JSON cannot claim a channel.
    }
  }
  return null;
}

/** pending -> approved, stamping who approved it and when. `null` = it was no longer pending. */
export async function approveMarketCollectionRequestIfPending(
  id: string,
  approvedByUserId: string | null,
  at: Date,
  database: AppDb = db
): Promise<StoredMarketCollectionRequest | null> {
  const rows = await database
    .update(marketCollectionRequests)
    .set({ status: "approved", approvedAt: at, approvedByUserId })
    .where(and(eq(marketCollectionRequests.id, id), eq(marketCollectionRequests.status, "pending")))
    .returning();
  return rows[0] ?? null;
}

/** approved -> running. `null` = it was not (or no longer) approved. */
export async function startMarketCollectionRequestIfApproved(
  id: string,
  database: AppDb = db
): Promise<StoredMarketCollectionRequest | null> {
  const rows = await database
    .update(marketCollectionRequests)
    .set({ status: "running" })
    .where(and(eq(marketCollectionRequests.id, id), eq(marketCollectionRequests.status, "approved")))
    .returning();
  return rows[0] ?? null;
}

/** pending -> rejected with the human's reason. `null` = it was no longer pending. */
export async function rejectMarketCollectionRequestIfPending(
  id: string,
  reason: string,
  at: Date,
  database: AppDb = db
): Promise<StoredMarketCollectionRequest | null> {
  const rows = await database
    .update(marketCollectionRequests)
    .set({ status: "rejected", resolvedAt: at, resolvedReason: reason })
    .where(and(eq(marketCollectionRequests.id, id), eq(marketCollectionRequests.status, "pending")))
    .returning();
  return rows[0] ?? null;
}

/** running -> done|failed with the recorded result. `null` = it was not running (e.g. already swept as interrupted). */
export async function finishMarketCollectionRequestIfRunning(
  id: string,
  outcome:
    | { status: "done"; resultJson: string; unitsSpentTotal: number }
    | { status: "failed"; resultJson: string | null; unitsSpentTotal: number; error: string },
  at: Date,
  database: AppDb = db
): Promise<StoredMarketCollectionRequest | null> {
  const rows = await database
    .update(marketCollectionRequests)
    .set(
      outcome.status === "done"
        ? { status: "done", resolvedAt: at, resultJson: outcome.resultJson, unitsSpentTotal: outcome.unitsSpentTotal }
        : { status: "failed", resolvedAt: at, resultJson: outcome.resultJson, unitsSpentTotal: outcome.unitsSpentTotal, error: outcome.error }
    )
    .where(and(eq(marketCollectionRequests.id, id), eq(marketCollectionRequests.status, "running")))
    .returning();
  return rows[0] ?? null;
}

/**
 * Boot-time recovery: an approved/running request whose approval is older than `approvedBefore` was orphaned by a process that died
 * mid-run -- it becomes `failed` ("interrupted") so its channels stop counting as "has an open request". Returns how many rows changed.
 */
export async function failInterruptedMarketCollectionRequests(
  approvedBefore: Date,
  at: Date,
  database: AppDb = db
): Promise<number> {
  const rows = await database
    .update(marketCollectionRequests)
    .set({ status: "failed", resolvedAt: at, error: "interrupted" })
    .where(
      and(
        inArray(marketCollectionRequests.status, ["approved", "running"]),
        isNotNull(marketCollectionRequests.approvedAt),
        lt(marketCollectionRequests.approvedAt, approvedBefore)
      )
    )
    .returning({ id: marketCollectionRequests.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- Decision & Experiment Engine,
// manual-entry record-keeping foundation. Read/written only by `src/lib/decision-engine/
// adapters/store.ts`.
// ---------------------------------------------------------------------------

export type ExperimentStatus = "proposed" | "approved" | "running" | "concluded" | "abandoned";
export type ExperimentOutcomeCriteriaMet = "met" | "not_met" | "inconclusive";

export type StoredHypothesis = {
  id: string;
  channelId: string | null;
  statement: string;
  evidenceNotes: string;
  createdBy: string;
  createdVia: string;
  createdAt: Date;
};

export type StoredExperiment = {
  id: string;
  hypothesisId: string;
  treatment: string;
  controlBaseline: string;
  successCriteria: string;
  stoppingCriteria: string;
  startConditions: string | null;
  plannedDuration: string | null;
  sampleCoverageConstraints: string | null;
  budgetEstimate: string | null;
  responsible: string;
  status: ExperimentStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  changeSetId: string | null;
  executionBatchId: string | null;
  executionClaimedAt: Date | null;
  createdVia: string;
  createdAt: Date;
};

export type StoredExperimentOutcome = {
  id: string;
  experimentId: string;
  recordedBy: string;
  recordedAt: Date;
  outcomeData: string;
  dataQualityLimitations: string | null;
  criteriaMet: ExperimentOutcomeCriteriaMet;
  lessonsLearned: string | null;
  createdVia: string;
};

export async function insertHypothesis(
  input: {
    id: string;
    channelId?: string | null;
    statement: string;
    evidenceNotes: string;
    createdBy: string;
    createdVia: string;
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(hypotheses).values({
    id: input.id,
    channelId: input.channelId ?? null,
    statement: input.statement,
    evidenceNotes: input.evidenceNotes,
    createdBy: input.createdBy,
    createdVia: input.createdVia,
    ...(input.at ? { createdAt: input.at } : {}),
  });
}

export async function getHypothesisById(id: string, database: AppDb = db): Promise<StoredHypothesis | null> {
  const [row] = await database.select().from(hypotheses).where(eq(hypotheses.id, id));
  return row ?? null;
}

export async function listHypotheses(database: AppDb = db): Promise<StoredHypothesis[]> {
  return database.select().from(hypotheses).orderBy(desc(hypotheses.createdAt));
}

export async function insertExperiment(
  input: {
    id: string;
    hypothesisId: string;
    treatment: string;
    controlBaseline: string;
    successCriteria: string;
    stoppingCriteria: string;
    startConditions?: string | null;
    plannedDuration?: string | null;
    sampleCoverageConstraints?: string | null;
    budgetEstimate?: string | null;
    responsible: string;
    createdVia: string;
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(experiments).values({
    id: input.id,
    hypothesisId: input.hypothesisId,
    treatment: input.treatment,
    controlBaseline: input.controlBaseline,
    successCriteria: input.successCriteria,
    stoppingCriteria: input.stoppingCriteria,
    startConditions: input.startConditions ?? null,
    plannedDuration: input.plannedDuration ?? null,
    sampleCoverageConstraints: input.sampleCoverageConstraints ?? null,
    budgetEstimate: input.budgetEstimate ?? null,
    responsible: input.responsible,
    status: "proposed",
    createdVia: input.createdVia,
    ...(input.at ? { createdAt: input.at } : {}),
  });
}

export async function getExperimentById(id: string, database: AppDb = db): Promise<StoredExperiment | null> {
  const [row] = await database.select().from(experiments).where(eq(experiments.id, id));
  return row ?? null;
}

export async function listExperimentsByHypothesis(
  hypothesisId: string,
  database: AppDb = db
): Promise<StoredExperiment[]> {
  return database
    .select()
    .from(experiments)
    .where(eq(experiments.hypothesisId, hypothesisId))
    .orderBy(desc(experiments.createdAt));
}

/**
 * The shared "is there no FRESH execution claim in the way" guard clause -- identical logic was
 * previously copy-pasted independently into `transitionExperimentStatusIfValid`,
 * `setExperimentChangeSetIfEligible`, and `claimExperimentForExecution` (found by independent
 * review of the whole phase: three copies of one invariant is exactly the drift risk `AGENTS.md`
 * §D exists to prevent -- a future revision to the claim-expiry rule applied to one write path and
 * missed in the other two would silently change what counts as "stale" depending on which
 * operation runs). A claim is fresh (blocks) when it's set and newer than `claimExpiryCutoff`; a
 * `null` or expired claim never blocks.
 */
function noFreshExecutionClaim(claimExpiryCutoff: Date) {
  return or(isNull(experiments.executionClaimedAt), lt(experiments.executionClaimedAt, claimExpiryCutoff));
}

/**
 * The one atomic conditional transition this slice's own approval integrity depends on -- same
 * shape as `approveMarketResearchRequestIfPending` (Phase 9). `fromStatuses` is the caller's own
 * precomputed set of valid predecessor statuses for `toStatus` (`assertValidStatusTransition`'s
 * own transition table, `src/lib/decision-engine/services.ts`) -- this function itself has no
 * opinion on which transitions are valid, it only guarantees the check and the write happen
 * atomically against whatever the row's real current status is at write time, not at read time.
 * `approvedBy`/`approvedAt` are only set when `toStatus === "approved"`. Returns `null` if the
 * row's real current status was not in `fromStatuses` (either a genuinely unknown id, or a
 * same-row race the caller lost) -- the caller distinguishes those via its own upfront read, not
 * from this return value.
 *
 * `claimExpiryCutoff` (Phase 10 slice 5, added after `advisor()` found a real hole: an Abandon or
 * a manual transition could otherwise land WHILE an `executeExperiment` claim is held, and the
 * later `finalizeExperimentExecution` would then resurrect a terminal state) -- refuses to run
 * while a FRESH claim is held (`execution_claimed_at` within the cutoff), exactly like
 * `setExperimentChangeSetIfEligible` below. A stale/expired claim (a crashed execute attempt) does
 * NOT block a transition, mirroring `research_channels.collection_claimed_at`'s own "a crash never
 * permanently locks the row" precedent (Phase 9 slice 9B, `docs/ARCHITECTURE.md`'s 15-minute
 * claim-expiry note).
 *
 * `requiredChangeSetId` (added after independent review of the whole phase found a second real
 * race: the caller does its own read-time "does this experiment already have a Change Set"
 * check before calling in, but that read is stale by the time this atomic UPDATE actually runs --
 * the same class of race `claimExpiryCutoff` above already exists to close for the claim. A
 * concurrent `setExperimentChangeSetIfEligible` call landing in that window could attach a Change
 * Set between the caller's read and this write, letting a manual "approved -> running" transition
 * slip through with a real `changeSetId` attached but no Batch ever created -- exactly the state
 * `EXPERIMENT_MUST_USE_EXECUTE` exists to prevent. When provided (not `undefined`), this
 * re-verifies `changeSetId` against the row's REAL value at write time, atomically, the same way
 * `claimExperimentForExecution` already does for its own claim. Pass `null` to require no Change
 * Set is attached (the only real caller today: a manual transition INTO `"running"`); omit for
 * every other transition, which has no such invariant to protect.
 */
export async function transitionExperimentStatusIfValid(
  id: string,
  fromStatuses: ExperimentStatus[],
  toStatus: ExperimentStatus,
  approvedBy: string | null,
  at: Date,
  claimExpiryCutoff: Date,
  requiredChangeSetId?: string | null,
  database: AppDb = db
): Promise<StoredExperiment | null> {
  const rows = await database
    .update(experiments)
    .set({
      status: toStatus,
      ...(toStatus === "approved" ? { approvedBy, approvedAt: at } : {}),
    })
    .where(
      and(
        eq(experiments.id, id),
        inArray(experiments.status, fromStatuses),
        noFreshExecutionClaim(claimExpiryCutoff),
        requiredChangeSetId === undefined
          ? undefined
          : requiredChangeSetId === null
            ? isNull(experiments.changeSetId)
            : eq(experiments.changeSetId, requiredChangeSetId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Phase 10 slice 5 -- attach/detach `changeSetId` on an experiment, guarded atomically by its
 * current status (`fromStatuses`, the caller's own `["proposed", "approved"]` for both attach and
 * detach per the plan's own §4). Same shape as `transitionExperimentStatusIfValid`: the check and
 * the write happen atomically against the row's real current status, not a stale read-time value.
 * `claimExpiryCutoff` -- same fresh-claim guard as `transitionExperimentStatusIfValid` (a concurrent
 * detach must not race a claimed-but-not-yet-finalized execute attempt).
 */
export async function setExperimentChangeSetIfEligible(
  id: string,
  fromStatuses: ExperimentStatus[],
  changeSetId: string | null,
  claimExpiryCutoff: Date,
  database: AppDb = db
): Promise<StoredExperiment | null> {
  const rows = await database
    .update(experiments)
    .set({ changeSetId })
    .where(
      and(
        eq(experiments.id, id),
        inArray(experiments.status, fromStatuses),
        noFreshExecutionClaim(claimExpiryCutoff)
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Step 2 of `executeExperiment`'s claim-first design (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md
 * §4, added after `advisor()` caught a real double-execution race in an earlier draft that called
 * the Batch-creation resolver BEFORE any atomic guard). Mirrors
 * `claimStaleResearchChannelsForCollection`'s own shape (Phase 9 slice 9B) -- this claim is
 * exclusive against another FRESH claim (`execution_claimed_at IS NULL OR < claimExpiryCutoff`),
 * so at most one concurrent `executeExperiment` call for the same experiment ever proceeds to call
 * the resolver, while a crashed/expired prior claim can still be reclaimed (never permanently
 * stuck). Also requires `change_set_id = expectedChangeSetId` so a concurrent detach between the
 * caller's read-only check and this claim is caught here too, not just at the earlier read.
 */
export async function claimExperimentForExecution(
  id: string,
  expectedChangeSetId: string,
  at: Date,
  claimExpiryCutoff: Date,
  database: AppDb = db
): Promise<StoredExperiment | null> {
  const rows = await database
    .update(experiments)
    .set({ executionClaimedAt: at })
    .where(
      and(
        eq(experiments.id, id),
        eq(experiments.status, "approved"),
        eq(experiments.changeSetId, expectedChangeSetId),
        noFreshExecutionClaim(claimExpiryCutoff)
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** Releases a claim taken by `claimExperimentForExecution` -- called ONLY when the Batch-creation
 * resolver call itself throws (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §4 step 4), never when
 * `finalizeExperimentExecution` itself fails (that leaves the claim held, self-healing via
 * expiry -- see that function's own doc comment for why). The experiment returns to a normal,
 * re-attemptable `"approved"` state (status itself was never touched by the claim), never stuck.
 *
 * `expectedClaimedAt` (added after independent review of the whole phase found a real race: the
 * original unconditional `WHERE id` version could clear a DIFFERENT, newer claim than the one this
 * caller itself took, if this caller's own resolver call stalled past `claimExperimentForExecution`'s
 * 15-minute expiry window before throwing -- by then a second, legitimate caller could already have
 * reclaimed and be mid-execution. Releasing unconditionally would clear that second caller's fresh
 * claim, opening the door to a THIRD caller reclaiming and creating a second real Batch, and would
 * make the second caller's own later `finalizeExperimentExecution` guard fail (claim no longer
 * matches), orphaning its already-created Batch. Guarding by the exact claim timestamp -- the same
 * discipline `finalizeExperimentExecution` below already applies -- means a stalled caller's release
 * only ever clears ITS OWN claim, never someone else's. Returns `false` (not thrown) if the guard
 * did not match, since a lost race here is an expected, benign outcome (this call's own claim was
 * already superseded), not an error the caller needs to react to.
 */
export async function releaseExperimentExecutionClaim(
  id: string,
  expectedClaimedAt: Date,
  database: AppDb = db
): Promise<boolean> {
  const rows = await database
    .update(experiments)
    .set({ executionClaimedAt: null })
    .where(and(eq(experiments.id, id), eq(experiments.executionClaimedAt, expectedClaimedAt)))
    .returning();
  return rows.length > 0;
}

/**
 * Step 5 of `executeExperiment`. **Revised after `advisor()`:** now guarded by the exact claim
 * timestamp (`WHERE ... AND execution_claimed_at = expectedClaimedAt`), not unconditional -- the
 * earlier unconditional version could resurrect a terminal state if an Abandon/detach had somehow
 * landed in between (now impossible given the two functions above also check the claim, but this
 * guard is real defense in depth, not decorative). Clears `execution_claimed_at` back to `null` in
 * the SAME write, so the row is no longer "claimed" once it's genuinely `"running"` -- required so
 * `transitionExperimentStatusIfValid`'s own claim-freshness guard above does not then permanently
 * block the normal `running -> concluded/abandoned` lifecycle. Returns `false` if the guard did not
 * match (the claim already moved/cleared by something else) -- the caller must treat this as a real
 * failure, not assume success.
 */
export async function finalizeExperimentExecution(
  id: string,
  executionBatchId: string,
  expectedClaimedAt: Date,
  database: AppDb = db
): Promise<boolean> {
  const rows = await database
    .update(experiments)
    .set({ status: "running", executionBatchId, executionClaimedAt: null })
    .where(and(eq(experiments.id, id), eq(experiments.status, "approved"), eq(experiments.executionClaimedAt, expectedClaimedAt)))
    .returning();
  return rows.length > 0;
}

export async function insertExperimentOutcome(
  input: {
    id: string;
    experimentId: string;
    recordedBy: string;
    outcomeData: string;
    dataQualityLimitations?: string | null;
    criteriaMet: ExperimentOutcomeCriteriaMet;
    lessonsLearned?: string | null;
    createdVia: string;
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(experimentOutcomes).values({
    id: input.id,
    experimentId: input.experimentId,
    recordedBy: input.recordedBy,
    outcomeData: input.outcomeData,
    dataQualityLimitations: input.dataQualityLimitations ?? null,
    criteriaMet: input.criteriaMet,
    lessonsLearned: input.lessonsLearned ?? null,
    createdVia: input.createdVia,
    ...(input.at ? { recordedAt: input.at } : {}),
  });
}

export async function listExperimentOutcomesByExperiment(
  experimentId: string,
  database: AppDb = db
): Promise<StoredExperimentOutcome[]> {
  return database
    .select()
    .from(experimentOutcomes)
    .where(eq(experimentOutcomes.experimentId, experimentId))
    .orderBy(desc(experimentOutcomes.recordedAt));
}

export type HypothesisEvidenceSourceType =
  | "phase8_metric"
  | "phase9_channel_snapshot"
  | "phase9_video_snapshot"
  | "phase9_trend_candidate";

export type StoredHypothesisEvidence = {
  id: string;
  hypothesisId: string;
  sourceType: HypothesisEvidenceSourceType;
  referenceJson: string;
  note: string | null;
  createdVia: string;
  createdAt: Date;
};

export async function insertHypothesisEvidence(
  input: {
    id: string;
    hypothesisId: string;
    sourceType: HypothesisEvidenceSourceType;
    referenceJson: string;
    note?: string | null;
    createdVia: string;
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(hypothesisEvidence).values({
    id: input.id,
    hypothesisId: input.hypothesisId,
    sourceType: input.sourceType,
    referenceJson: input.referenceJson,
    note: input.note ?? null,
    createdVia: input.createdVia,
    ...(input.at ? { createdAt: input.at } : {}),
  });
}

export async function listHypothesisEvidenceByHypothesis(
  hypothesisId: string,
  database: AppDb = db
): Promise<StoredHypothesisEvidence[]> {
  return database
    .select()
    .from(hypothesisEvidence)
    .where(eq(hypothesisEvidence.hypothesisId, hypothesisId))
    .orderBy(desc(hypothesisEvidence.createdAt));
}

export type StoredHypothesisGenerationProvenance = {
  id: string;
  hypothesisId: string;
  connectionId: string | null;
  providerName: string;
  modelId: string | null;
  generatedStatement: string;
  finalStatement: string;
  rationale: string | null;
  evidenceRefCount: number;
  editedBeforeSave: boolean;
  createdAt: Date;
};

export async function insertHypothesisGenerationProvenance(
  input: {
    id: string;
    hypothesisId: string;
    connectionId?: string | null;
    providerName: string;
    modelId?: string | null;
    generatedStatement: string;
    finalStatement: string;
    rationale?: string | null;
    evidenceRefCount: number;
    editedBeforeSave: boolean;
    at?: Date;
  },
  database: AppDb = db
): Promise<void> {
  await database.insert(hypothesisGenerationProvenance).values({
    id: input.id,
    hypothesisId: input.hypothesisId,
    connectionId: input.connectionId ?? null,
    providerName: input.providerName,
    modelId: input.modelId ?? null,
    generatedStatement: input.generatedStatement,
    finalStatement: input.finalStatement,
    rationale: input.rationale ?? null,
    evidenceRefCount: input.evidenceRefCount,
    editedBeforeSave: input.editedBeforeSave,
    ...(input.at ? { createdAt: input.at } : {}),
  });
}

export async function getHypothesisGenerationProvenanceByHypothesis(
  hypothesisId: string,
  database: AppDb = db
): Promise<StoredHypothesisGenerationProvenance | null> {
  const rows = await database
    .select()
    .from(hypothesisGenerationProvenance)
    .where(eq(hypothesisGenerationProvenance.hypothesisId, hypothesisId))
    .limit(1);
  return rows[0] ?? null;
}

// -- BL-151 (docs/roadmap/plans/ANALYTICS_DATA_SHARING_PLAN.md): analytics and reach rows shared between devices -------------
// The rows this device collected (or imported) in a time window, and their idempotent import from another device. Merge rule:
// a row present on both keeps the one collected later (YouTube revises recent days; these are its numbers, not the owner's).

export type AnalyticsShareTables = {
  /** [channelId, videoId, metricDate, metricName, metricValue, collectedAt (unix s)] */
  videoMetrics: Array<[string, string, string, string, number, number]>;
  /** [channelId, metricDate, metricName, metricValue, collectedAt] */
  channelMetrics: Array<[string, string, string, number, number]>;
  /** [videoId, channelId, historyThrough, updatedAt] */
  videoHistory: Array<[string, string, string, number]>;
  collectionRuns: Array<{ channelId: string; start: string; end: string; videoCount: number; upserts: number; skippedJson: string; ranAt: number; channelLevel: number | null }>;
  /** [channelId, analytics_last_auto_collected_at (unix s)] */
  channelStamps: Array<[string, number]>;
  reportFiles: Array<{ reportId: string; channelId: string; reportTypeId: string; jobId: string; startTime: string; endTime: string; createTime: string; rowCount: number; status: string; importedAt: number }>;
  /** [channelId, date, videoId, impressions, ctr, sourceReportId] */
  reachRows: Array<[string, string, string, number, number | null, string]>;
  /** Outcome only: no error text leaves the device. */
  syncAttempts: Array<{ channelId: string; reportTypeId: string; attemptedAt: number; outcome: string; filesListed: number; filesImported: number }>;
  jobs: Array<{ channelId: string; reportTypeId: string; jobId: string; jobName: string; jobCreatedAt: string | null; lastCheckedAt: number | null }>;
};

export async function exportAnalyticsShareRows(fromSec: number, toSec: number, database: AppDb = db): Promise<AnalyticsShareTables> {
  type R = Record<string, unknown>;
  const all = (q: ReturnType<typeof sql>) => database.all<R>(q);
  const n = (v: unknown) => Number(v);
  const [vm, cm, vh, runs, stamps, files, attempts, jobs] = await Promise.all([
    all(sql`SELECT channel_id, video_id, metric_date, metric_name, metric_value, collected_at FROM video_metrics_daily WHERE collected_at >= ${fromSec} AND collected_at < ${toSec}`),
    all(sql`SELECT channel_id, metric_date, metric_name, metric_value, collected_at FROM channel_metrics_daily WHERE collected_at >= ${fromSec} AND collected_at < ${toSec}`),
    all(sql`SELECT video_id, channel_id, history_through, updated_at FROM analytics_video_history WHERE updated_at >= ${fromSec} AND updated_at < ${toSec}`),
    all(sql`SELECT channel_id, requested_start_date, requested_end_date, video_count, upserts_issued, skipped_video_ids_json, ran_at, channel_level FROM analytics_collection_runs WHERE ran_at >= ${fromSec} AND ran_at < ${toSec}`),
    all(sql`SELECT id AS channel_id, analytics_last_auto_collected_at AS at FROM channels WHERE analytics_last_auto_collected_at >= ${fromSec} AND analytics_last_auto_collected_at < ${toSec}`),
    all(sql`SELECT report_id, channel_id, report_type_id, job_id, start_time, end_time, create_time, row_count, status, imported_at FROM reporting_report_files WHERE imported_at >= ${fromSec} AND imported_at < ${toSec}`),
    all(sql`SELECT channel_id, report_type_id, attempted_at, outcome, files_listed, files_imported FROM reporting_sync_attempts WHERE attempted_at >= ${fromSec} AND attempted_at < ${toSec}`),
    all(sql`SELECT channel_id, report_type_id, job_id, job_name, job_created_at, last_checked_at FROM reporting_jobs WHERE last_checked_at >= ${fromSec} AND last_checked_at < ${toSec}`),
  ]);
  const reportIds = files.map((f) => String(f.report_id));
  const reach = reportIds.length > 0 ? await all(sql`SELECT channel_id, date, video_id, impressions, ctr, source_report_id FROM channel_reach_daily WHERE source_report_id IN ${reportIds}`) : [];
  return {
    videoMetrics: vm.map((r) => [String(r.channel_id), String(r.video_id), String(r.metric_date), String(r.metric_name), n(r.metric_value), n(r.collected_at)]),
    channelMetrics: cm.map((r) => [String(r.channel_id), String(r.metric_date), String(r.metric_name), n(r.metric_value), n(r.collected_at)]),
    videoHistory: vh.map((r) => [String(r.video_id), String(r.channel_id), String(r.history_through), n(r.updated_at)]),
    collectionRuns: runs.map((r) => ({
      channelId: String(r.channel_id),
      start: String(r.requested_start_date),
      end: String(r.requested_end_date),
      videoCount: n(r.video_count),
      upserts: n(r.upserts_issued),
      skippedJson: String(r.skipped_video_ids_json),
      ranAt: n(r.ran_at),
      channelLevel: r.channel_level === null ? null : n(r.channel_level),
    })),
    channelStamps: stamps.map((r) => [String(r.channel_id), n(r.at)]),
    reportFiles: files.map((r) => ({
      reportId: String(r.report_id),
      channelId: String(r.channel_id),
      reportTypeId: String(r.report_type_id),
      jobId: String(r.job_id),
      startTime: String(r.start_time),
      endTime: String(r.end_time),
      createTime: String(r.create_time),
      rowCount: n(r.row_count),
      status: String(r.status),
      importedAt: n(r.imported_at),
    })),
    reachRows: reach.map((r) => [String(r.channel_id), String(r.date), String(r.video_id), n(r.impressions), r.ctr === null ? null : n(r.ctr), String(r.source_report_id)]),
    syncAttempts: attempts.map((r) => ({ channelId: String(r.channel_id), reportTypeId: String(r.report_type_id), attemptedAt: n(r.attempted_at), outcome: String(r.outcome), filesListed: n(r.files_listed), filesImported: n(r.files_imported) })),
    jobs: jobs.map((r) => ({
      channelId: String(r.channel_id),
      reportTypeId: String(r.report_type_id),
      jobId: String(r.job_id),
      jobName: String(r.job_name),
      jobCreatedAt: r.job_created_at === null ? null : String(r.job_created_at),
      lastCheckedAt: r.last_checked_at === null ? null : n(r.last_checked_at),
    })),
  };
}

/** What an import could not fully apply: a channel listed here keeps its own "collected" stamp and runs (see below). */
export type AnalyticsShareImportResult = { incompleteChannels: string[]; skippedVideoRows: number };

const IMPORT_BATCH_SIZE = 500;

/**
 * Applies another device's rows. Never deletes; a metric row already here is replaced only by one collected later; the video
 * history only reaches further back; a collection run is added once; the "collected" stamp and the reach check times only move
 * forward; a peer's report file goes through the same period-replacement rule as one downloaded here (`importReachReport`).
 *
 * In short atomic batches (independent review, BL-151): libsql runs statements synchronously on the one Node thread, so a long
 * transaction with awaits in it held the database lock while other writers (a collection's upserts) failed with SQLITE_BUSY.
 * A batch runs in one call: no other write of this process can land inside it, and the lock is held only that long.
 *
 * A channel is INCOMPLETE when any of its metric rows names a video this device has not synced yet (they cannot be stored), or
 * the peer's run saw no videos while this device has some: its stamp and runs are then NOT imported, so this device's own
 * staleness check still collects it -- it must never count as collected while lacking the data (review H2).
 */
export async function importAnalyticsShareRows(t: AnalyticsShareTables, database: AppDb = db): Promise<AnalyticsShareImportResult> {
  const channelIds = [...new Set([...t.videoMetrics.map((r) => r[0]), ...t.videoHistory.map((r) => r[1]), ...t.collectionRuns.map((r) => r.channelId)])];
  const known = new Set<string>();
  const publishedAt = new Map<string, string>();
  const videosByChannel = new Map<string, number>();
  for (let i = 0; i < channelIds.length; i += IMPORT_BATCH_SIZE) {
    const rows = await database.all<{ id: string; channel_id: string; published_at: string }>(sql`SELECT id, channel_id, published_at FROM videos WHERE channel_id IN ${channelIds.slice(i, i + IMPORT_BATCH_SIZE)}`);
    for (const r of rows) {
      known.add(String(r.id));
      publishedAt.set(String(r.id), String(r.published_at));
      videosByChannel.set(String(r.channel_id), (videosByChannel.get(String(r.channel_id)) ?? 0) + 1);
    }
  }
  const incomplete = new Set<string>();
  let skippedVideoRows = 0;
  const items: Array<ReturnType<AppDb["run"]>> = [];

  for (const [channelId, videoId, date, name, value, at] of t.videoMetrics) {
    if (!known.has(videoId)) {
      incomplete.add(channelId);
      skippedVideoRows++;
      continue;
    }
    items.push(
      database.run(
        sql`INSERT INTO video_metrics_daily (channel_id, video_id, metric_date, metric_name, metric_value, collected_at) VALUES (${channelId}, ${videoId}, ${date}, ${name}, ${value}, ${at})
            ON CONFLICT (video_id, metric_date, metric_name) DO UPDATE SET metric_value = excluded.metric_value, collected_at = excluded.collected_at, channel_id = excluded.channel_id
            WHERE excluded.collected_at > video_metrics_daily.collected_at`
      )
    );
  }
  // A peer's ROLLING run (its latest window, the one the staleness gate looks at) that saw no videos while this device has some
  // is no coverage here. A channel-level history catch-up legitimately records 0 videos (its window ends before the rolling one)
  // and must not mark the channel incomplete (re-review).
  const latestEnd = new Map<string, string>();
  for (const r of t.collectionRuns) if (r.end > (latestEnd.get(r.channelId) ?? "")) latestEnd.set(r.channelId, r.end);
  for (const r of t.collectionRuns) {
    if (r.videoCount === 0 && r.end === latestEnd.get(r.channelId) && (videosByChannel.get(r.channelId) ?? 0) > 0) incomplete.add(r.channelId);
  }
  for (const [channelId, date, name, value, at] of t.channelMetrics) {
    items.push(
      database.run(
        sql`INSERT INTO channel_metrics_daily (channel_id, metric_date, metric_name, metric_value, collected_at) VALUES (${channelId}, ${date}, ${name}, ${value}, ${at})
            ON CONFLICT (channel_id, metric_date, metric_name) DO UPDATE SET metric_value = excluded.metric_value, collected_at = excluded.collected_at
            WHERE excluded.collected_at > channel_metrics_daily.collected_at`
      )
    );
  }
  // A history marker means "this video's rows are complete from its publish floor through X". It is taken over only when this
  // device's own rows plus the rows in this file make that true: this device already has a marker, and the file's rows for the
  // video start no later than the day after it. Otherwise this device's catch-up would never fetch the gap (re-review).
  const firstRowDate = new Map<string, string>();
  for (const [, videoId, date] of t.videoMetrics) if (date < (firstRowDate.get(videoId) ?? "9999")) firstRowDate.set(videoId, date);
  const historyIds = [...new Set(t.videoHistory.map((r) => r[0]))];
  const localThrough = new Map<string, string>();
  for (let i = 0; i < historyIds.length; i += IMPORT_BATCH_SIZE) {
    for (const r of await database.all<{ video_id: string; history_through: string }>(sql`SELECT video_id, history_through FROM analytics_video_history WHERE video_id IN ${historyIds.slice(i, i + IMPORT_BATCH_SIZE)}`)) {
      localThrough.set(String(r.video_id), String(r.history_through));
    }
  }
  const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const dayAfter = (date: string) => shiftDay(date, 1);
  for (const [videoId, channelId, through, at] of t.videoHistory) {
    // Only for a video stored here, and only when it reaches a later date (history is collected forward from publication).
    if (!known.has(videoId)) continue;
    // No marker here yet: this device's history then starts at the video's publish floor (the day before publication, as
    // analytics/catch-up.ts `videoPublishFloor`), so a file whose rows start by the publish date completes it (re-review: a new
    // device must not re-download history the other one already shared).
    const published = publishedAt.get(videoId);
    const mine = localThrough.get(videoId) ?? (published ? shiftDay(published.slice(0, 10), -1) : undefined);
    const first = firstRowDate.get(videoId);
    if (mine === undefined || first === undefined || first > dayAfter(mine)) continue;
    items.push(
      database.run(
        sql`INSERT INTO analytics_video_history (video_id, channel_id, history_through, updated_at) VALUES (${videoId}, ${channelId}, ${through}, ${at})
            ON CONFLICT (video_id) DO UPDATE SET history_through = excluded.history_through, updated_at = MAX(excluded.updated_at, analytics_video_history.updated_at)
            WHERE excluded.history_through > analytics_video_history.history_through`
      )
    );
  }
  for (const r of t.collectionRuns) {
    if (incomplete.has(r.channelId)) continue;
    items.push(
      database.run(
        sql`INSERT INTO analytics_collection_runs (channel_id, requested_start_date, requested_end_date, video_count, upserts_issued, skipped_video_ids_json, ran_at, channel_level)
            SELECT ${r.channelId}, ${r.start}, ${r.end}, ${r.videoCount}, ${r.upserts}, ${r.skippedJson}, ${r.ranAt}, ${r.channelLevel}
            WHERE NOT EXISTS (SELECT 1 FROM analytics_collection_runs WHERE channel_id = ${r.channelId} AND requested_start_date = ${r.start} AND requested_end_date = ${r.end} AND ran_at = ${r.ranAt})`
      )
    );
  }
  for (const [channelId, at] of t.channelStamps) {
    if (incomplete.has(channelId)) continue;
    items.push(database.run(sql`UPDATE channels SET analytics_last_auto_collected_at = ${at} WHERE id = ${channelId} AND (analytics_last_auto_collected_at IS NULL OR analytics_last_auto_collected_at < ${at})`));
  }
  // Only a SUCCESSFUL check counts here (review M4): another device's failure (its token, its scope) says nothing about this one,
  // and must never overwrite this device's own newer result.
  for (const a of t.syncAttempts) {
    if (a.outcome !== "ok") continue;
    items.push(
      database.run(
        sql`INSERT INTO reporting_sync_attempts (channel_id, report_type_id, attempted_at, outcome, error, files_listed, files_imported, failures_json)
            VALUES (${a.channelId}, ${a.reportTypeId}, ${a.attemptedAt}, ${a.outcome}, NULL, ${a.filesListed}, ${a.filesImported}, NULL)
            ON CONFLICT (channel_id, report_type_id) DO UPDATE SET attempted_at = excluded.attempted_at, outcome = excluded.outcome, error = NULL, files_listed = excluded.files_listed, files_imported = excluded.files_imported, failures_json = NULL
            WHERE excluded.attempted_at > reporting_sync_attempts.attempted_at`
      )
    );
  }
  for (const j of t.jobs) {
    items.push(
      database.run(
        sql`INSERT INTO reporting_jobs (channel_id, report_type_id, job_id, job_name, job_created_at, last_checked_at) VALUES (${j.channelId}, ${j.reportTypeId}, ${j.jobId}, ${j.jobName}, ${j.jobCreatedAt}, ${j.lastCheckedAt})
            ON CONFLICT (channel_id, report_type_id) DO UPDATE SET last_checked_at = excluded.last_checked_at
            WHERE excluded.job_id = reporting_jobs.job_id AND (reporting_jobs.last_checked_at IS NULL OR excluded.last_checked_at > reporting_jobs.last_checked_at)`
      )
    );
  }
  for (let i = 0; i < items.length; i += IMPORT_BATCH_SIZE) {
    const chunk = items.slice(i, i + IMPORT_BATCH_SIZE);
    await database.batch(chunk as [(typeof chunk)[number], ...(typeof chunk)[number][]]);
  }

  // A peer's report: imported once, through the same rule as a download here (a restated report replaces the older one's rows).
  const fileIds = t.reportFiles.filter((f) => f.status === "imported").map((f) => f.reportId);
  const present = new Set<string>();
  for (let i = 0; i < fileIds.length; i += IMPORT_BATCH_SIZE) {
    for (const r of await database.all<{ report_id: string }>(sql`SELECT report_id FROM reporting_report_files WHERE report_id IN ${fileIds.slice(i, i + IMPORT_BATCH_SIZE)}`)) present.add(String(r.report_id));
  }
  for (const f of t.reportFiles) {
    if (f.status !== "imported" || present.has(f.reportId)) continue;
    await importReachReport(
      {
        channelId: f.channelId,
        reportTypeId: f.reportTypeId,
        jobId: f.jobId,
        reportId: f.reportId,
        startTime: f.startTime,
        endTime: f.endTime,
        createTime: f.createTime,
        rows: t.reachRows.filter((r) => r[5] === f.reportId).map(([, date, videoId, impressions, ctr]) => ({ date, videoId, impressions, ctr })),
      },
      database
    );
  }
  return { incompleteChannels: [...incomplete], skippedVideoRows };
}

const ANALYTICS_SHARE_IMPORTED_KEY = "analytics_share_imported_files";
/** BL-151: which peer day files were imported, in which form (persisted, so a restart does not re-import 45 days of files). */
export async function getAnalyticsShareImportedJson(database: AppDb = db): Promise<string | null> {
  return getAppSetting(ANALYTICS_SHARE_IMPORTED_KEY, database);
}
export async function setAnalyticsShareImportedJson(value: string, database: AppDb = db): Promise<void> {
  await setAppSetting(ANALYTICS_SHARE_IMPORTED_KEY, value, database);
}
/** BL-151: how many videos this device has synced (a file left partly unapplied for unknown videos is retried when it grows). */
export async function countStoredVideos(database: AppDb = db): Promise<number> {
  const [row] = await database.all<{ n: number }>(sql`SELECT count(*) AS n FROM videos`);
  return Number(row?.n ?? 0);
}
