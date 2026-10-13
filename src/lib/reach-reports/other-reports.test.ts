import assert from "node:assert/strict";
import test from "node:test";
import { parseReportingCsv, type ReportingReport } from "@/lib/youtube-read-gateway";
import { DomainError } from "./contracts";
import { createReachReportsServices, firstFileLagOf, type OtherReportType, type ReachReportsDependencies } from "./services";

// BL-181 (FO-REQ-0020 §2.1 and §2.4; plan docs/roadmap/plans/REPORTING_BASIC_PLAN.md, stage 1; owner msg 2687: yes to the two new
// jobs per channel). Requirements tested here:
// - the basic and traffic-source reports are synced in the same call as Reach, each with its own job and its own attempt row;
// - one type failing never changes Reach's result or attempt, and Reach failing does not stop the others (AGENTS.md §M);
// - the status read gives each file's lag (createTime minus the end of its Pacific day) and the first file per day, leaving out
//   days that ended before the job existed (Google's 30-day history files are made right after the job is created).

const REACH = "channel_reach_basic_a1";
const BASIC = "channel_basic_a3";
const TRAFFIC = "channel_traffic_source_a3";
const SYNC = { credentialRef: { userId: "u1" }, channelId: "UC_X" };
const CREDS = { credentialRef: { userId: "u1" }, accessToken: "tok", scopeSet: new Set<string>() };

function file(id: string, jobId: string, day: string, createTime: string): ReportingReport {
  return {
    id,
    jobId,
    startTime: `${day}T07:00:00Z`,
    endTime: `${day.slice(0, 8)}${String(Number(day.slice(8)) + 1).padStart(2, "0")}T07:00:00Z`,
    createTime,
    downloadUrl: `https://youtubereporting.googleapis.com/v1/media/${id}`,
  };
}

