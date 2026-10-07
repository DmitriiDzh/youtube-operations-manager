import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { exportAnalyticsShareRows, importAnalyticsShareRows, initializeDatabaseSchema, type AppDb } from "@/lib/db";
import { isAnalyticsCollectionStale } from "@/lib/analytics/staleness";
import { withTempDir } from "@/test-support/temp-dir";
import { createAnalyticsDataSync } from "./services";

// BL-151 (docs/roadmap/plans/ANALYTICS_DATA_SHARING_PLAN.md). Two real databases stand for two computers sharing one Syncthing
// folder. Requirements: after A collects a channel today, B has A's rows and its own "collected today?" check says current
// (AC-AD-01); importing twice changes nothing and the later collection wins (AC-AD-02); a reach check A made counts on B and
// A's report files are known to B (AC-AD-03); a file that names another device is not read (AC-AD-04); no folder = no-op (AC-AD-05).

const NOW = new Date("2026-10-07T12:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000);

async function computer(root: string, name: string) {
  const client = createClient({ url: `file:${path.join(root, `${name}.db`)}` });
  await initializeDatabaseSchema(client);
  const database = drizzle(client) as unknown as AppDb;
  await database.run(sql`INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('UC1', 'Rural Japan', 'UU1')`);
  // Both computers synced the channel's videos (each does, on its own).
  for (const v of ["v1", "v2"]) {
    await database.run(sql`INSERT INTO videos (id, channel_id, title, description, published_at, privacy_status, thumbnails_json, localizations_json) VALUES (${v}, 'UC1', ${v}, '', '2026-09-01T00:00:00Z', 'public', '{}', '{}')`);
  }
  return { client, database };
}

function syncFor(database: AppDb, deviceId: string, folder: string | null, now = NOW) {
  return createAnalyticsDataSync({
    getConfig: async () => ({ deviceId, folder }),
    exportRows: (from, to) => exportAnalyticsShareRows(from, to, database),
    importRows: (tables) => importAnalyticsShareRows(tables, database),
    clock: { now: () => now },
  });
}

/** What computer A's collection of today leaves in its database. */
async function collectOnA(database: AppDb) {
  await database.run(sql`INSERT INTO video_metrics_daily (channel_id, video_id, metric_date, metric_name, metric_value, collected_at) VALUES ('UC1', 'v1', '2026-10-06', 'views', 120, ${T - 600}), ('UC1', 'v2', '2026-10-06', 'views', 40, ${T - 600})`);
  await database.run(sql`INSERT INTO channel_metrics_daily (channel_id, metric_date, metric_name, metric_value, collected_at) VALUES ('UC1', '2026-10-06', 'subscribersGained', 3, ${T - 600})`);
  await database.run(sql`INSERT INTO analytics_collection_runs (channel_id, requested_start_date, requested_end_date, video_count, upserts_issued, skipped_video_ids_json, ran_at, channel_level) VALUES ('UC1', '2026-09-08', '2026-10-06', 2, 2, '[]', ${T - 600}, 1)`);
  await database.run(sql`UPDATE channels SET analytics_last_auto_collected_at = ${T - 600} WHERE id = 'UC1'`);
  await database.run(sql`INSERT INTO reporting_report_files (report_id, channel_id, report_type_id, job_id, start_time, end_time, create_time, row_count, status, imported_at) VALUES ('r1', 'UC1', 'channel_reach_basic_a1', 'job1', '2026-10-05T07:00:00Z', '2026-10-06T07:00:00Z', '2026-10-06T10:00:00Z', 1, 'imported', ${T - 300})`);
  await database.run(sql`INSERT INTO channel_reach_daily (channel_id, date, video_id, impressions, ctr, source_report_id) VALUES ('UC1', '2026-10-05', 'v1', 900, 0.04, 'r1')`);
  await database.run(sql`INSERT INTO reporting_sync_attempts (channel_id, report_type_id, attempted_at, outcome, error, files_listed, files_imported, failures_json) VALUES ('UC1', 'channel_reach_basic_a1', ${T - 300}, 'ok', 'secret detail', 1, 1, '["x"]')`);
}

const count = async (database: AppDb, table: string) => Number((await database.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`)))[0].n);

test("AC-AD-01/03: what A collected today reaches B; B's own check then says the channel is current, and A's reach check counts", () =>
  withTempDir("analytics-share-", async (root) => {
    const folder = path.join(root, "Sync");
    await mkdir(folder);
    const a = await computer(root, "a");
    const b = await computer(root, "b");
    try {
      await collectOnA(a.database);
      assert.equal(await syncFor(a.database, "dev-a", folder).publishLocal(), "published");
      const outcome = await syncFor(b.database, "dev-b", folder).importPeers();
      assert.deepEqual(outcome.imported, ["dev-a/2026-10-07.json"]);
      assert.equal(await count(b.database, "video_metrics_daily"), 2);
      assert.equal(await count(b.database, "channel_metrics_daily"), 1);
      assert.equal(await count(b.database, "channel_reach_daily"), 1);
      assert.equal(await count(b.database, "reporting_report_files"), 1, "A's downloaded report is known: B never downloads it again");
      const [stamp] = await b.database.all<{ at: number }>(sql`SELECT analytics_last_auto_collected_at AS at FROM channels WHERE id = 'UC1'`);
      // B's own staleness check (boundary 06:00 UTC) now says current, and a genuine run covers yesterday.
      assert.equal(isAnalyticsCollectionStale({ now: NOW, lastAutoCollectedAt: new Date(stamp.at * 1000), timezone: "UTC", localTime: "06:00" }), false);
      const runs = await b.database.all<{ s: string; e: string }>(sql`SELECT requested_start_date AS s, requested_end_date AS e FROM analytics_collection_runs`);
      assert.ok(runs.some((r) => r.s <= "2026-10-06" && r.e >= "2026-10-06"));
      const [attempt] = await b.database.all<{ at: number; error: string | null }>(sql`SELECT attempted_at AS at, error FROM reporting_sync_attempts`);
      assert.equal(attempt.at, T - 300);
      assert.equal(attempt.error, null, "no error text leaves A");
      const fileText = await readFile(path.join(folder, "analytics-data", "dev-a", "2026-10-07.json"), "utf8");
      assert.ok(!fileText.includes("secret detail"));
    } finally {
      a.client.close();
      b.client.close();
    }
  }));

test("AC-AD-02: importing twice changes nothing; a row present on both keeps the later collection; a stamp only moves forward", () =>
  withTempDir("analytics-share-", async (root) => {
    const folder = path.join(root, "Sync");
    await mkdir(folder);
    const a = await computer(root, "a");
    const b = await computer(root, "b");
    try {
      await collectOnA(a.database);
      // B collected v1 later (a revised number) and its own stamp is later too.
      await b.database.run(sql`INSERT INTO video_metrics_daily (channel_id, video_id, metric_date, metric_name, metric_value, collected_at) VALUES ('UC1', 'v1', '2026-10-06', 'views', 125, ${T - 60})`);
      await b.database.run(sql`UPDATE channels SET analytics_last_auto_collected_at = ${T - 60} WHERE id = 'UC1'`);
      await syncFor(a.database, "dev-a", folder).publishLocal();
      const syncB = syncFor(b.database, "dev-b", folder);
      await syncB.importPeers();
      const before = await b.database.all(sql`SELECT * FROM video_metrics_daily ORDER BY video_id`);
      assert.deepEqual((await syncB.importPeers()).imported, [], "an unchanged file is not read again");
      await importAnalyticsShareRows(await exportAnalyticsShareRows(0, T + 1, a.database), b.database);
      assert.deepEqual(await b.database.all(sql`SELECT * FROM video_metrics_daily ORDER BY video_id`), before, "a second import changes nothing");
      const [v1] = await b.database.all<{ v: number }>(sql`SELECT metric_value AS v FROM video_metrics_daily WHERE video_id = 'v1'`);
      assert.equal(v1.v, 125, "B's later collection is kept");
      assert.equal(await count(b.database, "analytics_collection_runs"), 1, "A's run is added once");
      const [stamp] = await b.database.all<{ at: number }>(sql`SELECT analytics_last_auto_collected_at AS at FROM channels WHERE id = 'UC1'`);
      assert.equal(stamp.at, T - 60);
    } finally {
      a.client.close();
      b.client.close();
    }
  }));

test("AC-AD-04/05: a file naming another device is not imported; B's own files are never read as a peer's; no folder = nothing", () =>
  withTempDir("analytics-share-", async (root) => {
    const folder = path.join(root, "Sync");
    await mkdir(folder);
    const a = await computer(root, "a");
    const b = await computer(root, "b");
    try {
      await collectOnA(a.database);
      await syncFor(a.database, "dev-a", folder).publishLocal();
      // A file in dev-x's folder that claims to be dev-a's: refused.
      const text = await readFile(path.join(folder, "analytics-data", "dev-a", "2026-10-07.json"), "utf8");
      await mkdir(path.join(folder, "analytics-data", "dev-x"));
      await writeFile(path.join(folder, "analytics-data", "dev-x", "2026-10-07.json"), text);
      const outcome = await syncFor(b.database, "dev-b", folder).importPeers();
      assert.deepEqual(outcome.imported, ["dev-a/2026-10-07.json"]);
      assert.deepEqual(outcome.skipped.map((s) => s.file), ["dev-x/2026-10-07.json"]);
      assert.deepEqual((await syncFor(a.database, "dev-a", folder).importPeers()).imported, ["dev-x/2026-10-07.json"].filter(() => false), "A never imports its own files; dev-x's lie is refused");
      assert.equal(await syncFor(b.database, "dev-b", null).publishLocal(), "no_folder");
      assert.deepEqual(await syncFor(b.database, "dev-b", path.join(root, "unplugged")).importPeers(), { imported: [], skipped: [] });
      assert.deepEqual(await readdir(path.join(folder, "analytics-data")), ["dev-a", "dev-x"], "B wrote nothing: it had nothing of its own");
    } finally {
      a.client.close();
      b.client.close();
    }
  }));

test("own day files older than the window are deleted; an unchanged day is not rewritten", () =>
  withTempDir("analytics-share-", async (root) => {
    const folder = path.join(root, "Sync");
    const a = await computer(root, "a");
    try {
      await mkdir(path.join(folder, "analytics-data", "dev-a"), { recursive: true });
      await writeFile(path.join(folder, "analytics-data", "dev-a", "2026-08-01.json"), "{}");
      await collectOnA(a.database);
      const sync = syncFor(a.database, "dev-a", folder);
      assert.equal(await sync.publishLocal(), "published");
      assert.equal(await sync.publishLocal(), "unchanged");
      assert.deepEqual(await readdir(path.join(folder, "analytics-data", "dev-a")), ["2026-10-07.json"]);
    } finally {
      a.client.close();
    }
  }));
