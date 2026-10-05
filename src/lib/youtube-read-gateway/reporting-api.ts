// ---------------------------------------------------------------------------
// BL-114 (docs/roadmap/BACKLOG.md; docs/decisions/0014-youtube-reporting-api-gateway-child.md) --
// the single low-level wrapper for the YouTube Reporting API v1 (`google.youtubereporting`), this
// gateway's third googleapis-backed read category. A different Google API product from the Data API
// and the Analytics API, with its own client namespace (`youtubereporting_v1`) and its own mechanism:
// bulk, scheduled reports. The ad-hoc Analytics `reports.query` endpoint cannot return thumbnail
// impressions / CTR at all ("The query is not supported", live-verified, see
// `src/lib/analytics/contracts.ts`'s `CHANNEL_OVERVIEW_METRIC_NAMES` doc comment) -- those two
// metrics exist only in this API's Reach reports.
//
// Scope: `YOUTUBE_ANALYTICS_READ_SCOPE` (`yt-analytics.readonly`), already requested for Analytics.
//
// **Creating a reporting job is not a YouTube write** (owner decision, 2026-10-01, ADR 0014): a job
// is a data-collection subscription held by Google for this app's credentials; it changes nothing on
// the channel (metadata, playlists, privacy). It is therefore created from this READ gateway under
// this category's own toggle, never through `youtube-write-gateway` and never gated by Live writes.
// ---------------------------------------------------------------------------
import { google } from "googleapis";
import type { youtubereporting_v1 } from "googleapis";
import { getReportingReadsEnabled, recordGatewayCallOutcome } from "../db";
import { DomainError } from "../shared-domain";
import { callYoutubeApi, wrapYoutubeClientForQuotaClassification } from "./error-classification";

/** "Reporting reads" toggle -- the Reporting-category counterpart to `assertAnalyticsReadsAuthorized`. */
export async function assertReportingReadsAuthorized(): Promise<void> {
  if (await getReportingReadsEnabled()) {
    await recordGatewayCallOutcome("reporting_reads", "allowed");
    return;
  }

  await recordGatewayCallOutcome("reporting_reads", "blocked");
  throw new DomainError({
    code: "reporting_reads_disabled",
    message: 'YouTube Reporting API reads are disabled -- the Settings tab\'s "Reporting reads" toggle is off.',
  });
}

/**
 * The authorized transport used to download a report file. The structural minimum this module needs
 * from a `googleapis` OAuth2 client (kept narrow so tests can fake it without a real credential).
 */
export type ReportingAuth = {
  request(options: { url: string; responseType: "text"; maxContentLength?: number }): Promise<{ data: unknown }>;
};

export type ReportingClient = {
  api: youtubereporting_v1.Youtubereporting;
  auth: ReportingAuth;
};

/**
 * The single choke point every Reporting API read passes through to get a client (the toggle check
 * lives here, not in each caller -- see `data-api.ts`'s `createYoutubeClient`). `auth` is the OAuth2
 * client already carrying the operator's credentials.
 */
export async function createYoutubeReportingClient(
  auth: youtubereporting_v1.Options["auth"] & ReportingAuth
): Promise<ReportingClient> {
  await assertReportingReadsAuthorized();
  return {
    api: wrapYoutubeClientForQuotaClassification(google.youtubereporting({ version: "v1", auth })),
    auth,
  };
}

// --------------------------------------------------------------------------------------------
// Report types, jobs, reports
// --------------------------------------------------------------------------------------------

export type ReportingReportType = { id: string; name: string };

export type ReportingJob = {
  id: string;
  reportTypeId: string;
  name: string;
  createTime: string | null;
  expireTime: string | null;
};

export type ReportingReport = {
  id: string;
  jobId: string;
  /** Inclusive start / exclusive end of the period the file covers, as RFC 3339 strings. */
  startTime: string;
  endTime: string;
  /** When Google generated THIS file. A regenerated file for the same period has a later one. */
  createTime: string;
  downloadUrl: string;
};

const MAX_PAGES = 50;