function setup(opts: { failEnsureFor?: string[]; failResolve?: boolean; importFails?: string[]; checkedAt?: Record<string, string> } = {}) {
  const calls = {
    ensureJob: [] as Array<{ reportTypeId: string; name: string }>,
    attempts: [] as Array<{ reportTypeId: string; outcome: string; error: string | null; filesImported: number }>,
    reachImports: [] as string[],
    otherImports: [] as Array<{ reportTypeId: string; reportId: string }>,
  };
  const reportsByJob: Record<string, ReportingReport[]> = {
    [`job-${REACH}`]: [file("r1", `job-${REACH}`, "2026-10-10", "2026-10-11T05:00:00Z")],
    [`job-${BASIC}`]: [file("b1", `job-${BASIC}`, "2026-10-10", "2026-10-11T06:30:00Z")],
    [`job-${TRAFFIC}`]: [file("t1", `job-${TRAFFIC}`, "2026-10-10", "2026-10-11T07:00:00Z")],
  };
  const deps: ReachReportsDependencies = {
    authResolver: {
      async resolve() {
        if (opts.failResolve) throw new Error("Credentials are missing required OAuth scopes");
        return CREDS;
      },
    },
    reportingApi: {
      async ensureJob({ reportTypeId, name }) {
        calls.ensureJob.push({ reportTypeId, name });
        if (opts.failEnsureFor?.includes(reportTypeId)) throw new Error(`jobs.create refused for ${reportTypeId}`);
        return { job: { id: `job-${reportTypeId}`, reportTypeId, name, createTime: "2026-10-01T21:05:54Z", expireTime: null }, created: false };
      },
      async listReports({ jobId }) {
        return reportsByJob[jobId] ?? [];
      },
      async downloadAndParse() {
        return parseReportingCsv("date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20261010,UC_X,vidA,10,0.1\n");
      },
    },
    store: {
      async upsertJob() {},
      async getJob(_channelId, reportTypeId) {
        const checked = opts.checkedAt?.[reportTypeId];
        return { jobId: `job-${reportTypeId}`, jobCreatedAt: "2026-10-01T21:05:54Z", lastCheckedAt: checked ? new Date(checked) : null };
      },
      async listSeenReportIds() {
        return new Set<string>();
      },
      async importReport(args) {
        calls.reachImports.push(args.reportId);
        return { outcome: "imported", replacedReports: 0 };
      },
      async listDaily() {
        return [];
      },
      async getCoverage() {
        return { firstDate: null, lastDate: null, importedFiles: 1 };
      },
      async recordAttempt(args) {
        calls.attempts.push({ reportTypeId: args.reportTypeId, outcome: args.outcome, error: args.error, filesImported: args.filesImported });
      },
      async getAttempt() {
        return null;
      },
      async listFiles(_channelId, reportTypeId) {
        return reportTypeId === BASIC
          ? [
              // 2026-09-25 ended before the job existed (a history file): left out of firstFileLag.
              { reportId: "h", startTime: "2026-09-25T07:00:00Z", endTime: "2026-09-26T07:00:00Z", createTime: "2026-10-02T09:00:00Z", rowCount: 3, status: "imported", importedAt: new Date("2026-10-02T10:00:00Z") },
              { reportId: "b1", startTime: "2026-10-10T07:00:00Z", endTime: "2026-10-11T07:00:00Z", createTime: "2026-10-11T06:30:00Z", rowCount: 5, status: "imported", importedAt: new Date("2026-10-11T08:00:00Z") },
            ]
          : [];
      },
      async countImportedFiles(_channelId, reportTypeId) {
        return reportTypeId === BASIC ? 2 : 0;
      },
      listChannelConnections: async () => [],
    },
    channelAccess: {
      async assertActiveChannel({ channelId }: { channelId: string }) {
        if (channelId !== "UC_X") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
      },
      async getActiveChannelId() {
        return "UC_X";
      },
    } as unknown as ReachReportsDependencies["channelAccess"],
    requiredScope: "https://www.googleapis.com/auth/yt-analytics.readonly",
    clock: { now: () => new Date("2026-10-11T12:00:00Z") },
    otherReportTypes: [BASIC, TRAFFIC].map(
      (reportTypeId): OtherReportType => ({
        reportTypeId,
        jobName: `job name ${reportTypeId}`,
        async importFile({ meta }) {
          if (opts.importFails?.includes(meta.reportId)) throw new Error(`cannot import ${meta.reportId}`);
          calls.otherImports.push({ reportTypeId: meta.reportTypeId, reportId: meta.reportId });
          return { outcome: { outcome: "imported", replacedReports: 0 }, rowCount: 4 };
        },
      })
    ),
  };
  return { services: createReachReportsServices(deps), calls };
}

test("one sync call keeps Reach's result and also syncs the basic and traffic-source types, each with its own job and attempt", async () => {
  const { services, calls } = setup();
  const result = await services.syncReachReports(SYNC);
  assert.equal(result.skipped, false);
  if (result.skipped) return;
  assert.equal(result.filesImported, 1, "Reach's own counts are unchanged");
  assert.deepEqual(calls.reachImports, ["r1"]);
  assert.deepEqual(calls.ensureJob, [
    { reportTypeId: REACH, name: "YTOM reach basic" },
    { reportTypeId: BASIC, name: `job name ${BASIC}` },
    { reportTypeId: TRAFFIC, name: `job name ${TRAFFIC}` },
  ]);
  assert.deepEqual(calls.otherImports, [
    { reportTypeId: BASIC, reportId: "b1" },
    { reportTypeId: TRAFFIC, reportId: "t1" },
  ]);
  assert.deepEqual(
    result.otherReports?.map((r) => [r.reportTypeId, r.outcome, r.filesImported, r.rowsImported]),
    [
      [BASIC, "ok", 1, 4],
      [TRAFFIC, "ok", 1, 4],
    ]
  );
  assert.deepEqual(
    calls.attempts.map((a) => [a.reportTypeId, a.outcome]),
    [
      [REACH, "ok"],
      [BASIC, "ok"],
      [TRAFFIC, "ok"],
    ]
  );
});

