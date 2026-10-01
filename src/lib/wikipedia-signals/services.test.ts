import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createClient } from "@libsql/client";
import {
  createIsolatedDb,
  deleteTopicWikipediaArticle,
  getLatestWikipediaPageviewDate,
  initializeDatabaseSchema,
  insertTopicWikipediaArticle,
  listTopicWikipediaArticles,
  listWikipediaPageviews,
  upsertWikipediaPageviews,
} from "@/lib/db";
import { withTempDir } from "@/test-support/temp-dir";
import { createWikipediaSignalsServices, parseArticleReference } from "./services";

// Phase 13 slice 13.8 (docs/roadmap/plans/PHASE_13_PLAN.md). Expected values are hand-computed.

test("13.8: an article is accepted as a title or a Wikipedia URL, normalized to project + underscored title", () => {
  assert.deepEqual(parseArticleReference({ article: "Ambient music" }), { project: "en.wikipedia", article: "Ambient_music" });
  assert.deepEqual(parseArticleReference({ article: "https://de.wikipedia.org/wiki/Ambient_(Musik)" }), {
    project: "de.wikipedia",
    article: "Ambient_(Musik)",
  });
  assert.deepEqual(parseArticleReference({ article: "https://en.m.wikipedia.org/wiki/Lo-fi_music?x=1" }), {
    project: "en.wikipedia",
    article: "Lo-fi_music",
  });
  assert.throws(() => parseArticleReference({ project: "example.com", article: "x" }));
  assert.throws(() => parseArticleReference({ article: "   " }));
});

function harness(dir: string, now: Date, fetched: { calls: unknown[]; rows: { date: string; views: number }[] }) {
  const client = createClient({ url: `file:${path.join(dir, "w.db")}` });
  const db = createIsolatedDb(client);
  let n = 0;
  const services = createWikipediaSignalsServices({
    idGenerator: () => `link-${++n}`,
    clock: { now: () => now },
    insertLink: (input) => insertTopicWikipediaArticle(input, db),
    deleteLink: (id) => deleteTopicWikipediaArticle(id, db),
    listLinks: (topicId) => listTopicWikipediaArticles(topicId, db),
    upsertPageviews: (rows) => upsertWikipediaPageviews(rows, db),
    listPageviews: (args) => listWikipediaPageviews(args, db),
    latestPageviewDate: (args) => getLatestWikipediaPageviewDate(args, db),
    fetchPageviews: async (args) => {
      fetched.calls.push(args);
      return fetched.rows;
    },
  });
  return { client, db, services };
}

test("13.8: linking to an unknown topic is refused; deleting a topic removes its links (FK cascade)", () =>
  withTempDir("wiki-", async (dir) => {
    const fetched = { calls: [] as unknown[], rows: [] };
    const { client, db, services } = harness(dir, new Date("2026-10-01T12:00:00Z"), fetched);
    await initializeDatabaseSchema(client);
    await assert.rejects(() => services.linkArticle({ topicId: "nope", article: "Ambient music" }, { createdVia: "web_ui" }), /No such topic/);
    await client.execute("INSERT INTO market_topics (id, name, created_via) VALUES ('t1', 'Ambient', 'web_ui')");
    await services.linkArticle({ topicId: "t1", article: "Ambient music" }, { createdVia: "web_ui" });
    await assert.rejects(() => services.linkArticle({ topicId: "t1", article: "Ambient_music" }, { createdVia: "web_ui" }), /already linked/);
    await client.execute("DELETE FROM market_topics WHERE id = 't1'");
    assert.deepEqual(await listTopicWikipediaArticles(null, db), []);
    client.close();
  }));

test("13.8: collection fetches only missing days up to yesterday, and the 30-day sums are computed from stored days", () =>
  withTempDir("wiki-", async (dir) => {
    const now = new Date("2026-10-01T12:00:00Z");
    const fetched = { calls: [] as unknown[], rows: [] as { date: string; views: number }[] };
    const { client, services } = harness(dir, now, fetched);
    await initializeDatabaseSchema(client);
    await client.execute("INSERT INTO market_topics (id, name, created_via) VALUES ('t1', 'Ambient', 'web_ui')");
    await services.linkArticle({ topicId: "t1", article: "Ambient music" }, { createdVia: "web_ui" });

    // First run: nothing stored -> 90 days back (2026-07-03) through yesterday (2026-09-30).
    fetched.rows = [
      { date: "2026-09-30", views: 100 }, // in the last 30 days (2026-09-01 .. 2026-09-30)
      { date: "2026-09-01", views: 50 }, // in the last 30 days
      { date: "2026-08-31", views: 20 }, // previous 30 days (2026-08-02 .. 2026-08-31)
    ];
    await services.collectAll();
    assert.deepEqual(fetched.calls[0], { project: "en.wikipedia", article: "Ambient_music", startDate: "2026-07-03", endDate: "2026-09-30" });

    // Second run the same day: everything up to yesterday is stored -> no call.
    await services.collectAll();
    assert.equal(fetched.calls.length, 1);

    const [signal] = await services.listTopicSignals("t1");
    assert.equal(signal.last30DaysViews, 150);
    assert.equal(signal.previous30DaysViews, 20);
    assert.equal(signal.daily.length, 3);
    client.close();
  }));
