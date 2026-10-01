import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient, type Client } from "@libsql/client";
import {
  createIsolatedDb,
  getChannelReachCoverage,
  getReportingJob,
  importReachReport,
  initializeDatabaseSchema,
  listChannelReachDaily,
  listSeenReportingReportIds,
  upsertReportingJob,
  type ReachReportImport,
} from "@/lib/db";

async function withDb(fn: (db: ReturnType<typeof createIsolatedDb>, client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reach-store-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(createIsolatedDb(client), client);
  } finally {
    client.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

const TYPE = "channel_reach_basic_a1";

function report(overrides: Partial<ReachReportImport> & Pick<ReachReportImport, "reportId" | "createTime" | "rows">): ReachReportImport {
  return {
    channelId: "UC_X",
    reportTypeId: TYPE,
    jobId: "job-1",
    startTime: "2026-09-30T07:00:00Z",
    endTime: "2026-10-01T07:00:00Z",
    ...overrides,
  };
}

const RANGE = { startDate: "2026-01-01", endDate: "2026-12-31" };

test("migration creates the three BL-114 tables", () =>
  withDb(async (_db, client) => {
    for (const name of ["reporting_jobs", "reporting_report_files", "channel_reach_daily"]) {
      const result = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [name] });
      assert.equal(result.rows.length, 1, name);
    }
  }));

test("importReachReport stores rows and the ledger entry; coverage reflects them", () =>
  withDb(async (db) => {
    const result = await importReachReport(
      report({
        reportId: "r1",
        createTime: "2026-10-02T03:00:00Z",
        rows: [
          { date: "2026-09-30", videoId: "A", impressions: 1000, ctr: 0.05 },
          { date: "2026-09-30", videoId: "B", impressions: 0, ctr: null },
        ],
      }),
      db
    );

    assert.deepEqual(result, { outcome: "imported", replacedReports: 0 });
    assert.deepEqual(await listChannelReachDaily("UC_X", RANGE, db), [
      { channelId: "UC_X", date: "2026-09-30", videoId: "A", impressions: 1000, ctr: 0.05 },
      { channelId: "UC_X", date: "2026-09-30", videoId: "B", impressions: 0, ctr: null },
    ]);
    assert.deepEqual(await getChannelReachCoverage("UC_X", db), { firstDate: "2026-09-30", lastDate: "2026-09-30", importedFiles: 1 });
    assert.deepEqual([...(await listSeenReportingReportIds("UC_X", TYPE, db))], ["r1"]);
  }));

// Replacement, not addition: Google regenerates a period's file with a later createTime.
test("a newer file for the SAME period replaces the older file's rows, including a video it no longer lists", () =>
  withDb(async (db) => {
    await importReachReport(
      report({
        reportId: "old",
        createTime: "2026-10-02T03:00:00Z",
        rows: [
          { date: "2026-09-30", videoId: "A", impressions: 100, ctr: 0.1 },
          { date: "2026-09-30", videoId: "GONE", impressions: 50, ctr: 0.2 },
        ],
      }),
      db
    );

    const result = await importReachReport(
      report({
        reportId: "new",
        createTime: "2026-10-03T03:00:00Z",
        rows: [{ date: "2026-09-30", videoId: "A", impressions: 120, ctr: 0.11 }],
      }),
      db
    );

    assert.deepEqual(result, { outcome: "imported", replacedReports: 1 });
    assert.deepEqual(await listChannelReachDaily("UC_X", RANGE, db), [
      { channelId: "UC_X", date: "2026-09-30", videoId: "A", impressions: 120, ctr: 0.11 },
    ]);
    // Only the newer file counts as imported; the old one is kept in the ledger as superseded, so it is not downloaded again.
    assert.equal((await getChannelReachCoverage("UC_X", db)).importedFiles, 1);
    assert.deepEqual([...(await listSeenReportingReportIds("UC_X", TYPE, db))].sort(), ["new", "old"]);
  }));

