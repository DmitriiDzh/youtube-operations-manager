import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  SCHEMA_CURRENT_VERSION,
  getLatestMarketIntelligenceCollectionRunForChannel,
  getMarketIntelligenceCollectionDepthDefaults,
  getResearchChannelById,
  initializeDatabaseSchema,
  insertMarketIntelligenceCollectionRun,
  insertResearchChannel,
  saveResearchChannelCollectionProgress,
  setMarketIntelligenceCollectionDepthDefaults,
  setResearchChannelCollectionDepth,
} from "@/lib/db";
import { readSchemaVersion } from "@/lib/schema-versioning";

// Operator request 2026-10-04 (collection depth): SCHEMA_MIGRATIONS version 48 and the db helpers. Real SQLite.

test("migration v48 applies on a v47 database; existing watchlist and run rows keep working with NULL / false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-depth-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    // Turn the database back into a v47 one: drop v48's columns, stamp 47, add legacy rows.
    for (const column of ["max_videos_per_channel", "published_after", "videos_complete", "videos_complete_reason", "videos_next_page_token", "videos_cap_at_run", "videos_published_after_at_run"]) {
      await client.execute(`ALTER TABLE research_channels DROP COLUMN ${column}`);
    }
    await client.execute("ALTER TABLE market_intelligence_collection_runs DROP COLUMN feed_fallback");
    await client.execute("UPDATE schema_meta SET value = '47' WHERE key = 'schema_version'");
    await client.execute("INSERT INTO research_channels (id, handle_or_url, reason, created_via, added_at) VALUES ('UC_legacy', NULL, 'old', 'web_ui', 1700000000)");
    await client.execute(
      "INSERT INTO market_intelligence_collection_runs (research_channel_id, ran_at, status, units_spent) VALUES ('UC_legacy', 1700000000, 'success', 3)"
    );

    await initializeDatabaseSchema(client);

    assert.equal(await readSchemaVersion(client), SCHEMA_CURRENT_VERSION);
    assert.ok(SCHEMA_CURRENT_VERSION >= 48);
    const channel = (await client.execute("SELECT * FROM research_channels WHERE id = 'UC_legacy'")).rows[0];
    for (const column of ["max_videos_per_channel", "published_after", "videos_complete", "videos_complete_reason", "videos_next_page_token", "videos_cap_at_run", "videos_published_after_at_run"]) {
      assert.equal(channel[column], null, column);
    }
    const run = (await client.execute("SELECT feed_fallback, units_spent FROM market_intelligence_collection_runs WHERE research_channel_id = 'UC_legacy'")).rows[0];
    assert.equal(Number(run.feed_fallback), 0);
    assert.equal(Number(run.units_spent), 3);

    // Applying it a second time (a partly migrated database) is harmless.
    await client.execute("UPDATE schema_meta SET value = '47' WHERE key = 'schema_version'");
    await initializeDatabaseSchema(client);
    assert.equal(await readSchemaVersion(client), SCHEMA_CURRENT_VERSION);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("depth defaults: unset reads null/null, round-trips a value and a date, and a cleared value reads null again", async () => {
  assert.deepEqual(await getMarketIntelligenceCollectionDepthDefaults(), { maxVideosPerChannel: null, publishedAfter: null });
  await setMarketIntelligenceCollectionDepthDefaults({ maxVideosPerChannel: 300, publishedAfter: "2026-01-02" });
  assert.deepEqual(await getMarketIntelligenceCollectionDepthDefaults(), { maxVideosPerChannel: 300, publishedAfter: "2026-01-02" });
  await setMarketIntelligenceCollectionDepthDefaults({ maxVideosPerChannel: null, publishedAfter: null });
  assert.deepEqual(await getMarketIntelligenceCollectionDepthDefaults(), { maxVideosPerChannel: null, publishedAfter: null });
});

test("a research channel stores its depth override and progress; a run row stores feedFallback (default false)", async () => {
  await insertResearchChannel({ id: "UC_depth_1", reason: "test", createdVia: "web_ui" });
  const fresh = await getResearchChannelById("UC_depth_1");
  assert.deepEqual(
    [fresh?.maxVideosPerChannel, fresh?.publishedAfter, fresh?.videosComplete, fresh?.videosNextPageToken],
    [null, null, null, null]
  );

  await setResearchChannelCollectionDepth("UC_depth_1", { maxVideosPerChannel: 400, publishedAfter: "2026-02-03" });
  await saveResearchChannelCollectionProgress("UC_depth_1", { complete: false, completeReason: null, nextPageToken: "CAUQAA", capAtRun: 400, publishedAfterAtRun: "2026-02-03" });
  const row = await getResearchChannelById("UC_depth_1");
  assert.deepEqual(
    [row?.maxVideosPerChannel, row?.publishedAfter, row?.videosComplete, row?.videosCompleteReason, row?.videosNextPageToken, row?.videosCapAtRun, row?.videosPublishedAfterAtRun],
    [400, "2026-02-03", 0, null, "CAUQAA", 400, "2026-02-03"]
  );

  await insertMarketIntelligenceCollectionRun({ researchChannelId: "UC_depth_1", status: "success", unitsSpent: 2, ranAt: new Date("2026-10-04T10:00:00Z") });
  assert.equal((await getLatestMarketIntelligenceCollectionRunForChannel("UC_depth_1"))?.feedFallback, false);
  await insertMarketIntelligenceCollectionRun({ researchChannelId: "UC_depth_1", status: "success", unitsSpent: 2, feedFallback: true, ranAt: new Date("2026-10-04T11:00:00Z") });
  assert.equal((await getLatestMarketIntelligenceCollectionRunForChannel("UC_depth_1"))?.feedFallback, true);
});
