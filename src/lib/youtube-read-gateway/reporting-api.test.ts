import assert from "node:assert/strict";
import test from "node:test";
import { getReportingReadsEnabled, setReportingReadsEnabled } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import {
  assertReportingReadsAuthorized,
  assertTrustedReportDownloadUrl,
  createYoutubeReportingClient,
  downloadReportCsv,
  ensureReportingJob,
  listJobReports,
  listReportingJobs,
  listReportingReportTypes,
  parseReportingCsv,
  type ReportingClient,
} from "./reporting-api";

// Expected values below come from Google's published Reach report definition
// (https://developers.google.com/youtube/reporting/v1/reports/channel_reports): report type
// `channel_reach_basic_a1`, columns date/channel_id/video_id/video_thumbnail_impressions/
// video_thumbnail_impressions_ctr -- not from reading the parser.

test("Reporting reads toggle: default-enabled, throws reporting_reads_disabled when turned off", async () => {
  assert.equal(await getReportingReadsEnabled(), true, "defaults to enabled, never reset on boot");
  await assertReportingReadsAuthorized();

  await setReportingReadsEnabled(false);
  try {
    await assert.rejects(
      () => assertReportingReadsAuthorized(),
      (error: unknown) => error instanceof DomainError && error.code === "reporting_reads_disabled"
    );
    // The client constructor is the single choke point: a caller cannot get a client while off.
    await assert.rejects(
      () => createYoutubeReportingClient({ request: async () => ({ data: "" }) } as never),
      (error: unknown) => error instanceof DomainError && error.code === "reporting_reads_disabled"
    );
  } finally {
    await setReportingReadsEnabled(true);
  }
});

type Calls = { jobsCreate: unknown[]; jobsList: unknown[]; reportsList: unknown[]; typesList: unknown[]; download: string[] };

function fakeClient(opts: {
  jobPages?: Array<{ jobs?: unknown[]; nextPageToken?: string }>;
  reportPages?: Array<{ reports?: unknown[]; nextPageToken?: string }>;
  typePages?: Array<{ reportTypes?: unknown[]; nextPageToken?: string }>;
  createResult?: unknown;
  downloadBody?: unknown;
}): { client: ReportingClient; calls: Calls } {
  const calls: Calls = { jobsCreate: [], jobsList: [], reportsList: [], typesList: [], download: [] };
  const jobPages = [...(opts.jobPages ?? [{ jobs: [] }])];
  const reportPages = [...(opts.reportPages ?? [{ reports: [] }])];
  const typePages = [...(opts.typePages ?? [{ reportTypes: [] }])];
  const api = {
    reportTypes: {
      list: async (params: unknown) => {
        calls.typesList.push(params);
        return { data: typePages.shift() ?? {} };
      },
    },
    jobs: {
      list: async (params: unknown) => {
        calls.jobsList.push(params);
        return { data: jobPages.shift() ?? {} };
      },
      create: async (params: unknown) => {
        calls.jobsCreate.push(params);
        return { data: opts.createResult ?? {} };
      },
      reports: {
        list: async (params: unknown) => {
          calls.reportsList.push(params);
          return { data: reportPages.shift() ?? {} };
        },
      },
    },
  };
  const auth = {
    request: async (options: { url: string }) => {
      calls.download.push(options.url);
      return { data: opts.downloadBody ?? "" };
    },
  };
  return { client: { api, auth } as unknown as ReportingClient, calls };
}

test("ensureReportingJob reuses an existing job for the report type and never calls jobs.create", async () => {
  const { client, calls } = fakeClient({
    jobPages: [
      {
        jobs: [
          { id: "other", reportTypeId: "channel_basic_a3", name: "x" },
          { id: "job-1", reportTypeId: "channel_reach_basic_a1", name: "YTOM reach", createTime: "2026-10-01T00:00:00Z" },
        ],
      },
    ],
  });

  const result = await ensureReportingJob(client, { reportTypeId: "channel_reach_basic_a1", name: "YTOM reach" });

  assert.equal(result.created, false);
  assert.equal(result.job.id, "job-1");
  assert.equal(calls.jobsCreate.length, 0);
});

