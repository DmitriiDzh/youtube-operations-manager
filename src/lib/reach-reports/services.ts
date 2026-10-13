import type { ChannelAccessService } from "@/lib/channel-access";
import { credentialUserIdFor, errorCodeOf } from "@/lib/channel-fanout/policy";
import type { ReportingJob, ReportingReport } from "@/lib/youtube-read-gateway";
import type { ParsedReportingCsv } from "@/lib/youtube-read-gateway";
import {
  DomainError,
  TRAFFIC_SOURCE_REPORT_TYPE_ID,
  TRAFFIC_SOURCE_TYPE_LABELS,
  type GetReportingTrafficSourcesResult,
  type TrafficSourceMetrics,
  type FirstFileLagView,
  type OtherReportSyncResult,
  type ReachFileView,
  type ReportTypeStatusView,
  REACH_BASIC_REPORT_TYPE_ID,
  REACH_JOB_NAME,
  type GetChannelReachResult,
  type GetVideoWindowsReachResult,
  type ReachRow,
  type ReachState,
  type ReachVideoDayPoint,
  MAX_VIDEO_DAY_ROWS,
  type ResolvedCredentials,
  type SyncReachFailure,
  type SyncReachReportsResult,
  type SyncReachReportsSkipped,
  MIN_SYNC_INTERVAL_HOURS,
  FIRST_REPORT_EXPECTED_WITHIN_HOURS,
  STATUS_FILES_LIMIT,
  type GetReachStatusResult,
} from "./contracts";
import { aggregateReach, weightedCtr } from "./reach-aggregate";
import { mapReachBasicRows } from "./reach-csv";
import {
  getChannelReachInputSchema,
  getReachStatusInputSchema,
  getReportingTrafficSourcesInputSchema,
  getVideoWindowsReachInputSchema,
  parseWithSchema,
  syncReachReportsInputSchema,
} from "./schemas";

function toVideoDayPoints(rows: readonly ReachRow[]): { points: ReachVideoDayPoint[]; truncated: boolean } {
  const sorted = rows
    .map((row) => ({ videoId: row.videoId, date: row.date, impressions: row.impressions, ctr: row.ctr }))
    .sort((a, b) => a.videoId.localeCompare(b.videoId) || a.date.localeCompare(b.date));
  return { points: sorted.slice(0, MAX_VIDEO_DAY_ROWS), truncated: sorted.length > MAX_VIDEO_DAY_ROWS };
}

/** Hard cap on files downloaded in ONE sync: Google keeps ~30-60 days of daily files, so this only bounds a runaway listing. */
const MAX_FILES_PER_SYNC = 120;

type ReachImportOutcome = { outcome: "imported"; replacedReports: number } | { outcome: "superseded_by_newer" };

/** The ledger fields of one report file, whatever its type. */
export type ReportFileMeta = {
  channelId: string;
  reportTypeId: string;
  jobId: string;
  reportId: string;
  startTime: string;
  endTime: string;
  createTime: string;
};

/**
 * BL-181: a report type synced after Reach (basic user activity, traffic sources): its job name and how one parsed file becomes
 * stored rows. Built in `index.ts`; a core without them syncs Reach only.
 */
export type OtherReportType = {
  reportTypeId: string;
  jobName: string;
  importFile(args: { meta: ReportFileMeta; csv: ParsedReportingCsv }): Promise<{ outcome: ReachImportOutcome; rowCount: number }>;
};

function hoursBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round(((to - from) / 3_600_000) * 10) / 10;
}

function fileView(file: { reportId: string; startTime: string; endTime: string; createTime: string; rowCount: number; status: string; importedAt: Date }): ReachFileView {
  return { ...file, importedAt: file.importedAt.toISOString(), lagHours: hoursBetween(file.endTime, file.createTime) };
}

/**
 * BL-181 (FO-REQ-0020 §2.4): per day, the first file Google created and how long after the day's end. Days that ended before the
 * job was created are left out: Google makes those history files right after the job exists, so their lag measures nothing.
 */
