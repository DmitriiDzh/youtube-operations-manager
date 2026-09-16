import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import path from "path";
import { eq } from "drizzle-orm";

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

async function initializeDatabase() {
  await rawClient.executeMultiple(`
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
  `);

  // Migration: add selected_channel_id if missing (idempotent)
  try {
    await rawClient.execute("ALTER TABLE users ADD COLUMN selected_channel_id TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add oauth_scope if missing (idempotent)
  try {
    await rawClient.execute("ALTER TABLE users ADD COLUMN oauth_scope TEXT");
  } catch {
    // Column already exists
  }
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

export const db = drizzle(client, {
  schema: { users, rules, channels, videos, changeSets, changes },
});

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
