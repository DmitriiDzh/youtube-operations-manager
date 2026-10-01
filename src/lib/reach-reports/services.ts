import type { ChannelAccessService } from "@/lib/channel-access";
import type { ReportingJob, ReportingReport } from "@/lib/youtube-read-gateway";
import type { ParsedReportingCsv } from "@/lib/youtube-read-gateway";
import {
  DomainError,
  REACH_BASIC_REPORT_TYPE_ID,
  REACH_JOB_NAME,
  type GetChannelReachResult,
  type ReachRow,
  type ReachState,
  type ResolvedCredentials,
  type SyncReachFailure,
  type SyncReachReportsResult,
  type SyncReachReportsSkipped,
  MIN_SYNC_INTERVAL_HOURS,
} from "./contracts";
import { aggregateReach } from "./reach-aggregate";
import { mapReachBasicRows } from "./reach-csv";
import { getChannelReachInputSchema, parseWithSchema, syncReachReportsInputSchema } from "./schemas";

/** Hard cap on files downloaded in ONE sync: Google keeps ~30-60 days of daily files, so this only bounds a runaway listing. */
const MAX_FILES_PER_SYNC = 120;

type ReachImportOutcome = { outcome: "imported"; replacedReports: number } | { outcome: "superseded_by_newer" };

export type ReachReportsDependencies = {
  authResolver: {
    resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials>;
  };
  /** Wraps the Reporting API gateway child; every method authenticates with the given credentials. */
  reportingApi: {
    ensureJob(args: { credentials: ResolvedCredentials; reportTypeId: string; name: string }): Promise<{ job: ReportingJob; created: boolean }>;
    listReports(args: { credentials: ResolvedCredentials; jobId: string }): Promise<ReportingReport[]>;
    downloadAndParse(args: { credentials: ResolvedCredentials; downloadUrl: string }): Promise<ParsedReportingCsv>;
  };
  store: {
    upsertJob(args: { channelId: string; reportTypeId: string; jobId: string; jobName: string; jobCreatedAt: string | null }): Promise<void>;
    getJob(channelId: string, reportTypeId: string): Promise<{ jobId: string; jobCreatedAt: string | null; lastCheckedAt: Date | null } | null>;
    listSeenReportIds(channelId: string, reportTypeId: string): Promise<Set<string>>;
    importReport(args: {
      channelId: string;
      reportTypeId: string;
      jobId: string;
      reportId: string;
      startTime: string;
      endTime: string;
      createTime: string;
      rows: ReachRow[];
    }): Promise<ReachImportOutcome>;
    listDaily(channelId: string, range: { startDate: string; endDate: string }): Promise<Array<ReachRow>>;
    getCoverage(channelId: string): Promise<{ firstDate: string | null; lastDate: string | null; importedFiles: number }>;
  };
  channelAccess: ChannelAccessService;
  /** The scope the Reporting API needs (`yt-analytics.readonly`). */
  requiredScope: string;
  clock: { now(): Date };
};