test("a failing basic type is recorded as its own failure; Reach and the traffic-source type are unaffected", async () => {
  const { services, calls } = setup({ failEnsureFor: [BASIC] });
  const result = await services.syncReachReports(SYNC);
  if (result.skipped) throw new Error("unexpected skip");
  assert.equal(result.filesImported, 1);
  const basic = result.otherReports?.find((r) => r.reportTypeId === BASIC);
  assert.equal(basic?.outcome, "failed");
  assert.match(basic?.error ?? "", /jobs\.create refused/);
  assert.equal(result.otherReports?.find((r) => r.reportTypeId === TRAFFIC)?.outcome, "ok");
  assert.deepEqual(
    calls.attempts.map((a) => [a.reportTypeId, a.outcome]),
    [
      [REACH, "ok"],
      [BASIC, "failed"],
      [TRAFFIC, "ok"],
    ]
  );
});

test("a file that cannot be imported makes its type 'partial' and is retried later; the other files still import", async () => {
  const { services, calls } = setup({ importFails: ["t1"] });
  const result = await services.syncReachReports(SYNC);
  if (result.skipped) throw new Error("unexpected skip");
  const traffic = result.otherReports?.find((r) => r.reportTypeId === TRAFFIC);
  assert.equal(traffic?.outcome, "partial");
  assert.deepEqual(traffic?.failures, [{ reportId: "t1", error: "cannot import t1" }]);
  assert.deepEqual(calls.otherImports, [{ reportTypeId: BASIC, reportId: "b1" }]);
});

test("Reach failing still lets the other types sync, then the call fails with Reach's error and Reach's attempt says why", async () => {
  const { services, calls } = setup({ failEnsureFor: [REACH] });
  await assert.rejects(services.syncReachReports(SYNC), /jobs\.create refused for channel_reach_basic_a1/);
  assert.deepEqual(calls.otherImports, [
    { reportTypeId: BASIC, reportId: "b1" },
    { reportTypeId: TRAFFIC, reportId: "t1" },
  ]);
  assert.deepEqual(
    calls.attempts.map((a) => [a.reportTypeId, a.outcome]),
    [
      [BASIC, "ok"],
      [TRAFFIC, "ok"],
      [REACH, "failed"],
    ]
  );
});

test("credentials that cannot be resolved: every type records the failure, nothing is called", async () => {
  const { services, calls } = setup({ failResolve: true });
  await assert.rejects(services.syncReachReports(SYNC), /missing required OAuth scopes/);
  assert.equal(calls.ensureJob.length, 0);
  assert.deepEqual(
    calls.attempts.map((a) => [a.reportTypeId, a.outcome]),
    [
      [REACH, "failed"],
      [BASIC, "failed"],
      [TRAFFIC, "failed"],
    ]
  );
});

test("the status read lists each other type with its imported count, file lags and first file per day after the job existed", async () => {
  const { services } = setup();
  const status = await services.getReachStatus(SYNC);
  const basic = status.otherReports?.find((r) => r.reportTypeId === BASIC);
  assert.equal(basic?.importedFiles, 2);
  assert.deepEqual(basic?.job, { jobId: `job-${BASIC}`, createdAt: "2026-10-01T21:05:54Z" });
  // By hand: the history file ended 2026-09-26T07:00Z and was made 2026-10-02T09:00Z -> 146 h; b1: 06:30Z on 10-11 minus 07:00Z on
  // 10-11 -> -0.5 h (Google may create a day's file just before our reading of its end, it is reported as it is).
  assert.deepEqual(basic?.files.map((f) => [f.reportId, f.lagHours]), [
    ["h", 146],
    ["b1", -0.5],
  ]);
  assert.deepEqual(basic?.firstFileLag, [{ date: "2026-10-10", createTime: "2026-10-11T06:30:00Z", lagHours: -0.5 }]);
  assert.deepEqual(status.otherReports?.find((r) => r.reportTypeId === TRAFFIC)?.firstFileLag, []);
});