export function firstFileLagOf(
  files: ReadonlyArray<{ startTime: string; endTime: string; createTime: string }>,
  jobCreatedAt: string | null
): FirstFileLagView[] {
  const jobCreatedMs = jobCreatedAt ? Date.parse(jobCreatedAt) : NaN;
  const firstByDay = new Map<string, { createTime: string; createMs: number; endTime: string }>();
  for (const file of files) {
    const createMs = Date.parse(file.createTime);
    const endMs = Date.parse(file.endTime);
    if (Number.isNaN(createMs) || Number.isNaN(endMs)) continue;
    if (Number.isNaN(jobCreatedMs) || endMs <= jobCreatedMs) continue;
    const date = file.startTime.slice(0, 10);
    const known = firstByDay.get(date);
    if (!known || createMs < known.createMs) firstByDay.set(date, { createTime: file.createTime, createMs, endTime: file.endTime });
  }
  return [...firstByDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, first]) => ({ date, createTime: first.createTime, lagHours: hoursBetween(first.endTime, first.createTime) as number }));
}

/** Sums one metric over rows: `null` only when no row carried it (never fabricated as 0). */
function sumMetric(rows: ReadonlyArray<TrafficSourceMetrics>, metric: keyof TrafficSourceMetrics): number | null {
  let total: number | null = null;
  for (const row of rows) {
    const value = row[metric];
    if (value !== null) total = Math.round(((total ?? 0) + value) * 1e6) / 1e6;
  }
  return total;
}

function summed(rows: ReadonlyArray<TrafficSourceMetrics>): TrafficSourceMetrics {
  return { views: sumMetric(rows, "views"), engagedViews: sumMetric(rows, "engagedViews"), watchTimeMinutes: sumMetric(rows, "watchTimeMinutes") };
}

function labelOf(code: number): string | null {
  return TRAFFIC_SOURCE_TYPE_LABELS[code] ?? null;
}

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
    /** Records the outcome of one sync attempt (also a failed one); separate from the file ledger. */
    recordAttempt(args: {
      channelId: string;
      reportTypeId: string;
      outcome: "ok" | "partial" | "failed";
      error: string | null;
      filesListed: number;
      filesImported: number;
      failures: SyncReachFailure[];
    }): Promise<void>;
    getAttempt(
      channelId: string,
      reportTypeId: string
    ): Promise<{
      attemptedAt: Date;
      outcome: "ok" | "partial" | "failed";
      error: string | null;
      filesListed: number;
      filesImported: number;
      failures: SyncReachFailure[];
    } | null>;
    /** BL-181: imported files of one report type (the status of the non-Reach types). */
    countImportedFiles?(channelId: string, reportTypeId: string): Promise<number>;
    /** BL-141: every stored channel and the Google user whose token belongs to it (`channels.connected_user_id`). */
    listChannelConnections(): Promise<Array<{ channelId: string; connectedUserId: string | null }>>;
    listFiles(
      channelId: string,
      reportTypeId: string,
      limit: number
    ): Promise<Array<{ reportId: string; startTime: string; endTime: string; createTime: string; rowCount: number; status: string; importedAt: Date }>>;
  };
  channelAccess: ChannelAccessService;
  /** The scope the Reporting API needs (`yt-analytics.readonly`). */
  requiredScope: string;
  clock: { now(): Date };
  /** BL-181: report types synced after Reach in the same call; none by default. */
  otherReportTypes?: readonly OtherReportType[];
  /** BL-181 (owner msg 2702): the stored traffic-source rows, for `getReportingTrafficSources`. */
  trafficSourceStore?: {
    listDaily(
      channelId: string,
      range: { startDate: string; endDate: string },
      videoId?: string
    ): Promise<Array<{ date: string; videoId: string; trafficSourceType: number; views: number | null; engagedViews: number | null; watchTimeMinutes: number | null }>>;
    getCoverage(channelId: string): Promise<{ firstDate: string | null; lastDate: string | null }>;
    listFiles(channelId: string, range: { startDate: string; endDate: string }): Promise<Array<{ startTime: string; endTime: string; createTime: string }>>;
  };
};