function getCredentialUserId(credentialRef: unknown): string | null {
  return credentialRef !== null &&
    typeof credentialRef === "object" &&
    "userId" in credentialRef &&
    typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

export function createReachReportsServices(deps: ReachReportsDependencies) {
  async function assertChannel(credentialRef: unknown, channelId: string) {
    // Fails closed for any credentialRef without a `userId` (e.g. raw tokens): same rule as analytics.
    await deps.channelAccess.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId });
  }

  return {
    /**
     * Makes sure the channel's Reach job exists (reusing an existing one) and imports every report file not
     * seen before. Safe to call repeatedly: a file is downloaded and imported once. One bad file does not
     * stop the others; it is reported in `failures` and retried on the next call.
     */
    async syncReachReports(input: unknown): Promise<SyncReachReportsResult | SyncReachReportsSkipped> {
      const parsed = parseWithSchema(syncReachReportsInputSchema, input, "sync reach reports input");
      await assertChannel(parsed.credentialRef, parsed.channelId);

      if (parsed.onlyIfDue) {
        const known = await deps.store.getJob(parsed.channelId, REACH_BASIC_REPORT_TYPE_ID);
        if (known?.lastCheckedAt) {
          const dueAt = known.lastCheckedAt.getTime() + MIN_SYNC_INTERVAL_HOURS * 3_600_000;
          if (deps.clock.now().getTime() < dueAt) {
            return { skipped: true, reason: "checked_recently", lastCheckedAt: known.lastCheckedAt.toISOString() };
          }
        }
      }

      const credentials = await deps.authResolver.resolve({
        credentialRef: parsed.credentialRef,
        requiredScopes: [deps.requiredScope],
      });

      const { job, created } = await deps.reportingApi.ensureJob({
        credentials,
        reportTypeId: REACH_BASIC_REPORT_TYPE_ID,
        name: REACH_JOB_NAME,
      });
      await deps.store.upsertJob({
        channelId: parsed.channelId,
        reportTypeId: REACH_BASIC_REPORT_TYPE_ID,
        jobId: job.id,
        jobName: job.name,
        jobCreatedAt: job.createTime,
      });

      const [listed, seen] = await Promise.all([
        deps.reportingApi.listReports({ credentials, jobId: job.id }),
        deps.store.listSeenReportIds(parsed.channelId, REACH_BASIC_REPORT_TYPE_ID),
      ]);
      // Oldest generation first, so a regenerated file is always applied after the one it replaces.
      const pending = listed
        .filter((report) => !seen.has(report.id))
        .sort((a, b) => Date.parse(a.createTime) - Date.parse(b.createTime))
        .slice(0, MAX_FILES_PER_SYNC);

      const result: SyncReachReportsResult = {
        skipped: false,
        jobId: job.id,
        jobCreated: created,
        filesListed: listed.length,
        filesImported: 0,
        filesSuperseded: 0,
        rowsImported: 0,
        failures: [],
      };

      for (const report of pending) {
        try {
          const csv = await deps.reportingApi.downloadAndParse({ credentials, downloadUrl: report.downloadUrl });
          const rows = mapReachBasicRows(csv, parsed.channelId);
          const imported = await deps.store.importReport({
            channelId: parsed.channelId,
            reportTypeId: REACH_BASIC_REPORT_TYPE_ID,
            jobId: job.id,
            reportId: report.id,
            startTime: report.startTime,
            endTime: report.endTime,
            createTime: report.createTime,
            rows,
          });
          if (imported.outcome === "imported") {
            result.filesImported += 1;
            result.rowsImported += rows.length;
          } else {
            result.filesSuperseded += 1;
          }
        } catch (error) {
          const failure: SyncReachFailure = {
            reportId: report.id,
            error: error instanceof Error ? error.message : String(error),
          };
          result.failures.push(failure);
        }
      }

      return result;
    },

    /**
     * Local read of imported Reach data -- no Google call. `state` distinguishes "no job", "job exists but no
     * file imported yet" and "ready", so an empty result is never mistaken for zero impressions.
     */
    async getChannelReach(input: unknown): Promise<GetChannelReachResult> {
      const parsed = parseWithSchema(getChannelReachInputSchema, input, "get channel reach input");
      await assertChannel(parsed.credentialRef, parsed.channelId);

      const [job, coverage, rows] = await Promise.all([
        deps.store.getJob(parsed.channelId, REACH_BASIC_REPORT_TYPE_ID),
        deps.store.getCoverage(parsed.channelId),
        deps.store.listDaily(parsed.channelId, { startDate: parsed.startDate, endDate: parsed.endDate }),
      ]);

      const state: ReachState = !job ? "no_job" : coverage.importedFiles === 0 ? "waiting_for_first_report" : "ready";
      return {
        channelId: parsed.channelId,
        state,
        jobCreatedAt: job?.jobCreatedAt ?? null,
        coverage,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        ...aggregateReach(rows),
      };
    },
  };
}

export type ReachReportsServices = ReturnType<typeof createReachReportsServices>;
export { DomainError };
