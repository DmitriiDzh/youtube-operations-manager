import assert from "node:assert/strict";
import test from "node:test";
import { parseReportingCsv, type ReportingJob, type ReportingReport } from "@/lib/youtube-read-gateway";
import { DomainError, type ReachRow } from "./contracts";
import { createReachReportsServices, type ReachReportsDependencies } from "./services";

const TYPE = "channel_reach_basic_a1";
const HEADER = "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr";
const CREDS = { credentialRef: { userId: "u1" }, accessToken: "tok", scopeSet: new Set<string>() };

function reportFile(id: string, createTime: string, day: string): ReportingReport {
  return {
    id,
    jobId: "job-1",
    startTime: `${day}T07:00:00Z`,
    endTime: `${day}T07:00:00Z`,
    createTime,
    downloadUrl: `https://youtubereporting.googleapis.com/v1/media/${id}`,
  };
}

function csvFor(channelId: string, rows: string[]) {
  return parseReportingCsv(`${HEADER}\n${rows.map((r) => r.replace("{c}", channelId)).join("\n")}\n`);
}

type Fixture = ReturnType<typeof createFixture>;

function createFixture(opts: {
  activeChannelId?: string | null;
  existingJob?: ReportingJob;
  reports?: ReportingReport[];
  files?: Record<string, ReturnType<typeof parseReportingCsv> | Error>;
  seen?: string[];
  storedJob?: { jobId: string; jobCreatedAt: string | null } | null;
  coverage?: { firstDate: string | null; lastDate: string | null; importedFiles: number };
  dailyRows?: ReachRow[];
  importOutcomes?: Record<string, { outcome: "imported"; replacedReports: number } | { outcome: "superseded_by_newer" }>;
} = {}) {
  const calls = {
    resolve: 0,
    ensureJob: 0,
    listReports: 0,
    downloaded: [] as string[],
    imports: [] as Array<{ reportId: string; rows: ReachRow[] }>,
    upsertJob: [] as unknown[],
    resolveArgs: [] as unknown[],
  };
  const activeChannelId = opts.activeChannelId === undefined ? "UC_X" : opts.activeChannelId;

  const deps: ReachReportsDependencies = {
    authResolver: {
      async resolve(args) {
        calls.resolve += 1;
        calls.resolveArgs.push(args);
        return CREDS;
      },
    },
    reportingApi: {
      async ensureJob() {
        calls.ensureJob += 1;
        const job = opts.existingJob ?? { id: "job-1", reportTypeId: TYPE, name: "YTOM reach basic", createTime: "2026-10-01T21:05:54Z", expireTime: null };
        return { job, created: !opts.existingJob };
      },
      async listReports() {
        calls.listReports += 1;
        return opts.reports ?? [];
      },
      async downloadAndParse({ downloadUrl }) {
        calls.downloaded.push(downloadUrl);
        const id = downloadUrl.split("/").pop() as string;
        const file = opts.files?.[id];
        if (!file) throw new Error(`no fake file for ${id}`);
        if (file instanceof Error) throw file;
        return file;
      },
    },
    store: {
      async upsertJob(args) {
        calls.upsertJob.push(args);
      },
      async getJob() {
        return opts.storedJob ?? null;
      },
      async listSeenReportIds() {
        return new Set(opts.seen ?? []);
      },
      async importReport(args) {
        calls.imports.push({ reportId: args.reportId, rows: args.rows });
        return opts.importOutcomes?.[args.reportId] ?? { outcome: "imported", replacedReports: 0 };
      },
      async listDaily() {
        return opts.dailyRows ?? [];
      },
      async getCoverage() {
        return opts.coverage ?? { firstDate: null, lastDate: null, importedFiles: 0 };
      },
    },
    channelAccess: {
      async assertActiveChannel({ channelId }: { userId: string | null | undefined; channelId: string }) {
        if (activeChannelId !== channelId) {
          throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
        }
        return channelId;
      },
    } as never,
    requiredScope: "https://www.googleapis.com/auth/yt-analytics.readonly",
  };
  return { services: createReachReportsServices(deps), calls };
}