/**
 * Channels with an automatic (`onlyIfDue`) sync running in this process; shared by every core instance. Kept on
 * `globalThis` (like the operation registry): Next can load a module once per route bundle, and every copy must see
 * the same set.
 */
const inFlightAutoSyncs: Set<string> = ((globalThis as unknown as Record<symbol, Set<string> | undefined>)[
  Symbol.for("youtube-operations-manager.reach-in-flight-auto-syncs")
] ??= new Set<string>());

export type SyncAllReachChannelOutcome =
  | { channelId: string; outcome: "synced"; filesImported: number }
  | { channelId: string; outcome: "skipped"; reason: "no_connected_user" | "checked_recently" | "in_progress" }
  | { channelId: string; outcome: "failed"; error: string; code?: string };

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

  /**
   * Makes sure the channel's job of one report type exists (reusing an existing one) and imports every file not seen before,
   * oldest generation first. One bad file does not stop the others; it is reported in `failures` and retried on the next call.
   */
  async function syncFilesOfType(
    credentials: ResolvedCredentials,
    channelId: string,
    reportTypeId: string,
    jobName: string,
    importOne: (meta: ReportFileMeta, csv: ParsedReportingCsv) => Promise<{ outcome: ReachImportOutcome; rowCount: number }>
  ): Promise<{ result: Omit<SyncReachReportsResult, "skipped"> }> {
    const { job, created } = await deps.reportingApi.ensureJob({ credentials, reportTypeId, name: jobName });
    await deps.store.upsertJob({ channelId, reportTypeId, jobId: job.id, jobName: job.name, jobCreatedAt: job.createTime });

    const [listed, seen] = await Promise.all([
      deps.reportingApi.listReports({ credentials, jobId: job.id }),
      deps.store.listSeenReportIds(channelId, reportTypeId),
    ]);
    // Oldest generation first, so a regenerated file is always applied after the one it replaces.
    const pending = listed
      .filter((report) => !seen.has(report.id))
      .sort((a, b) => Date.parse(a.createTime) - Date.parse(b.createTime))
      .slice(0, MAX_FILES_PER_SYNC);

    const result: Omit<SyncReachReportsResult, "skipped"> = {
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
        const imported = await importOne(
          {
            channelId,
            reportTypeId,
            jobId: job.id,
            reportId: report.id,
            startTime: report.startTime,
            endTime: report.endTime,
            createTime: report.createTime,
          },
          csv
        );
        if (imported.outcome.outcome === "imported") {
          result.filesImported += 1;
          result.rowsImported += imported.rowCount;
        } else {
          result.filesSuperseded += 1;
        }
      } catch (error) {
        result.failures.push({ reportId: report.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { result };
  }

  /** BL-181: one other report type's sync, with its own attempt row; never throws. */
  async function syncOtherType(credentials: ResolvedCredentials, channelId: string, type: OtherReportType): Promise<OtherReportSyncResult> {
    try {
      const { result } = await syncFilesOfType(credentials, channelId, type.reportTypeId, type.jobName, (meta, csv) => type.importFile({ meta, csv }));
      const outcome = result.failures.length > 0 ? "partial" : "ok";
      try {
        await deps.store.recordAttempt({
          channelId,
          reportTypeId: type.reportTypeId,
          outcome,
          error: null,
          filesListed: result.filesListed,
          filesImported: result.filesImported,
          failures: result.failures,
        });
      } catch {
        // Informational only.
      }
      return {
        reportTypeId: type.reportTypeId,
        outcome,
        error: null,
        jobCreated: result.jobCreated,
        filesListed: result.filesListed,
        filesImported: result.filesImported,
        filesSuperseded: result.filesSuperseded,
        rowsImported: result.rowsImported,
        failures: result.failures,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await deps.store.recordAttempt({ channelId, reportTypeId: type.reportTypeId, outcome: "failed", error: message, filesListed: 0, filesImported: 0, failures: [] });
      } catch {
        // Informational only.
      }
      return {
        reportTypeId: type.reportTypeId,
        outcome: "failed",
        error: message,
        jobCreated: false,
        filesListed: 0,
        filesImported: 0,
        filesSuperseded: 0,
        rowsImported: 0,
        failures: [],
      };
    }
  }

  /** BL-181: a non-Reach type's status block -- local data only. */
  async function otherTypeStatus(channelId: string, reportTypeId: string): Promise<ReportTypeStatusView> {
    const [job, attempt, files, importedFiles] = await Promise.all([
      deps.store.getJob(channelId, reportTypeId),
      deps.store.getAttempt(channelId, reportTypeId),
      deps.store.listFiles(channelId, reportTypeId, STATUS_FILES_LIMIT),
      deps.store.countImportedFiles ? deps.store.countImportedFiles(channelId, reportTypeId) : Promise.resolve(0),
    ]);
    return {
      reportTypeId,
      job: job ? { jobId: job.jobId, createdAt: job.jobCreatedAt } : null,
      lastAttempt: attempt
        ? {
            at: attempt.attemptedAt.toISOString(),
            outcome: attempt.outcome,
            error: attempt.error,
            filesListed: attempt.filesListed,
            filesImported: attempt.filesImported,
            failures: attempt.failures,
          }
        : null,
      importedFiles,
      files: files.map(fileView),
      firstFileLag: firstFileLagOf(files, job?.jobCreatedAt ?? null),
    };
  }

  const services = {
    /**
     * Makes sure the channel's Reach job exists (reusing an existing one) and imports every report file not
     * seen before. Safe to call repeatedly: a file is downloaded and imported once. One bad file does not
     * stop the others; it is reported in `failures` and retried on the next call.
     */
    async syncReachReports(input: unknown): Promise<SyncReachReportsResult | SyncReachReportsSkipped> {
      const parsed = parseWithSchema(syncReachReportsInputSchema, input, "sync reach reports input");
      await assertChannel(parsed.credentialRef, parsed.channelId);

      const otherTypes = deps.otherReportTypes ?? [];
      // The time a type was checked within the last MIN_SYNC_INTERVAL_HOURS (so it is not due), or null when it is due.
      const checkedRecentlyAt = async (reportTypeId: string): Promise<Date | null> => {
        const [known, attempt] = await Promise.all([deps.store.getJob(parsed.channelId, reportTypeId), deps.store.getAttempt(parsed.channelId, reportTypeId)]);
        // A FAILED attempt does not throttle: its cause is usually fixable (toggle back on, scope re-granted,
        // API enabled) and the automatic sync must pick that up on the next dashboard open, not 6 hours later.
        const lastChecked = [
          known?.lastCheckedAt ?? null,
          attempt && (attempt.outcome !== "failed" || parsed.throttleFailed) ? attempt.attemptedAt : null,
        ]
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        return lastChecked && deps.clock.now().getTime() < lastChecked.getTime() + MIN_SYNC_INTERVAL_HOURS * 3_600_000 ? lastChecked : null;
      };
      let reachCheckedAt: Date | null = null;
      let dueOtherTypes = otherTypes;
      if (parsed.onlyIfDue) {
        reachCheckedAt = await checkedRecentlyAt(REACH_BASIC_REPORT_TYPE_ID);
        // BL-181 (review finding 2): each other type by its OWN checks. Reach's are shared with the other computer (BL-151), these
        // types' are device-local, so the other computer checking Reach must not hold back this computer's own downloads.
        const othersCheckedAt = await Promise.all(otherTypes.map((type) => checkedRecentlyAt(type.reportTypeId)));
        dueOtherTypes = otherTypes.filter((_, index) => othersCheckedAt[index] === null);
        if (reachCheckedAt && dueOtherTypes.length === 0) {
          return { skipped: true, reason: "checked_recently", lastCheckedAt: reachCheckedAt.toISOString() };
        }
      }
      const reachDue = reachCheckedAt === null;

      // BL-141: two automatic syncs of one channel (two tabs, two dashboards) must not run side by side -- both would
      // pass the due check above, create the job twice on a first run and import the same files twice.
      if (parsed.onlyIfDue) {
        if (inFlightAutoSyncs.has(parsed.channelId)) return { skipped: true, reason: "in_progress" };
        inFlightAutoSyncs.add(parsed.channelId);
      }
      let othersRecorded = false;
      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsed.credentialRef,
          requiredScopes: [deps.requiredScope],
        });

        let reach: SyncReachReportsResult | null = null;
        let reachError: unknown = null;
        if (reachDue) {
          try {
            const synced = await syncFilesOfType(credentials, parsed.channelId, REACH_BASIC_REPORT_TYPE_ID, REACH_JOB_NAME, async (meta, csv) => {
              const rows = mapReachBasicRows(csv, parsed.channelId);
              return { outcome: await deps.store.importReport({ ...meta, rows }), rowCount: rows.length };
            });
            reach = { skipped: false, ...synced.result };
            await deps.store.recordAttempt({
              channelId: parsed.channelId,
              reportTypeId: REACH_BASIC_REPORT_TYPE_ID,
              outcome: reach.failures.length > 0 ? "partial" : "ok",
              error: null,
              filesListed: reach.filesListed,
              filesImported: reach.filesImported,
              failures: reach.failures,
            });
          } catch (error) {
            reachError = error;
          }
        }

        // BL-181: each other type after Reach, on its own (AGENTS.md §M) -- its failure is recorded in its own attempt row and
        // never changes Reach's outcome; Reach failing does not stop them either.
        const otherReports: OtherReportSyncResult[] = [];
        for (const type of dueOtherTypes) otherReports.push(await syncOtherType(credentials, parsed.channelId, type));
        othersRecorded = true;

        if (reachCheckedAt) return { skipped: true, reason: "checked_recently", lastCheckedAt: reachCheckedAt.toISOString(), otherReports };
        if (reachError !== null || reach === null) throw reachError;
        return otherTypes.length > 0 ? { ...reach, otherReports } : reach;
      } catch (error) {
        // The sync stopped before it could import anything (auth/scope, API disabled, toggle off, listing
        // failed): record it so the Analytics card can say why, then let the caller see the same error.
        const message = error instanceof Error ? error.message : String(error);
        if (!reachDue && reachCheckedAt) {
          // Only the other types were due (re-check finding): Reach was not attempted, so its outcome stays "checked recently";
          // their failure is in their own attempt rows.
          for (const type of othersRecorded ? [] : dueOtherTypes) {
            try {
              await deps.store.recordAttempt({ channelId: parsed.channelId, reportTypeId: type.reportTypeId, outcome: "failed", error: message, filesListed: 0, filesImported: 0, failures: [] });
            } catch {
              // Informational only.
            }
          }
          return {
            skipped: true,
            reason: "checked_recently",
            lastCheckedAt: reachCheckedAt.toISOString(),
            otherReports: dueOtherTypes.map((type) => ({
              reportTypeId: type.reportTypeId,
              outcome: "failed" as const,
              error: message,
              jobCreated: false,
              filesListed: 0,
              filesImported: 0,
              filesSuperseded: 0,
              rowsImported: 0,
              failures: [],
            })),
          };
        }
        const attempted = [...(reachDue ? [REACH_BASIC_REPORT_TYPE_ID] : []), ...(othersRecorded ? [] : dueOtherTypes.map((type) => type.reportTypeId))];
        for (const reportTypeId of attempted) {
          try {
            await deps.store.recordAttempt({
              channelId: parsed.channelId,
              reportTypeId,
              outcome: "failed",
              error: message,
              filesListed: 0,
              filesImported: 0,
              failures: [],
            });
          } catch {
            // Recording is informational; never mask the original error.
          }
        }
        throw error;
      } finally {
        if (parsed.onlyIfDue) inFlightAutoSyncs.delete(parsed.channelId);
      }
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
      const scoped = parsed.videoId ? rows.filter((row) => row.videoId === parsed.videoId) : rows;
      const videoDaily = parsed.groupBy === "video_day" ? toVideoDayPoints(scoped) : null;
      return {
        channelId: parsed.channelId,
        state,
        jobCreatedAt: job?.jobCreatedAt ?? null,
        coverage,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        ...aggregateReach(scoped),
        ...(parsed.videoId ? { videoId: parsed.videoId } : {}),
        ...(videoDaily ? { videoDaily: videoDaily.points, videoDailyTruncated: videoDaily.truncated } : {}),
      };
    },

    /**
     * BL-166: each video's Reach over its own window (the Producer's upload milestones) -- a local read, no Google call. One stored
     * read covers the span of every window; each window's totals use the same rule as `getChannelReach` (impressions summed, CTR
     * impressions-weighted). Same active-channel check as `getChannelReach`.
     */
    async getVideoWindowsReach(input: unknown): Promise<GetVideoWindowsReachResult> {
      const parsed = parseWithSchema(getVideoWindowsReachInputSchema, input, "get video windows reach input");
      await assertChannel(parsed.credentialRef, parsed.channelId);
      const [job, coverage] = await Promise.all([deps.store.getJob(parsed.channelId, REACH_BASIC_REPORT_TYPE_ID), deps.store.getCoverage(parsed.channelId)]);
      const state: ReachState = !job ? "no_job" : coverage.importedFiles === 0 ? "waiting_for_first_report" : "ready";
      if (parsed.windows.length === 0) return { channelId: parsed.channelId, state, windows: [] };
      const startDate = parsed.windows.reduce((min, window) => (window.startDate < min ? window.startDate : min), parsed.windows[0].startDate);
      const endDate = parsed.windows.reduce((max, window) => (window.endDate > max ? window.endDate : max), parsed.windows[0].endDate);
      const rows = await deps.store.listDaily(parsed.channelId, { startDate, endDate });
      const byVideo = new Map<string, ReachRow[]>();
      for (const row of rows) byVideo.set(row.videoId, [...(byVideo.get(row.videoId) ?? []), row]);
      return {
        channelId: parsed.channelId,
        state,
        windows: parsed.windows.map((window) => {
          const inWindow = (byVideo.get(window.videoId) ?? []).filter((row) => row.date >= window.startDate && row.date <= window.endDate);
          return {
            ...window,
            daysWithData: new Set(inWindow.map((row) => row.date)).size,
            impressions: inWindow.reduce((total, row) => total + row.impressions, 0),
            ctr: weightedCtr(inWindow),
          };
        }),
      };
    },

    /**
     * BL-181 (owner msg 2702, FO-MSG-0015): the stored traffic-source rows of a range -- a local read, no Google call. `state` is the
     * traffic-source job's, so an empty result is never read as zero traffic. Per day and code the channel's videos are summed, the
     * channel-level and deleted-video remainder (`videoId` "") included; with `videoId`, only that video's rows count.
     */
    async getReportingTrafficSources(input: unknown): Promise<GetReportingTrafficSourcesResult> {
      const parsed = parseWithSchema(getReportingTrafficSourcesInputSchema, input, "get reporting traffic sources input");
      await assertChannel(parsed.credentialRef, parsed.channelId);
      const store = deps.trafficSourceStore;
      if (!store) throw new DomainError({ code: "not_found", message: "The traffic-source read is not available in this build." });
      const range = { startDate: parsed.startDate, endDate: parsed.endDate };
      const [job, importedFiles, coverage, stored, files] = await Promise.all([
        deps.store.getJob(parsed.channelId, TRAFFIC_SOURCE_REPORT_TYPE_ID),
        deps.store.countImportedFiles ? deps.store.countImportedFiles(parsed.channelId, TRAFFIC_SOURCE_REPORT_TYPE_ID) : Promise.resolve(0),
        store.getCoverage(parsed.channelId),
        store.listDaily(parsed.channelId, range, parsed.videoId),
        store.listFiles(parsed.channelId, range),
      ]);
      // Review S1: the SQL already narrows to `videoId`; grouping appends in place (a year of a large channel is ~600k rows).
      const rows = parsed.videoId ? stored.filter((row) => row.videoId === parsed.videoId) : stored;

      const byDayAndCode = new Map<string, typeof rows>();
      const byCode = new Map<number, typeof rows>();
      const push = <K>(map: Map<K, typeof rows>, key: K, row: (typeof rows)[number]) => {
        const group = map.get(key);
        if (group) group.push(row);
        else map.set(key, [row]);
      };
      for (const row of rows) {
        push(byDayAndCode, `${row.date}\u0000${row.trafficSourceType}`, row);
        push(byCode, row.trafficSourceType, row);
      }
      const daily = [...byDayAndCode.values()]
        .map((group) => ({ date: group[0].date, trafficSourceType: group[0].trafficSourceType, label: labelOf(group[0].trafficSourceType), ...summed(group) }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.trafficSourceType - b.trafficSourceType);
      const totals = [...byCode.entries()]
        .map(([code, group]) => ({ trafficSourceType: code, label: labelOf(code), ...summed(group) }))
        .sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.trafficSourceType - b.trafficSourceType);
      const videoDaily =
        parsed.groupBy === "video_day"
          ? [...rows]
              .sort((a, b) => a.videoId.localeCompare(b.videoId) || a.date.localeCompare(b.date) || a.trafficSourceType - b.trafficSourceType)
              .map(({ videoId, date, trafficSourceType, views, engagedViews, watchTimeMinutes }) => ({ videoId, date, trafficSourceType, views, engagedViews, watchTimeMinutes }))
          : null;

      return {
        channelId: parsed.channelId,
        state: !job ? "no_job" : importedFiles === 0 ? "waiting_for_first_report" : "ready",
        jobCreatedAt: job?.jobCreatedAt ?? null,
        coverage: { ...coverage, importedFiles },
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        daily,
        totals,
        files: files.map((file) => ({ date: file.startTime.slice(0, 10), createTime: file.createTime, lagHours: hoursBetween(file.endTime, file.createTime) })),
        ...(parsed.videoId ? { videoId: parsed.videoId } : {}),
        ...(videoDaily ? { videoDaily: videoDaily.slice(0, MAX_VIDEO_DAY_ROWS), videoDailyTruncated: videoDaily.length > MAX_VIDEO_DAY_ROWS } : {}),
      };
    },

    /**
     * Local read of the Reporting job and its files -- no Google call. Powers the Analytics card's status
     * block; every value is stored data or arithmetic on it, nothing is fabricated.
     */
    async getReachStatus(input: unknown): Promise<GetReachStatusResult> {
      const parsed = parseWithSchema(getReachStatusInputSchema, input, "get reach status input");
      await assertChannel(parsed.credentialRef, parsed.channelId);
      const otherTypes = deps.otherReportTypes ?? [];

      const [job, attempt, coverage, files] = await Promise.all([
        deps.store.getJob(parsed.channelId, REACH_BASIC_REPORT_TYPE_ID),
        deps.store.getAttempt(parsed.channelId, REACH_BASIC_REPORT_TYPE_ID),
        deps.store.getCoverage(parsed.channelId),
        deps.store.listFiles(parsed.channelId, REACH_BASIC_REPORT_TYPE_ID, STATUS_FILES_LIMIT),
      ]);

      const createdMs = job?.jobCreatedAt ? Date.parse(job.jobCreatedAt) : NaN;
      const expectedMs = Number.isNaN(createdMs) ? null : createdMs + FIRST_REPORT_EXPECTED_WITHIN_HOURS * 3_600_000;
      const lastChecked = [job?.lastCheckedAt ?? null, attempt && attempt.outcome !== "failed" ? attempt.attemptedAt : null]
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];

      return {
        channelId: parsed.channelId,
        job: job ? { jobId: job.jobId, createdAt: job.jobCreatedAt } : null,
        firstFileExpectedBy: expectedMs === null ? null : new Date(expectedMs).toISOString(),
        firstFileOverdue: job !== null && coverage.importedFiles === 0 && expectedMs !== null && deps.clock.now().getTime() > expectedMs,
        lastAttempt: attempt
          ? {
              at: attempt.attemptedAt.toISOString(),
              outcome: attempt.outcome,
              error: attempt.error,
              filesListed: attempt.filesListed,
              filesImported: attempt.filesImported,
              failures: attempt.failures,
            }
          : null,
        nextAutoCheckAt: lastChecked ? new Date(lastChecked.getTime() + MIN_SYNC_INTERVAL_HOURS * 3_600_000).toISOString() : null,
        importedFiles: coverage.importedFiles,
        files: files.map(fileView),
        firstFileLag: firstFileLagOf(files, job?.jobCreatedAt ?? null),
        ...(otherTypes.length > 0 ? { otherReports: await Promise.all(otherTypes.map((type) => otherTypeStatus(parsed.channelId, type.reportTypeId))) } : {}),
      };
    },
  };

  return {
    ...services,

    /**
     * BL-141 (owner, Telegram 2026-10-06, msgs 1864/1865): the dashboard's automatic check, for EVERY connected channel,
     * not only the active one. The session's own active channel is synced with the session's credentials, exactly as
     * the single-channel automatic call always was. Every other channel goes through the same syncReachReports with
     * its OWN Google user's credentials (`connectedUserId`), so its active-channel check still applies: a user who has
     * since switched to another channel fails closed for this one rather than syncing it with a token that is no
     * longer its own. No extra live identity call -- the same posture as the single-channel path; a file whose rows
     * carry another channel's id is still rejected whole (reach-csv.ts). For those background channels a failed
     * attempt also throttles (6 h), so broken auth is not retried on every load, and a "not synced" reason is
     * recorded in the channel's own attempt row, so its Analytics status block says why. Channels run concurrently;
     * one failing never stops the others (AGENTS.md §M).
     */
    async syncAllReachReports(input: { onlyIfDue: boolean; sessionUserId: string }): Promise<{ channels: SyncAllReachChannelOutcome[] }> {
      const [connections, activeChannelId] = await Promise.all([
        deps.store.listChannelConnections(),
        deps.channelAccess.getActiveChannelId(input.sessionUserId),
      ]);

      async function recordNotSynced(channelId: string, error: string) {
        try {
          await deps.store.recordAttempt({
            channelId,
            reportTypeId: REACH_BASIC_REPORT_TYPE_ID,
            outcome: "failed",
            error,
            filesListed: 0,
            filesImported: 0,
            failures: [],
          });
        } catch {
          // Informational only.
        }
      }

      async function syncOne({ channelId, connectedUserId }: { channelId: string; connectedUserId: string | null }): Promise<SyncAllReachChannelOutcome> {
        const isActive = channelId === activeChannelId;
        const userId = credentialUserIdFor({ channelId, connectedUserId }, { activeChannelId, sessionUserId: input.sessionUserId });
        if (!userId) {
          await recordNotSynced(channelId, "Not checked automatically: no Google account is connected for this channel.");
          return { channelId, outcome: "skipped", reason: "no_connected_user" };
        }
        try {
          const result = await services.syncReachReports({
            credentialRef: { userId },
            channelId,
            ...(input.onlyIfDue ? { onlyIfDue: true, throttleFailed: !isActive } : {}),
          });
          return result.skipped
            ? { channelId, outcome: "skipped", reason: result.reason }
            : { channelId, outcome: "synced", filesImported: result.filesImported };
        } catch (error) {
          const code = errorCodeOf(error);
          // Thrown by the active-channel check, before syncReachReports records anything itself.
          if (code === "CHANNEL_NOT_ACTIVE") {
            await recordNotSynced(
              channelId,
              "Not checked automatically: this channel's Google account now has another channel selected. Open the dashboard with this channel to update its reports."
            );
          }
          return {
            channelId,
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error),
            ...(code ? { code } : {}),
          };
        }
      }

      return { channels: await Promise.all(connections.map(syncOne)) };
    },
  };
}

export type ReachReportsServices = ReturnType<typeof createReachReportsServices>;
export { DomainError };
