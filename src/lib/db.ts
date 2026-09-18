import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import path from "path";
import { and, eq, inArray, isNull } from "drizzle-orm";

const rawClient = createClient({
  url: `file:${path.join(process.cwd(), "data", "playlist-manager.db")}`,
});

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

export const rules = sqliteTable("rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  matchField: text("match_field").notNull(),
  matchType: text("match_type").notNull(),
  matchValue: text("match_value").notNull(),
  playlistId: text("playlist_id").notNull(),
  playlistTitle: text("playlist_title").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Exported so schema-initialization tests can point a throwaway libSQL client at an
// isolated temporary database file (per docs/DEVELOPMENT_PLAYBOOK.md §6.11) instead of
// touching data/playlist-manager.db. Behavior is identical to the singleton path below.
export async function initializeDatabaseSchema(client: Client): Promise<void> {
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
  } catch {
    // Column already exists
  }

  // Migration: add oauth_scope if missing (idempotent)
  try {
    await client.execute("ALTER TABLE users ADD COLUMN oauth_scope TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add active_attempt_id if missing (idempotent) -- for a database file that
  // already has batch_ledger_rows from before this column was added to CREATE TABLE.
  try {
    await client.execute("ALTER TABLE batch_ledger_rows ADD COLUMN active_attempt_id TEXT");
  } catch {
    // Column already exists
  }
}

async function initializeDatabase() {
  await initializeDatabaseSchema(rawClient);
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

const dbSchema = {
  users,
  rules,
  channels,
  videos,
  changeSets,
  changes,
  batches,
  batchLedgerRows,
  batchAttempts,
  videoExecutionLocks,
  auditEvents,
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

export async function listStoredChannels(): Promise<StoredChannel[]> {
  const rows = await db.select().from(channels);
  return rows.map(mapStoredChannel);
}

export async function getStoredChannel(channelId: string): Promise<StoredChannel | null> {
  const [row] = await db.select().from(channels).where(eq(channels.id, channelId));
  return row ? mapStoredChannel(row) : null;
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

export type ChangeField = "title" | "description";
export type ChangeType = "add" | "modify" | "unchanged";
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

export async function updateStoredChangeSetStatus(
  changeSetId: string,
  status: ChangeSetStatus
): Promise<void> {
  await db
    .update(changeSets)
    .set({ status, updatedAt: new Date() })
    .where(eq(changeSets.id, changeSetId));
}

export async function updateStoredChange(
  changeId: string,
  patch: Partial<
    Pick<StoredChange, "conflictStatus" | "approvalStatus" | "approvedValue">
  >
): Promise<void> {
  await db
    .update(changes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(changes.id, changeId));
}

export async function bulkUpdateStoredChanges(
  updates: Array<{
    id: string;
    patch: Partial<Pick<StoredChange, "conflictStatus" | "approvalStatus" | "approvedValue">>;
  }>
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const update of updates) {
      await tx
        .update(changes)
        .set({ ...update.patch, updatedAt: new Date() })
        .where(eq(changes.id, update.id));
    }
  });
}

// ---------------------------------------------------------------------------
// Phase 5, Slice 1 (foundation) -- Batch / per-video ledger / attempt persistence.
// See docs/acceptance/PHASE_5_ACCEPTANCE.md and src/lib/batches/contracts.ts for the
// domain-level meaning of these states; this file only persists them.
// ---------------------------------------------------------------------------

export type BatchStatus = "PENDING" | "RUNNING" | "COMPLETED" | "ABORTED";
// Kept in sync by hand with src/lib/batches/contracts.ts's LedgerStatus -- this file only
// persists the value, contracts.ts is the authoritative definition and state machine.
export type LedgerStatus =
  | "PENDING"
  | "AWAITING_EXECUTION"
  | "APPLYING"
  | "SUCCESS"
  | "FAILED"
  | "CONFLICT"
  | "UNKNOWN"
  | "ABORTED_SYSTEMIC"
  | "DRY_RUN_COMPLETE";
export type AttemptPhase = "INTENDED" | "RESULT_RECORDED";
export type AttemptOutcome = "SUCCESS" | "FAILED" | "UNKNOWN";

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