const SYNC = { credentialRef: { userId: "u1" }, channelId: "UC_X" };

test("syncReachReports creates the job when none exists, records it, requests the analytics scope, and imports files oldest-first", async () => {
  const { services, calls }: Fixture = createFixture({
    reports: [
      reportFile("new", "2026-10-04T03:00:00Z", "2026-10-02"),
      reportFile("old", "2026-10-03T03:00:00Z", "2026-10-01"),
    ],
    files: {
      old: csvFor("UC_X", ["20261001,{c},vidA,100,0.1"]),
      new: csvFor("UC_X", ["20261002,{c},vidA,200,0.2", "20261002,{c},vidB,50,"]),
    },
  });

  const result = await services.syncReachReports(SYNC);

  assert.deepEqual(result, {
    jobId: "job-1",
    jobCreated: true,
    filesListed: 2,
    filesImported: 2,
    filesSuperseded: 0,
    rowsImported: 3,
    failures: [],
  });
  assert.deepEqual(calls.imports.map((i) => i.reportId), ["old", "new"], "older generation applied first");
  assert.deepEqual(calls.imports[1].rows, [
    { date: "2026-10-02", videoId: "vidA", impressions: 200, ctr: 0.2 },
    { date: "2026-10-02", videoId: "vidB", impressions: 50, ctr: null },
  ]);
  assert.equal(calls.upsertJob.length, 1);
  assert.deepEqual((calls.resolveArgs[0] as { requiredScopes: string[] }).requiredScopes, [
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ]);
});

test("syncReachReports reports an existing job as not created, and skips files already seen (no download)", async () => {
  const { services, calls } = createFixture({
    existingJob: { id: "job-1", reportTypeId: TYPE, name: "n", createTime: "2026-10-01T21:05:54Z", expireTime: null },
    reports: [reportFile("seen1", "2026-10-03T03:00:00Z", "2026-10-01"), reportFile("fresh", "2026-10-04T03:00:00Z", "2026-10-02")],
    seen: ["seen1"],
    files: { fresh: csvFor("UC_X", ["20261002,{c},vidA,5,0.1"]) },
  });

  const result = await services.syncReachReports(SYNC);

  assert.equal(result.jobCreated, false);
  assert.equal(result.filesListed, 2);
  assert.equal(result.filesImported, 1);
  assert.deepEqual(calls.downloaded, ["https://youtubereporting.googleapis.com/v1/media/fresh"]);
});

test("syncReachReports: one bad file is reported in failures and does not stop the others; it is not imported", async () => {
  const { services, calls } = createFixture({
    reports: [
      reportFile("good1", "2026-10-03T03:00:00Z", "2026-10-01"),
      reportFile("broken", "2026-10-04T03:00:00Z", "2026-10-02"),
      reportFile("wrongchan", "2026-10-05T03:00:00Z", "2026-10-03"),
      reportFile("good2", "2026-10-06T03:00:00Z", "2026-10-04"),
    ],
    files: {
      good1: csvFor("UC_X", ["20261001,{c},vidA,1,0.1"]),
      broken: new Error("download failed"),
      wrongchan: csvFor("UC_OTHER", ["20261003,{c},vidA,1,0.1"]),
      good2: csvFor("UC_X", ["20261004,{c},vidA,1,0.1"]),
    },
  });

  const result = await services.syncReachReports(SYNC);

  assert.equal(result.filesImported, 2);
  assert.deepEqual(result.failures.map((f) => f.reportId).sort(), ["broken", "wrongchan"]);
  assert.deepEqual(calls.imports.map((i) => i.reportId), ["good1", "good2"], "a failed/foreign-channel file is never imported");
});

