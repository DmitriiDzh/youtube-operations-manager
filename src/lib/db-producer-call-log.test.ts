import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { createIsolatedDb, initializeDatabaseSchema, insertProducerCallLogEntry, listProducerCallLogEntries, SCHEMA_MIGRATIONS } from "@/lib/db";

// Owner TG 4782 (the Producer edits the connected channels' playlists), independent review: a Producer playlist write's call-log row
// says what it wrote. Schema v124 adds two nullable columns to `producer_call_log` (v72): `target` (the playlist) and `details_json`.
// An existing row keeps its values and reads null in both; every other call still writes null there.

async function withClient(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-producer-call-log-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function columns(client: Client): Promise<string[]> {
  const rows = await client.execute("PRAGMA table_info(producer_call_log)");
  return rows.rows.map((row) => String(row.name));
}

test("schema v124 adds target and details_json to a v72 producer_call_log, keeping its rows; re-applying is harmless", async () => {
  const migration = SCHEMA_MIGRATIONS.find((m) => m.version === 124);
  assert.ok(migration, "v124 exists");
  await withClient(async (client) => {
    // The table exactly as v72 created it, with one row already logged.
    await client.execute(
      "CREATE TABLE producer_call_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, tool TEXT NOT NULL, channel_id TEXT, outcome TEXT NOT NULL, error_code TEXT)"
    );
    await client.execute("INSERT INTO producer_call_log (at, tool, channel_id, outcome, error_code) VALUES (1760000000, 'channel_video_list', 'UC_T', 'ok', NULL)");
    await migration.apply(client);
    await migration.apply(client);
    assert.deepEqual(await columns(client), ["id", "at", "tool", "channel_id", "outcome", "error_code", "target", "details_json"]);
    const rows = await client.execute("SELECT tool, channel_id, outcome, target, details_json FROM producer_call_log");
    assert.deepEqual(rows.rows.map((row) => [row.tool, row.channel_id, row.outcome, row.target, row.details_json]), [["channel_video_list", "UC_T", "ok", null, null]]);
  });
});

test("a playlist write's target and details are stored and read back; a call without them reads null", async () => {
  await withClient(async (client) => {
    await initializeDatabaseSchema(client);
    const database = createIsolatedDb(client);
    const now = new Date("2026-11-23T12:00:00Z");
    await insertProducerCallLogEntry({ at: new Date(now.getTime() - 60_000), tool: "channel_video_list", channelId: "UC_T", outcome: "ok", errorCode: null }, database);
    await insertProducerCallLogEntry(
      {
        at: now,
        tool: "playlist_add_videos",
        channelId: "UC_T",
        outcome: "error",
        errorCode: "WRITE_CHANNEL_MISMATCH",
        target: "PL_OTHER",
        details: '{"videoIds":["v1","v2"]}',
      },
      database
    );
    const entries = await listProducerCallLogEntries(10, database, now);
    assert.deepEqual(
      entries.map((entry) => [entry.tool, entry.errorCode, entry.target, entry.detailsJson]),
      [
        ["playlist_add_videos", "WRITE_CHANNEL_MISMATCH", "PL_OTHER", '{"videoIds":["v1","v2"]}'],
        ["channel_video_list", null, null, null],
      ]
    );
  });
});
