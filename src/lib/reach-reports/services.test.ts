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
  storedJob?: { jobId: string; jobCreatedAt: string | null; lastCheckedAt?: Date | null } | null;
  now?: Date;
  coverage?: { firstDate: string | null; lastDate: string | null; importedFiles: number };
  dailyRows?: ReachRow[];
  storedAttempt?: Awaited<ReturnType<ReachReportsDependencies["store"]["getAttempt"]>>;
  storedFiles?: Awaited<ReturnType<ReachReportsDependencies["store"]["listFiles"]>>;
  ensureJobError?: Error;
  importOutcomes?: Record<string, { outcome: "imported"; replacedReports: number } | { outcome: "superseded_by_newer" }>;
  /** BL-141: the stored channel connections, and each Google user's own active channel. */
  connections?: Array<{ channelId: string; connectedUserId: string | null }>;
  activeChannelByUser?: Record<string, string>;
  ensureJobErrorForUser?: Record<string, Error>;
} = {}) {
  const calls = {
    resolve: 0,
    ensureJob: 0,
    listReports: 0,
    downloaded: [] as string[],
    imports: [] as Array<{ reportId: string; rows: ReachRow[] }>,
    upsertJob: [] as unknown[],
    resolveArgs: [] as unknown[],
    attempts: [] as Array<Parameters<ReachReportsDependencies["store"]["recordAttempt"]>[0]>,
  };
  const activeChannelId = opts.activeChannelId === undefined ? "UC_X" : opts.activeChannelId;

  const deps: ReachReportsDependencies = {
    authResolver: {
      async resolve(args) {
        calls.resolve += 1;
        calls.resolveArgs.push(args);
        return { ...CREDS, credentialRef: args.credentialRef as typeof CREDS.credentialRef };
      },
    },
    reportingApi: {
      async ensureJob({ credentials }) {
        calls.ensureJob += 1;
        if (opts.ensureJobError) throw opts.ensureJobError;
        const userId = (credentials.credentialRef as { userId?: string }).userId ?? "";
        if (opts.ensureJobErrorForUser?.[userId]) throw opts.ensureJobErrorForUser[userId];
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
        return opts.storedJob ? { lastCheckedAt: null, ...opts.storedJob } : null;
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
      async recordAttempt(args) {
        calls.attempts.push(args);
      },
      async getAttempt() {
        return opts.storedAttempt ?? null;
      },
      async listFiles() {
        return opts.storedFiles ?? [];
      },
    },
    channelAccess: {
      async assertActiveChannel({ userId, channelId }: { userId: string | null | undefined; channelId: string }) {
        const active = opts.activeChannelByUser && userId ? (opts.activeChannelByUser[userId] ?? null) : activeChannelId;
        if (active !== channelId) {
          throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
        }
        return channelId;
      },
    } as never,
    listChannelConnections: async () => opts.connections ?? [],
    requiredScope: "https://www.googleapis.com/auth/yt-analytics.readonly",
    clock: { now: () => opts.now ?? new Date("2026-10-03T12:00:00Z") },
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
    skipped: false,
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

  assert.ok(!result.skipped);
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

  assert.ok(!result.skipped);
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

  assert.ok(!result.skipped);
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

// The automatic (dashboard-mount) trigger must not hammer Google: at most once per MIN_SYNC_INTERVAL_HOURS (6h).
test("syncReachReports with onlyIfDue: skipped without ANY call when the job was checked within 6 hours", async () => {
  const { services, calls } = createFixture({
    now: new Date("2026-10-03T12:00:00Z"),
    storedJob: { jobId: "j", jobCreatedAt: "2026-10-01T21:05:54Z", lastCheckedAt: new Date("2026-10-03T06:00:01Z") }, // 5h59m59s ago
  });

  const result = await services.syncReachReports({ ...SYNC, onlyIfDue: true });

  assert.deepEqual(result, { skipped: true, reason: "checked_recently", lastCheckedAt: "2026-10-03T06:00:01.000Z" });
  assert.equal(calls.resolve, 0);
  assert.equal(calls.ensureJob, 0);
  assert.equal(calls.listReports, 0);
});

test("syncReachReports with onlyIfDue: runs when the last check was exactly 6 hours ago, when never checked, and when no job is recorded", async () => {
  for (const storedJob of [
    { jobId: "j", jobCreatedAt: null, lastCheckedAt: new Date("2026-10-03T06:00:00Z") }, // exactly 6h
    { jobId: "j", jobCreatedAt: null, lastCheckedAt: null },
    null,
  ]) {
    const { services, calls } = createFixture({ now: new Date("2026-10-03T12:00:00Z"), storedJob });
    const result = await services.syncReachReports({ ...SYNC, onlyIfDue: true });
    assert.equal(result.skipped, false);
    assert.equal(calls.ensureJob, 1);
  }
});

test("a manual sync (no onlyIfDue) always runs, even right after a check", async () => {
  const { services, calls } = createFixture({
    now: new Date("2026-10-03T12:00:00Z"),
    storedJob: { jobId: "j", jobCreatedAt: null, lastCheckedAt: new Date("2026-10-03T11:59:00Z") },
  });
  const result = await services.syncReachReports(SYNC);
  assert.equal(result.skipped, false);
  assert.equal(calls.ensureJob, 1);
});

// ---- sync-attempt recording and status (BL-114 follow-up: the owner asked for the job/files status in Analytics) ----

test("syncReachReports records an 'ok' attempt with the counts, and a 'partial' one listing the failed files", async () => {
  const ok = createFixture({
    reports: [reportFile("a", "2026-10-03T03:00:00Z", "2026-10-01")],
    files: { a: csvFor("UC_X", ["20261001,{c},vidA,1,0.1"]) },
  });
  await ok.services.syncReachReports(SYNC);
  assert.deepEqual(ok.calls.attempts, [
    { channelId: "UC_X", reportTypeId: TYPE, outcome: "ok", error: null, filesListed: 1, filesImported: 1, failures: [] },
  ]);

  const partial = createFixture({
    reports: [reportFile("a", "2026-10-03T03:00:00Z", "2026-10-01"), reportFile("b", "2026-10-04T03:00:00Z", "2026-10-02")],
    files: { a: csvFor("UC_X", ["20261001,{c},vidA,1,0.1"]), b: new Error("HTTP 503") },
  });
  await partial.services.syncReachReports(SYNC);
  assert.equal(partial.calls.attempts.length, 1);
  assert.equal(partial.calls.attempts[0].outcome, "partial");
  assert.deepEqual(partial.calls.attempts[0].failures, [{ reportId: "b", error: "HTTP 503" }]);
  assert.equal(partial.calls.attempts[0].filesImported, 1);
});

test("syncReachReports: a failure before any file (e.g. API error) is recorded as 'failed' with the message AND still thrown", async () => {
  const { services, calls } = createFixture({ ensureJobError: new Error("Reporting API has not been used in project") });
  await assert.rejects(services.syncReachReports(SYNC), /Reporting API has not been used/);
  assert.deepEqual(calls.attempts, [
    { channelId: "UC_X", reportTypeId: TYPE, outcome: "failed", error: "Reporting API has not been used in project", filesListed: 0, filesImported: 0, failures: [] },
  ]);
});

test("syncReachReports: a wrong-channel call records nothing (the channel check fails closed before any attempt)", async () => {
  const { services, calls } = createFixture({ activeChannelId: "UC_OTHER" });
  await assert.rejects(services.syncReachReports(SYNC), (e: unknown) => e instanceof DomainError);
  assert.deepEqual(calls.attempts, []);
});

test("onlyIfDue: a recent FAILED attempt does not throttle (its cause is fixable); a recent partial/ok attempt does, until 6 hours have passed", async () => {
  const base = { error: null, filesListed: 1, filesImported: 1, failures: [] };
  const failed = createFixture({
    storedAttempt: { ...base, attemptedAt: new Date("2026-10-03T11:59:00Z"), outcome: "failed", error: "reads disabled" },
    now: new Date("2026-10-03T12:00:00Z"),
    reports: [],
  });
  const ranAfterFailure = await failed.services.syncReachReports({ ...SYNC, onlyIfDue: true });
  assert.ok(!ranAfterFailure.skipped, "a failed attempt one minute ago must not block the retry");
  assert.equal(failed.calls.ensureJob, 1);

  const okAttempt = { ...base, attemptedAt: new Date("2026-10-03T08:00:00Z"), outcome: "partial" as const };
  const recent = createFixture({ storedAttempt: okAttempt, now: new Date("2026-10-03T13:59:00Z") });
  assert.deepEqual(await recent.services.syncReachReports({ ...SYNC, onlyIfDue: true }), {
    skipped: true,
    reason: "checked_recently",
    lastCheckedAt: "2026-10-03T08:00:00.000Z",
  });
  assert.equal(recent.calls.ensureJob, 0);

  const due = createFixture({ storedAttempt: okAttempt, now: new Date("2026-10-03T14:00:00Z"), reports: [] });
  assert.ok(!(await due.services.syncReachReports({ ...SYNC, onlyIfDue: true })).skipped);
});

test("getReachStatus with no job: everything null/empty, never overdue", async () => {
  const { services } = createFixture();
  assert.deepEqual(await services.getReachStatus(SYNC), {
    channelId: "UC_X",
    job: null,
    firstFileExpectedBy: null,
    firstFileOverdue: false,
    lastAttempt: null,
    nextAutoCheckAt: null,
    importedFiles: 0,
    files: [],
  });
});

test("getReachStatus: job created 2026-10-01T21:05:54Z expects the first file by +48h (2026-10-03T21:05:54Z); not overdue before it, overdue after", async () => {
  const storedJob = { jobId: "job-1", jobCreatedAt: "2026-10-01T21:05:54Z", lastCheckedAt: null };
  const before = await createFixture({ storedJob, now: new Date("2026-10-03T21:05:54Z") }).services.getReachStatus(SYNC);
  assert.equal(before.firstFileExpectedBy, "2026-10-03T21:05:54.000Z");
  assert.equal(before.firstFileOverdue, false, "exactly at the deadline is not yet overdue");
  const after = await createFixture({ storedJob, now: new Date("2026-10-03T21:05:55Z") }).services.getReachStatus(SYNC);
  assert.equal(after.firstFileOverdue, true);
  assert.deepEqual(after.job, { jobId: "job-1", createdAt: "2026-10-01T21:05:54Z" });
});

test("getReachStatus: once a file is imported it is never 'overdue'; next auto check = last attempt + 6h; files and attempt are passed through", async () => {
  const { services } = createFixture({
    storedJob: { jobId: "job-1", jobCreatedAt: "2026-10-01T21:05:54Z", lastCheckedAt: new Date("2026-10-03T10:00:00Z") },
    storedAttempt: {
      attemptedAt: new Date("2026-10-03T12:00:00Z"),
      outcome: "partial",
      error: null,
      filesListed: 2,
      filesImported: 1,
      failures: [{ reportId: "b", error: "HTTP 503" }],
    },
    coverage: { firstDate: "2026-10-01", lastDate: "2026-10-01", importedFiles: 1 },
    storedFiles: [
      { reportId: "a", startTime: "2026-10-01T07:00:00Z", endTime: "2026-10-02T07:00:00Z", createTime: "2026-10-03T03:00:00Z", rowCount: 7, status: "imported", importedAt: new Date("2026-10-03T12:00:01Z") },
    ],
    now: new Date("2026-10-09T00:00:00Z"),
  });
  const status = await services.getReachStatus(SYNC);
  assert.equal(status.firstFileOverdue, false);
  assert.equal(status.nextAutoCheckAt, "2026-10-03T18:00:00.000Z");
  assert.equal(status.importedFiles, 1);
  assert.deepEqual(status.lastAttempt, {
    at: "2026-10-03T12:00:00.000Z",
    outcome: "partial",
    error: null,
    filesListed: 2,
    filesImported: 1,
    failures: [{ reportId: "b", error: "HTTP 503" }],
  });
  assert.deepEqual(status.files, [
    { reportId: "a", startTime: "2026-10-01T07:00:00Z", endTime: "2026-10-02T07:00:00Z", createTime: "2026-10-03T03:00:00Z", rowCount: 7, status: "imported", importedAt: "2026-10-03T12:00:01.000Z" },
  ]);
});

test("getReachStatus rejects a channel that is not the active one", async () => {
  const { services } = createFixture({ activeChannelId: "UC_OTHER" });
  await assert.rejects(services.getReachStatus(SYNC), (e: unknown) => e instanceof DomainError);
});

// Research/agent feedback (2026-10-04): per-video per-day CTR in one call.
test("getChannelReach with groupBy video_day returns the stored rows per video per day (videos in id order, days ascending), CTR as stored", async () => {
  const { services } = createFixture({
    storedJob: { jobId: "job-1", jobCreatedAt: "2026-09-20T00:00:00Z" },
    coverage: { firstDate: "2026-10-01", lastDate: "2026-10-03", importedFiles: 3 },
    dailyRows: [
      { date: "2026-10-02", videoId: "vidB", impressions: 40, ctr: 0.05 },
      { date: "2026-10-01", videoId: "vidB", impressions: 20, ctr: null },
      { date: "2026-10-03", videoId: "vidA", impressions: 100, ctr: 0.1 },
      { date: "2026-10-01", videoId: "vidA", impressions: 10, ctr: 0.2 },
    ],
  });
  const result = await services.getChannelReach({ ...SYNC, startDate: "2026-10-01", endDate: "2026-10-03", groupBy: "video_day" });
  assert.deepEqual(result.videoDaily, [
    { videoId: "vidA", date: "2026-10-01", impressions: 10, ctr: 0.2 },
    { videoId: "vidA", date: "2026-10-03", impressions: 100, ctr: 0.1 },
    { videoId: "vidB", date: "2026-10-01", impressions: 20, ctr: null },
    { videoId: "vidB", date: "2026-10-02", impressions: 40, ctr: 0.05 },
  ]);
  assert.equal(result.videoDailyTruncated, false);
  assert.equal(result.totals.impressions, 170); // 10 + 100 + 20 + 40, unchanged by groupBy
});

test("getChannelReach with a videoId filter scopes daily, videos and totals to that video and echoes the id", async () => {
  const { services } = createFixture({
    storedJob: { jobId: "job-1", jobCreatedAt: "2026-09-20T00:00:00Z" },
    coverage: { firstDate: "2026-10-01", lastDate: "2026-10-02", importedFiles: 2 },
    dailyRows: [
      { date: "2026-10-01", videoId: "vidA", impressions: 10, ctr: 0.2 },
      { date: "2026-10-02", videoId: "vidA", impressions: 30, ctr: 0.1 },
      { date: "2026-10-02", videoId: "vidB", impressions: 999, ctr: 0.5 },
    ],
  });
  const result = await services.getChannelReach({ ...SYNC, startDate: "2026-10-01", endDate: "2026-10-02", videoId: "vidA" });
  assert.equal(result.videoId, "vidA");
  assert.deepEqual(result.daily, [
    { date: "2026-10-01", impressions: 10, ctr: 0.2 },
    { date: "2026-10-02", impressions: 30, ctr: 0.1 },
  ]);
  assert.deepEqual(result.videos.map((v) => v.videoId), ["vidA"]);
  assert.equal(result.totals.impressions, 40);
  assert.equal(result.videoDaily, undefined, "no videoDaily unless groupBy is asked for");
});

test("getChannelReach groupBy video_day is capped at 5000 rows and says so; an unknown groupBy value is rejected", async () => {
  const many: ReachRow[] = Array.from({ length: 5001 }, (_, i) => ({ date: "2026-10-01", videoId: `v${String(i).padStart(5, "0")}`, impressions: 1, ctr: null }));
  const { services } = createFixture({
    storedJob: { jobId: "job-1", jobCreatedAt: "2026-09-20T00:00:00Z" },
    coverage: { firstDate: "2026-10-01", lastDate: "2026-10-01", importedFiles: 1 },
    dailyRows: many,
  });
  const result = await services.getChannelReach({ ...SYNC, startDate: "2026-10-01", endDate: "2026-10-01", groupBy: "video_day" });
  assert.equal(result.videoDaily?.length, 5000);
  assert.equal(result.videoDailyTruncated, true);
  await assert.rejects(() => services.getChannelReach({ ...SYNC, startDate: "2026-10-01", endDate: "2026-10-01", groupBy: "video" as never }), (e: unknown) => e instanceof DomainError);
});


// BL-141 (owner, Telegram 2026-10-06, msgs 1864/1865): on dashboard load, check the Reach reports of EVERY connected
// channel, not only the active one. Each channel is synced with its own Google user's token, through the same
// syncReachReports (and its active-channel check), and one channel failing never stops the others (AGENTS.md §M).
test("syncAllReachReports syncs every connected channel with that channel's own user, and reports each outcome", async () => {
  const { services, calls } = createFixture({
    connections: [
      { channelId: "UC_A", connectedUserId: "uA" },
      { channelId: "UC_B", connectedUserId: "uB" },
    ],
    activeChannelByUser: { uA: "UC_A", uB: "UC_B" },
  });
  const result = await services.syncAllReachReports({ onlyIfDue: false });
  assert.deepEqual(
    result.channels.map((c) => [c.channelId, c.outcome]),
    [
      ["UC_A", "synced"],
      ["UC_B", "synced"],
    ]
  );
  // Each channel's credentials were resolved for its own user, never the other's.
  assert.deepEqual(
    calls.resolveArgs.map((a) => (a as { credentialRef: { userId: string } }).credentialRef.userId),
    ["uA", "uB"]
  );
  assert.deepEqual(
    calls.upsertJob.map((j) => (j as { channelId: string }).channelId),
    ["UC_A", "UC_B"]
  );
});

test("syncAllReachReports skips a channel with no connected user and never calls Google for it", async () => {
  const { services, calls } = createFixture({
    connections: [
      { channelId: "UC_GONE", connectedUserId: null },
      { channelId: "UC_A", connectedUserId: "uA" },
    ],
    activeChannelByUser: { uA: "UC_A" },
  });
  const result = await services.syncAllReachReports({ onlyIfDue: false });
  assert.deepEqual(result.channels, [
    { channelId: "UC_GONE", outcome: "skipped", reason: "no_connected_user" },
    { channelId: "UC_A", outcome: "synced", filesImported: 0 },
  ]);
  assert.equal(calls.resolve, 1);
});

test("syncAllReachReports: a channel whose user now has another channel active fails closed; the rest still sync", async () => {
  const { services, calls } = createFixture({
    connections: [
      { channelId: "UC_A", connectedUserId: "uA" },
      { channelId: "UC_B", connectedUserId: "uB" },
    ],
    // uA switched to some other channel: uA's token is no longer UC_A's, so UC_A must not be synced with it.
    activeChannelByUser: { uA: "UC_OTHER", uB: "UC_B" },
  });
  const result = await services.syncAllReachReports({ onlyIfDue: false });
  assert.deepEqual(result.channels[0], { channelId: "UC_A", outcome: "failed", error: "CHANNEL_NOT_ACTIVE" });
  assert.deepEqual(result.channels[1], { channelId: "UC_B", outcome: "synced", filesImported: 0 });
  assert.deepEqual(calls.resolveArgs.map((a) => (a as { credentialRef: { userId: string } }).credentialRef.userId), ["uB"]);
});

test("syncAllReachReports: a Google error on one channel is recorded for it and does not stop the next", async () => {
  const { services, calls } = createFixture({
    connections: [
      { channelId: "UC_A", connectedUserId: "uA" },
      { channelId: "UC_B", connectedUserId: "uB" },
    ],
    activeChannelByUser: { uA: "UC_A", uB: "UC_B" },
    ensureJobErrorForUser: { uA: new Error("insufficient scope") },
  });
  const result = await services.syncAllReachReports({ onlyIfDue: false });
  assert.deepEqual(result.channels[0], { channelId: "UC_A", outcome: "failed", error: "insufficient scope" });
  assert.equal(result.channels[1].outcome, "synced");
  assert.deepEqual(
    calls.attempts.map((a) => [a.channelId, a.outcome]),
    [
      ["UC_A", "failed"],
      ["UC_B", "ok"],
    ]
  );
});

test("syncAllReachReports passes onlyIfDue through: a channel checked an hour ago is skipped without a Google call", async () => {
  const { services, calls } = createFixture({
    connections: [{ channelId: "UC_A", connectedUserId: "uA" }],
    activeChannelByUser: { uA: "UC_A" },
    storedJob: { jobId: "job-1", jobCreatedAt: null, lastCheckedAt: new Date("2026-10-03T11:00:00Z") },
    now: new Date("2026-10-03T12:00:00Z"),
  });
  const result = await services.syncAllReachReports({ onlyIfDue: true });
  assert.deepEqual(result.channels, [{ channelId: "UC_A", outcome: "skipped", reason: "checked_recently" }]);
  assert.equal(calls.resolve, 0);
});