test("ensureReportingJob creates exactly one job, with the requested report type and name, when none exists", async () => {
  const { client, calls } = fakeClient({
    jobPages: [{ jobs: [{ id: "other", reportTypeId: "channel_basic_a3" }] }],
    createResult: { id: "job-new", reportTypeId: "channel_reach_basic_a1", name: "YTOM reach", createTime: "2026-10-01T10:00:00Z" },
  });

  const result = await ensureReportingJob(client, { reportTypeId: "channel_reach_basic_a1", name: "YTOM reach" });

  assert.equal(result.created, true);
  assert.equal(result.job.id, "job-new");
  assert.deepEqual(calls.jobsCreate, [{ requestBody: { reportTypeId: "channel_reach_basic_a1", name: "YTOM reach" } }]);
});

test("ensureReportingJob finds a matching job on a later page of jobs.list (no duplicate creation)", async () => {
  const { client, calls } = fakeClient({
    jobPages: [
      { jobs: [{ id: "a", reportTypeId: "channel_basic_a3" }], nextPageToken: "p2" },
      { jobs: [{ id: "job-2", reportTypeId: "channel_reach_basic_a1" }] },
    ],
  });

  const result = await ensureReportingJob(client, { reportTypeId: "channel_reach_basic_a1", name: "n" });

  assert.equal(result.job.id, "job-2");
  assert.equal(calls.jobsCreate.length, 0);
  assert.equal((calls.jobsList[1] as { pageToken?: string }).pageToken, "p2");
});

test("ensureReportingJob fails loudly if jobs.create returns no job id", async () => {
  const { client } = fakeClient({ createResult: {} });
  await assert.rejects(
    () => ensureReportingJob(client, { reportTypeId: "channel_reach_basic_a1", name: "n" }),
    (error: unknown) => error instanceof DomainError && error.code === "reporting_report_malformed"
  );
});

test("listReportingJobs skips entries lacking id or reportTypeId, and listReportingReportTypes paginates", async () => {
  const { client } = fakeClient({
    jobPages: [{ jobs: [{ id: "ok", reportTypeId: "t" }, { reportTypeId: "no-id" }, { id: "no-type" }] }],
    typePages: [
      { reportTypes: [{ id: "channel_reach_basic_a1", name: "Reach" }], nextPageToken: "n" },
      { reportTypes: [{ id: "channel_reach_combined_a1" }] },
    ],
  });

  assert.deepEqual((await listReportingJobs(client)).map((j) => j.id), ["ok"]);
  assert.deepEqual(await listReportingReportTypes(client), [
    { id: "channel_reach_basic_a1", name: "Reach" },
    { id: "channel_reach_combined_a1", name: "channel_reach_combined_a1" },
  ]);
});

test("listJobReports passes jobId/createdAfter, paginates, and drops reports missing required fields", async () => {
  const good = {
    id: "r1",
    startTime: "2026-09-30T07:00:00Z",
    endTime: "2026-10-01T07:00:00Z",
    createTime: "2026-10-02T03:00:00Z",
    downloadUrl: "https://youtubereporting.googleapis.com/v1/media/x",
  };
  const { client, calls } = fakeClient({
    reportPages: [
      { reports: [good, { ...good, id: "no-url", downloadUrl: undefined }], nextPageToken: "p2" },
      { reports: [{ ...good, id: "r2" }] },
    ],
  });

  const reports = await listJobReports(client, { jobId: "job-1", createdAfter: "2026-10-01T00:00:00Z" });

  assert.deepEqual(reports.map((r) => r.id), ["r1", "r2"]);
  assert.equal(reports[0].jobId, "job-1");
  assert.equal((calls.reportsList[0] as { jobId: string }).jobId, "job-1");
  assert.equal((calls.reportsList[0] as { createdAfter?: string }).createdAfter, "2026-10-01T00:00:00Z");
});