test("firstFileLagOf: the earliest file per day counts (a reissue never), newest day first; a winter day ends at 08:00Z", () => {
  const lag = firstFileLagOf(
    [
      { startTime: "2026-10-10T07:00:00Z", endTime: "2026-10-11T07:00:00Z", createTime: "2026-10-12T05:00:00Z" },
      // The reissue of 10-10 four days later: not the first file of that day.
      { startTime: "2026-10-10T07:00:00Z", endTime: "2026-10-11T07:00:00Z", createTime: "2026-10-15T01:00:00Z" },
      { startTime: "2026-10-11T07:00:00Z", endTime: "2026-10-12T07:00:00Z", createTime: "2026-10-13T04:15:00Z" },
      // Pacific Standard Time: the day 2026-11-10 ends 2026-11-11T08:00Z; created 2026-11-12T06:00Z -> 22 h.
      { startTime: "2026-11-10T08:00:00Z", endTime: "2026-11-11T08:00:00Z", createTime: "2026-11-12T06:00:00Z" },
    ],
    "2026-10-01T21:05:54Z"
  );
  assert.deepEqual(lag, [
    { date: "2026-11-10", createTime: "2026-11-12T06:00:00Z", lagHours: 22 },
    { date: "2026-10-11", createTime: "2026-10-13T04:15:00Z", lagHours: 21.3 },
    { date: "2026-10-10", createTime: "2026-10-12T05:00:00Z", lagHours: 22 },
  ]);
});

test("firstFileLagOf: without a known job creation time nothing is reported (history and fresh days cannot be told apart)", () => {
  assert.deepEqual(firstFileLagOf([{ startTime: "2026-10-10T07:00:00Z", endTime: "2026-10-11T07:00:00Z", createTime: "2026-10-12T05:00:00Z" }], null), []);
});

// Review finding 2 of the BL-181 independent review: Reach's last check is shared with the other computer (BL-151), the other types'
// are this computer's own. The automatic sync (`onlyIfDue`, at most every 6 hours per type) must therefore not let the other
// computer's Reach check hold back this computer's own basic and traffic-source downloads. The clock is 2026-10-11T12:00Z.
test("automatic sync: Reach checked 1 h ago (by the other computer) is skipped, the other types still sync by their own checks", async () => {
  const { services, calls } = setup({ checkedAt: { [REACH]: "2026-10-11T11:00:00Z" } });
  const result = await services.syncReachReports({ ...SYNC, onlyIfDue: true });
  assert.equal(result.skipped, true);
  if (!result.skipped || result.reason !== "checked_recently") throw new Error("expected checked_recently");
  assert.equal(result.lastCheckedAt, "2026-10-11T11:00:00.000Z");
  assert.deepEqual(result.otherReports?.map((r) => [r.reportTypeId, r.outcome]), [
    [BASIC, "ok"],
    [TRAFFIC, "ok"],
  ]);
  assert.deepEqual(calls.ensureJob.map((c) => c.reportTypeId), [BASIC, TRAFFIC], "no Reach call");
  assert.deepEqual(calls.attempts.map((a) => a.reportTypeId), [BASIC, TRAFFIC], "Reach's attempt row is untouched");
});

test("automatic sync: a type checked within 6 hours waits; when every type was, nothing is called at all", async () => {
  const one = setup({ checkedAt: { [BASIC]: "2026-10-11T07:00:00Z" } });
  const result = await one.services.syncReachReports({ ...SYNC, onlyIfDue: true });
  if (result.skipped) throw new Error("Reach was due");
  assert.deepEqual(one.calls.ensureJob.map((c) => c.reportTypeId), [REACH, TRAFFIC]);
  assert.deepEqual(result.otherReports?.map((r) => r.reportTypeId), [TRAFFIC]);

  const all = setup({ checkedAt: { [REACH]: "2026-10-11T07:00:00Z", [BASIC]: "2026-10-11T08:00:00Z", [TRAFFIC]: "2026-10-11T09:00:00Z" } });
  assert.deepEqual(await all.services.syncReachReports({ ...SYNC, onlyIfDue: true }), {
    skipped: true,
    reason: "checked_recently",
    lastCheckedAt: "2026-10-11T07:00:00.000Z",
  });
  assert.equal(all.calls.ensureJob.length, 0);
});
