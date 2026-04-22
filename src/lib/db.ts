import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import path from "path";

const client = createClient({
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
  selectedChannelId: text("selected_channel_id"),
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

export const db = drizzle(client, { schema: { users, rules } });

// Auto-create tables
await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT NOT NULL,
    image TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expiry INTEGER,
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
`);

// Migration: add selected_channel_id if missing (idempotent)
try {
  await client.execute(
    "ALTER TABLE users ADD COLUMN selected_channel_id TEXT"
  );
} catch {
  // Column already exists
}