// The bearer token must only ever go to Google's own Reporting host: the URL comes from an API response.
test("assertTrustedReportDownloadUrl accepts only https on youtubereporting.googleapis.com", () => {
  assertTrustedReportDownloadUrl("https://youtubereporting.googleapis.com/v1/media/CHANNEL/x?alt=media");

  for (const bad of [
    "http://youtubereporting.googleapis.com/v1/media/x",
    "https://evil.example.com/v1/media/x",
    "https://youtubereporting.googleapis.com.evil.example.com/v1/media/x",
    "https://evil.example.com/?u=https://youtubereporting.googleapis.com/",
    "https://user@evil.example.com/",
    "not a url",
    "",
  ]) {
    assert.throws(
      () => assertTrustedReportDownloadUrl(bad),
      (error: unknown) => error instanceof DomainError && error.code === "reporting_download_rejected",
      bad
    );
  }
});

test("downloadReportCsv never sends a request to an untrusted URL, and rejects a non-text response", async () => {
  const untrusted = fakeClient({});
  await assert.rejects(() => downloadReportCsv(untrusted.client, "https://evil.example.com/x"));
  assert.deepEqual(untrusted.calls.download, [], "no request (and so no credential) left for the untrusted host");

  const ok = fakeClient({ downloadBody: "date,channel_id\n" });
  assert.equal(await downloadReportCsv(ok.client, "https://youtubereporting.googleapis.com/v1/media/x"), "date,channel_id\n");

  const notText = fakeClient({ downloadBody: { not: "text" } });
  await assert.rejects(
    () => downloadReportCsv(notText.client, "https://youtubereporting.googleapis.com/v1/media/x"),
    (error: unknown) => error instanceof DomainError && error.code === "reporting_report_malformed"
  );
});

test("parseReportingCsv keys rows by header name, so column order does not matter", () => {
  const csv =
    "video_id,date,channel_id,video_thumbnail_impressions_ctr,video_thumbnail_impressions\n" +
    "vidA,20260930,UC_X,0.052,1200\n" +
    "vidB,20260930,UC_X,0.04,300\n";

  const parsed = parseReportingCsv(csv);

  assert.deepEqual(parsed.columns, [
    "video_id",
    "date",
    "channel_id",
    "video_thumbnail_impressions_ctr",
    "video_thumbnail_impressions",
  ]);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], {
    video_id: "vidA",
    date: "20260930",
    channel_id: "UC_X",
    video_thumbnail_impressions_ctr: "0.052",
    video_thumbnail_impressions: "1200",
  });
});

test("parseReportingCsv handles CRLF, a BOM, a trailing newline, and RFC 4180 quoting", () => {
  const csv = '﻿a,b\r\n"x,1","he said ""hi"""\r\n';
  const parsed = parseReportingCsv(csv);
  assert.deepEqual(parsed.columns, ["a", "b"]);
  assert.deepEqual(parsed.rows, [{ a: "x,1", b: 'he said "hi"' }]);
});

test("parseReportingCsv: a header-only file is a valid empty report (no rows), not an error", () => {
  assert.deepEqual(parseReportingCsv("date,channel_id,video_id\n").rows, []);
});

test("parseReportingCsv fails loudly on empty input, a short/long row, and an unterminated quote", () => {
  const isMalformed = (error: unknown) => error instanceof DomainError && error.code === "reporting_report_malformed";
  assert.throws(() => parseReportingCsv(""), isMalformed);
  assert.throws(() => parseReportingCsv("a,b\n1\n"), isMalformed);
  assert.throws(() => parseReportingCsv("a,b\n1,2,3\n"), isMalformed);
  assert.throws(() => parseReportingCsv('a,b\n"1,2\n'), isMalformed);
});