test("syncReachReports counts a file the store reports as superseded separately, and does not count its rows as imported", async () => {
  const { services } = createFixture({
    reports: [reportFile("r1", "2026-10-03T03:00:00Z", "2026-10-01"), reportFile("r2", "2026-10-04T03:00:00Z", "2026-10-02")],
    files: {
      r1: csvFor("UC_X", ["20261001,{c},vidA,1,0.1"]),
      r2: csvFor("UC_X", ["20261002,{c},vidA,7,0.1", "20261002,{c},vidB,8,0.1"]),
    },
    importOutcomes: { r1: { outcome: "superseded_by_newer" } },
  });

  const result = await services.syncReachReports(SYNC);

  assert.equal(result.filesSuperseded, 1);
  assert.equal(result.filesImported, 1);
  assert.equal(result.rowsImported, 2, "only the imported file's rows");
});

// Channel identity: fail closed BEFORE any credential use or network call.
test("syncReachReports/getChannelReach for a channel that is not the active one fail closed with no credential or API use", async () => {
  const { services, calls } = createFixture({ activeChannelId: "UC_OTHER" });

  await assert.rejects(
    () => services.syncReachReports(SYNC),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
  await assert.rejects(
    () => services.getChannelReach({ ...SYNC, startDate: "2026-10-01", endDate: "2026-10-02" }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
  assert.equal(calls.resolve, 0);
  assert.equal(calls.ensureJob, 0);
  assert.equal(calls.listReports, 0);
});

test("a credentialRef without a userId (raw tokens) never reaches the credential resolver", async () => {
  const { services, calls } = createFixture({ activeChannelId: null });
  await assert.rejects(() => services.syncReachReports({ credentialRef: { accessToken: "raw" }, channelId: "UC_X" }));
  assert.equal(calls.resolve, 0);
});

test("input validation rejects unknown fields and bad date ranges", async () => {
  const { services } = createFixture();
  const isValidation = (error: unknown) => error instanceof DomainError && error.code === "validation_failed";
  await assert.rejects(() => services.syncReachReports({ ...SYNC, extra: 1 }), isValidation);
  await assert.rejects(() => services.getChannelReach({ ...SYNC, startDate: "2026-10-05", endDate: "2026-10-01" }), isValidation);
  await assert.rejects(() => services.getChannelReach({ ...SYNC, startDate: "2026-10-01", endDate: "bad" }), isValidation);
  await assert.rejects(() => services.getChannelReach({ ...SYNC, startDate: "2024-01-01", endDate: "2026-10-01" }), isValidation, "over 400 days");
});

// "No data" is never "zero": state says which of the three situations an empty result is.
test("getChannelReach state: no job -> no_job; job but nothing imported -> waiting_for_first_report; imported -> ready", async () => {
  const range = { ...SYNC, startDate: "2026-10-01", endDate: "2026-10-02" };

  const none = await createFixture({ storedJob: null }).services.getChannelReach(range);
  assert.equal(none.state, "no_job");
  assert.equal(none.jobCreatedAt, null);

  const waiting = await createFixture({ storedJob: { jobId: "j", jobCreatedAt: "2026-10-01T21:05:54Z" } }).services.getChannelReach(range);
  assert.equal(waiting.state, "waiting_for_first_report");
  assert.equal(waiting.jobCreatedAt, "2026-10-01T21:05:54Z");
  assert.deepEqual(waiting.daily, [], "no days are invented while waiting");
  assert.deepEqual(waiting.videos, []);

  const ready = await createFixture({
    storedJob: { jobId: "j", jobCreatedAt: "2026-10-01T21:05:54Z" },
    coverage: { firstDate: "2026-10-01", lastDate: "2026-10-01", importedFiles: 1 },
    dailyRows: [
      { date: "2026-10-01", videoId: "A", impressions: 1000, ctr: 0.05 },
      { date: "2026-10-01", videoId: "B", impressions: 3000, ctr: 0.01 },
    ],
  }).services.getChannelReach(range);
  assert.equal(ready.state, "ready");
  assert.equal(ready.totals.impressions, 4000);
  assert.ok(Math.abs(ready.totals.ctr! - 0.02) < 1e-12, "impressions-weighted, not the mean 0.03");
  assert.deepEqual(ready.coverage, { firstDate: "2026-10-01", lastDate: "2026-10-01", importedFiles: 1 });
});