export async function listReportingReportTypes(client: ReportingClient): Promise<ReportingReportType[]> {
  const found: ReportingReportType[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await callYoutubeApi(() => client.api.reportTypes.list({ pageToken }));
    for (const type of res.data.reportTypes ?? []) {
      if (type.id) found.push({ id: type.id, name: type.name ?? type.id });
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return found;
}

function mapJob(job: youtubereporting_v1.Schema$Job): ReportingJob | null {
  if (!job.id || !job.reportTypeId) return null;
  return {
    id: job.id,
    reportTypeId: job.reportTypeId,
    name: job.name ?? "",
    createTime: job.createTime ?? null,
    expireTime: job.expireTime ?? null,
  };
}

export async function listReportingJobs(client: ReportingClient): Promise<ReportingJob[]> {
  const found: ReportingJob[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await callYoutubeApi(() => client.api.jobs.list({ pageToken }));
    for (const job of res.data.jobs ?? []) {
      const mapped = mapJob(job);
      if (mapped) found.push(mapped);
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return found;
}

/**
 * Makes sure a job for `reportTypeId` exists, reusing one that is already there. **Idempotent by
 * design** (a job created by an earlier run, a probe, or another install on the same channel must be
 * picked up, never duplicated -- Google keeps generating, and the app keeps downloading, one stream
 * per job). `created` is true only when this call actually created the job.
 *
 * Creating a job is the one state-changing call in this module; see the file header for why it is not
 * a YouTube write.
 */
export async function ensureReportingJob(
  client: ReportingClient,
  args: { reportTypeId: string; name: string }
): Promise<{ job: ReportingJob; created: boolean }> {
  const existing = (await listReportingJobs(client)).find((job) => job.reportTypeId === args.reportTypeId);
  if (existing) return { job: existing, created: false };

  const res = await callYoutubeApi(() =>
    client.api.jobs.create({ requestBody: { reportTypeId: args.reportTypeId, name: args.name } })
  );
  const created = mapJob(res.data);
  if (!created) {
    throw new DomainError({
      code: "reporting_report_malformed",
      message: "The Reporting API's jobs.create response had no job id / report type id.",
    });
  }
  return { job: created, created: true };
}

/**
 * Lists the report files Google has generated for a job. `createdAfter` (RFC 3339) narrows to files
 * generated after a point in time -- the incremental-download cursor. Newest-first ordering is not
 * assumed; callers dedupe by (period, createTime) themselves.
 */
export async function listJobReports(
  client: ReportingClient,
  args: { jobId: string; createdAfter?: string }
): Promise<ReportingReport[]> {
  const found: ReportingReport[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await callYoutubeApi(() =>
      client.api.jobs.reports.list({ jobId: args.jobId, createdAfter: args.createdAfter, pageToken })
    );
    for (const report of res.data.reports ?? []) {
      if (!report.id || !report.downloadUrl || !report.startTime || !report.endTime || !report.createTime) continue;
      found.push({
        id: report.id,
        jobId: args.jobId,
        startTime: report.startTime,
        endTime: report.endTime,
        createTime: report.createTime,
        downloadUrl: report.downloadUrl,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return found;
}

// --------------------------------------------------------------------------------------------
// Download + CSV
// --------------------------------------------------------------------------------------------

const REPORT_DOWNLOAD_HOST = "youtubereporting.googleapis.com";
/** Upper bound on one report file. A single channel-day Reach report is far smaller; this only stops a
 * runaway response from exhausting memory. */
const MAX_REPORT_BYTES = 100 * 1024 * 1024;

/**
 * Only ever sends the operator's bearer token to Google's own Reporting host: `downloadUrl` comes
 * from an API response, and an unexpected host (or plain http) must never receive a credential.
 */
export function assertTrustedReportDownloadUrl(downloadUrl: string): void {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    throw new DomainError({ code: "reporting_download_rejected", message: "The report's downloadUrl is not a valid URL." });
  }
  if (url.protocol !== "https:" || url.hostname !== REPORT_DOWNLOAD_HOST) {
    throw new DomainError({
      code: "reporting_download_rejected",
      message: `Refusing to download a report from ${url.protocol}//${url.hostname} -- only https://${REPORT_DOWNLOAD_HOST} is trusted.`,
    });
  }
}

/** Downloads one report file's raw CSV text. */
export async function downloadReportCsv(client: ReportingClient, downloadUrl: string): Promise<string> {
  assertTrustedReportDownloadUrl(downloadUrl);
  const res = await callYoutubeApi(() =>
    client.auth.request({ url: downloadUrl, responseType: "text", maxContentLength: MAX_REPORT_BYTES })
  );
  if (typeof res.data !== "string") {
    throw new DomainError({
      code: "reporting_report_malformed",
      message: "The report download did not return text.",
    });
  }
  return res.data;
}

export type ParsedReportingCsv = {
  columns: string[];
  /** One object per data row, keyed by the exact header name. */
  rows: Array<Record<string, string>>;
};

/** Splits CSV text into records of fields. RFC 4180 quoting (`"a,b"`, `""` escape); CRLF or LF. */
function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  if (inQuotes) {
    throw new DomainError({ code: "reporting_report_malformed", message: "The report CSV has an unterminated quoted field." });
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Parses a Reporting API report file by **header name** (never by column position -- the same rule
 * `analytics-api.ts` follows). A file with no header row, or a data row whose cell count differs from
 * the header's, fails loudly rather than yielding misaligned values.
 */
export function parseReportingCsv(text: string): ParsedReportingCsv {
  const records = splitCsvRecords(text.replace(/^﻿/, ""));
  if (records.length === 0) {
    throw new DomainError({ code: "reporting_report_malformed", message: "The report CSV is empty (no header row)." });
  }
  const columns = records[0].map((c) => c.trim());
  const rows = records.slice(1).map((record, index) => {
    if (record.length !== columns.length) {
      throw new DomainError({
        code: "reporting_report_malformed",
        message: `Report CSV row ${index + 2} has ${record.length} cells, expected ${columns.length}.`,
      });
    }
    const row: Record<string, string> = {};
    columns.forEach((column, i) => {
      row[column] = record[i];
    });
    return row;
  });
  return { columns, rows };
}