test("an OLDER file arriving after a newer one for the same period leaves the data untouched", () =>
  withDb(async (db) => {
    await importReachReport(
      report({ reportId: "new", createTime: "2026-10-03T03:00:00Z", rows: [{ date: "2026-09-30", videoId: "A", impressions: 120, ctr: 0.11 }] }),
      db
    );

    const result = await importReachReport(
      report({ reportId: "stale", createTime: "2026-10-02T03:00:00Z", rows: [{ date: "2026-09-30", videoId: "A", impressions: 1, ctr: 0.9 }] }),
      db
    );

    assert.deepEqual(result, { outcome: "superseded_by_newer" });
    assert.deepEqual(await listChannelReachDaily("UC_X", RANGE, db), [
      { channelId: "UC_X", date: "2026-09-30", videoId: "A", impressions: 120, ctr: 0.11 },
    ]);
    assert.ok((await listSeenReportingReportIds("UC_X", TYPE, db)).has("stale"), "recorded, so it is not re-downloaded");
  }));

test("different periods accumulate; the same period for another channel is independent", () =>
  withDb(async (db) => {
    await importReachReport(report({ reportId: "d1", createTime: "2026-10-02T03:00:00Z", rows: [{ date: "2026-09-30", videoId: "A", impressions: 10, ctr: 0.1 }] }), db);
    await importReachReport(
      report({
        reportId: "d2",
        createTime: "2026-10-03T03:00:00Z",
        startTime: "2026-10-01T07:00:00Z",
        endTime: "2026-10-02T07:00:00Z",
        rows: [{ date: "2026-10-01", videoId: "A", impressions: 20, ctr: 0.2 }],
      }),
      db
    );
    await importReachReport(
      report({ reportId: "other", channelId: "UC_Y", createTime: "2026-10-02T03:00:00Z", rows: [{ date: "2026-09-30", videoId: "Z", impressions: 5, ctr: 0.5 }] }),
      db
    );

    assert.deepEqual((await listChannelReachDaily("UC_X", RANGE, db)).map((r) => [r.date, r.impressions]), [
      ["2026-09-30", 10],
      ["2026-10-01", 20],
    ]);
    assert.deepEqual((await listChannelReachDaily("UC_Y", RANGE, db)).map((r) => r.videoId), ["Z"]);
    assert.equal((await getChannelReachCoverage("UC_X", db)).importedFiles, 2);
  }));

test("listChannelReachDaily is inclusive on both ends of the date range", () =>
  withDb(async (db) => {
    await importReachReport(
      report({
        reportId: "r",
        createTime: "2026-10-02T03:00:00Z",
        rows: ["2026-09-29", "2026-09-30", "2026-10-01"].map((date) => ({ date, videoId: "A", impressions: 1, ctr: 0.1 })),
      }),
      db
    );
    const rows = await listChannelReachDaily("UC_X", { startDate: "2026-09-30", endDate: "2026-10-01" }, db);
    assert.deepEqual(rows.map((r) => r.date), ["2026-09-30", "2026-10-01"]);
  }));

test("a failed import rolls back completely (no partial rows, no ledger entry)", () =>
  withDb(async (db) => {
    await assert.rejects(() =>
      importReachReport(
        report({
          reportId: "bad",
          createTime: "2026-10-02T03:00:00Z",
          // impressions NOT NULL: the second row violates it after the first was written.
          rows: [
            { date: "2026-09-30", videoId: "A", impressions: 1, ctr: 0.1 },
            { date: "2026-09-30", videoId: "B", impressions: null as unknown as number, ctr: 0.1 },
          ],
        }),
        db
      )
    );
    assert.deepEqual(await listChannelReachDaily("UC_X", RANGE, db), []);
    assert.equal((await listSeenReportingReportIds("UC_X", TYPE, db)).size, 0);
  }));

test("upsertReportingJob / getReportingJob round-trip and update in place", () =>
  withDb(async (db) => {
    assert.equal(await getReportingJob("UC_X", TYPE, db), null);
    await upsertReportingJob({ channelId: "UC_X", reportTypeId: TYPE, jobId: "j1", jobName: "n", jobCreatedAt: "2026-10-01T21:05:54Z" }, db);
    await upsertReportingJob({ channelId: "UC_X", reportTypeId: TYPE, jobId: "j2", jobName: "n2", jobCreatedAt: "2026-10-02T00:00:00Z" }, db);
    const job = await getReportingJob("UC_X", TYPE, db);
    assert.equal(job?.jobId, "j2");
    assert.equal(job?.jobCreatedAt, "2026-10-02T00:00:00Z");
  }));
