import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { initializeDatabaseSchema } from "@/lib/db";
import { withTempDir } from "@/test-support/temp-dir";
import { API_DATA_RETENTION_DAYS, YOUTUBE_DATA_CLASSIFICATION, purgeExpiredApiData } from "./index";

// Acceptance criteria: docs/roadmap/plans/PHASE_13_PLAN.md §5, from the YouTube API Developer
// Policies III.E.4.b/c/d (not from this implementation).

test("13.1: every schema table is classified against the YouTube API data policies", async () => {
  const source = await readFile(path.resolve(process.cwd(), "src/lib/db.ts"), "utf8");
  const created = new Set([...source.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]));
  created.add("schema_meta");
  const classified = new Set(Object.keys(YOUTUBE_DATA_CLASSIFICATION));
  const unclassified = [...created].filter((t) => !classified.has(t));
  const unknown = [...classified].filter((t) => !created.has(t));
  assert.deepEqual({ unclassified, unknown }, { unclassified: [], unknown: [] });
});

test("13.1: every Non-Authorized clock column really exists in the schema", () =>
  withTempDir("data-policy-", async (dir) => {
    const client = await makeClient(dir);
    for (const [table, c] of Object.entries(YOUTUBE_DATA_CLASSIFICATION)) {
      if (c.kind !== "non_authorized") continue;
      const cols = (await client.execute(`PRAGMA table_info("${table}")`)).rows.map((r) => String(r.name));
      assert.ok(cols.includes(c.clockColumn), `${table}.${c.clockColumn}`);
    }
    client.close();
  }));

async function makeClient(dir: string): Promise<Client> {
  const client = createClient({ url: `file:${path.join(dir, "p.db")}` });
  await initializeDatabaseSchema(client);
  return client;
}

const DAY = 24 * 60 * 60;
const NOW = new Date("2026-10-01T12:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);

async function seed(client: Client) {
  await client.execute("INSERT INTO research_channels (id, reason, created_via) VALUES ('UCx', 'r', 'web_ui')");
  const snap = async (id: string, ageDays: number, source: string) =>
    client.execute({
      sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, observed_at, subscriber_count, hidden_subscriber_count, source, created_via) VALUES (?, 'UCx', ?, 1, 0, ?, 'web_ui')",
      args: [id, nowS - ageDays * DAY, source],
    });
  await snap("old-api", API_DATA_RETENTION_DAYS + 1, "youtube.channels.list");
  await snap("fresh-api", API_DATA_RETENTION_DAYS - 1, "youtube.channels.list");
  await snap("old-manual", 400, "manual observation");
  await client.execute({
    sql: "INSERT INTO market_video_snapshots (id, research_channel_id, video_id, observed_at, view_count, source, created_via) VALUES ('v-old', 'UCx', 'vid', ?, 5, 'youtube.videos.list', 'web_ui')",
    args: [nowS - 45 * DAY],
  });
  const cand = async (id: string, ageDays: number) =>
    client.execute({
      sql: "INSERT INTO market_discovery_candidates (id, title, status, discovery_source, discovery_query, first_seen_at, last_seen_at, created_via) VALUES (?, 't', 'new', 'search', 'q', ?, ?, 'web_ui')",
      args: [id, nowS - ageDays * DAY, nowS - ageDays * DAY],
    });
  await cand("UC-old-cand", 31);
  await cand("UC-fresh-cand", 2);
  await client.execute("INSERT INTO channel_record_assignments (channel_id, record_kind, record_id) VALUES ('UCmine', 'discovery_candidate', 'UC-old-cand')");
  await client.execute("INSERT INTO channel_record_assignments (channel_id, record_kind, record_id) VALUES ('UCmine', 'discovery_candidate', 'UC-fresh-cand')");
  // Our own channel's data (Authorized, III.E.4.b) -- must survive regardless of age.
  await client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('UCmine', 'mine', 'UUmine')");
}

test("AC-P13-01/07: API-sourced competitor rows older than 30 days are deleted; fresh, manual and own data survive", () =>
  withTempDir("data-policy-", async (dir) => {
    const client = await makeClient(dir);
    await seed(client);
    const result = await purgeExpiredApiData(client, NOW);

    const ids = async (sql: string) => (await client.execute(sql)).rows.map((r) => String(Object.values(r)[0])).sort();
    assert.deepEqual(await ids("SELECT id FROM market_channel_snapshots"), ["fresh-api", "old-manual"]);
    assert.deepEqual(await ids("SELECT id FROM market_video_snapshots"), []);
    assert.deepEqual(await ids("SELECT id FROM market_discovery_candidates"), ["UC-fresh-cand"]);
    assert.deepEqual(await ids("SELECT record_id FROM channel_record_assignments"), ["UC-fresh-cand"]);
    assert.deepEqual(await ids("SELECT id FROM channels"), ["UCmine"]);
    assert.deepEqual(await ids("SELECT id FROM research_channels"), ["UCx"]);
    assert.deepEqual(
      result.map((r) => [r.table, r.deleted]),
      [
        ["market_channel_snapshots", 1],
        ["market_video_snapshots", 1],
        ["market_discovery_candidates", 1],
      ]
    );
    client.close();
  }));

test("purge: exactly 30 days old is kept (the policy says 'not longer than 30 calendar days')", () =>
  withTempDir("data-policy-", async (dir) => {
    const client = await makeClient(dir);
    await client.execute("INSERT INTO research_channels (id, reason, created_via) VALUES ('UCx', 'r', 'web_ui')");
    await client.execute({
      sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, observed_at, hidden_subscriber_count, source, created_via) VALUES ('edge', 'UCx', ?, 0, 'youtube.channels.list', 'web_ui')",
      args: [nowS - API_DATA_RETENTION_DAYS * DAY],
    });
    await purgeExpiredApiData(client, NOW);
    assert.equal((await client.execute("SELECT COUNT(*) AS n FROM market_channel_snapshots")).rows[0].n, 1);
    client.close();
  }));
