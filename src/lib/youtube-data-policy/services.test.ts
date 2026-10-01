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
  await cand("UC-old-ignored", 31);
  await client.execute("UPDATE market_discovery_candidates SET status = 'ignored', reason_discovered = 'r' WHERE id = 'UC-old-ignored'");
  await client.execute({
    sql: "INSERT INTO research_evidence (id, research_channel_id, observation, source, confidence, created_via, collected_at) VALUES ('ev-ai', 'UCx', 'AI summary of views', 'ai_assisted', 'low', 'web_ui', ?), ('ev-manual', 'UCx', 'my note', 'manual', 'low', 'web_ui', ?)",
    args: [nowS - 40 * DAY, nowS - 400 * DAY],
  });
  // An operator's free-text source that merely starts with "youtube." is NOT API data.
  await snap("old-manual-yt", 400, "youtube.com channel page");
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
    assert.deepEqual(await ids("SELECT id FROM market_channel_snapshots"), ["fresh-api", "old-manual", "old-manual-yt"]);
    assert.deepEqual(await ids("SELECT id FROM market_video_snapshots"), []);
    // An undecided candidate is deleted; an operator's decision is kept, its API title/reason blanked.
    assert.deepEqual(await ids("SELECT id FROM market_discovery_candidates"), ["UC-fresh-cand", "UC-old-ignored"]);
    const kept = (await client.execute("SELECT status, title, reason_discovered FROM market_discovery_candidates WHERE id = 'UC-old-ignored'")).rows[0];
    assert.deepEqual([kept.status, kept.title, kept.reason_discovered], ["ignored", "", null]);
    assert.deepEqual(await ids("SELECT record_id FROM channel_record_assignments"), ["UC-fresh-cand"]);
    // AI-assisted evidence (summarizing API values) expires; the operator's own note does not.
    assert.deepEqual(await ids("SELECT id FROM research_evidence"), ["ev-manual"]);
    assert.deepEqual(await ids("SELECT id FROM channels"), ["UCmine"]);
    assert.deepEqual(await ids("SELECT id FROM research_channels"), ["UCx"]);
    assert.deepEqual(
      result.map((r) => [r.table, r.deleted, r.blanked]),
      [
        ["market_channel_snapshots", 1, 0],
        ["market_video_snapshots", 1, 0],
        ["market_discovery_candidates", 1, 1],
        ["research_evidence", 1, 0],
      ]
    );
    // A second run blanks nothing again (already blank) and deletes nothing.
    const again = await purgeExpiredApiData(client, NOW);
    assert.ok(again.every((r) => r.deleted === 0 && r.blanked === 0));
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

test("review round 1: every snapshot source collection writes is on the purge's API-source list", async () => {
  const { YOUTUBE_API_SNAPSHOT_SOURCES } = await import("./contracts");
  const code = await readFile(path.resolve(process.cwd(), "src/lib/market-intelligence/services.ts"), "utf8");
  // Snapshot rows' `source` (not candidates' `discoverySource`, which expires by its clock regardless).
  const written = new Set([...code.matchAll(/(?:\bsource:|statsSource\s*=)\s*"(youtube\.[a-zA-Z.]+)"/g)].map((m) => m[1]));
  assert.ok(written.size >= 2, "test precondition: the scan finds the collection's source strings");
  const allowed = new Set<string>(YOUTUBE_API_SNAPSHOT_SOURCES);
  assert.deepEqual([...written].filter((src) => !allowed.has(src)), []);
});

test("review round 2: with nothing expiring, the purge takes no write lock and runs no hooks", () =>
  withTempDir("data-policy-", async (dir) => {
    const client = await makeClient(dir);
    let hooksRan = 0;
    const result = await purgeExpiredApiData(client, NOW, {
      beforePurge: async () => {
        hooksRan += 1;
      },
      afterPurge: async () => {
        hooksRan += 1;
      },
    });
    assert.equal(hooksRan, 0);
    assert.ok(result.every((r) => r.deleted === 0 && r.blanked === 0));
    client.close();
  }));
