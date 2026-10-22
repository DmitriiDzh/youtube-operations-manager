import { isDomainError } from "@/lib/shared-domain";
import {
  BROADCAST_ENDED_AFTER_MS,
  DAY_MS,
  FINAL_PULL_AFTER_MS,
  PULL_MAX_ATTEMPTS,
  PULL_RETRY_AFTER_MS,
  PULLS_PER_TICK,
  type BroadcastAnalyticsData,
  type BroadcastAnalyticsStatus,
  type ReportOutcome,
  type WatchTotals,
} from "./contracts";

// BL-212 (LIVE_ANALYTICS_PLAN.md stage 2): YouTube Analytics of our own ended broadcasts, pulled by the computer that ran them
// (its samples say which broadcasts exist) once one ended and again after the reporting lag. Read-only. A recording that was not
// kept or was deleted may answer nothing later -- what was pulled stays.

export type StoredPull = {
  broadcastId: string;
  channelId: string;
  status: BroadcastAnalyticsStatus;
  final: boolean;
  attempts: number;
  lastAttemptAt: Date;
  collectedAt: Date | null;
  dataJson: string | null;
  error: string | null;
};

type ReportRow = { dimensions: Record<string, string>; metrics: Record<string, number> };

export type CollectorDeps = {
  broadcasts(): Promise<Array<{ channelId: string; broadcastId: string; firstSampleAt: number; lastSampleAt: number }>>;
  stored(broadcastIds: string[]): Promise<StoredPull[]>;
  save(row: StoredPull): Promise<void>;
  /** One `reports.query` for one of our videos, through the read gateway. Throws the API's error. */
  query(args: { channelId: string; videoId: string; startDate: string; endDate: string; metricNames: readonly string[]; dimensions?: string }): Promise<ReportRow[]>;
  now(): Date;
};

const CONCURRENT = ["averageConcurrentViewers", "peakConcurrentViewers"] as const;
const SPLIT = ["views", "estimatedMinutesWatched"] as const;
/** Errors that stop the whole tick without counting an attempt: nothing can be asked right now. */
const STOP_CODES = new Set(["analytics_reads_disabled", "youtube_quota_exceeded"]);

function httpStatus(error: unknown): number | null {
  const e = error as { response?: { status?: unknown }; status?: unknown; code?: unknown } | null;
  for (const value of [e?.response?.status, e?.status, e?.code]) if (typeof value === "number") return value;
  return null;
}

function outcomeOf(error: unknown): ReportOutcome {
  const status = httpStatus(error);
  if (status === 400) return "unsupported";
  if (status === 403 || status === 404) return "unavailable";
  return "error";
}

const metric = (row: ReportRow | undefined, name: string) => (row && typeof row.metrics[name] === "number" ? row.metrics[name] : null);
const totals = (row: ReportRow | undefined): WatchTotals | null => (row ? { views: metric(row, "views"), minutesWatched: metric(row, "estimatedMinutesWatched") } : null);
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function isDue(broadcast: { lastSampleAt: number }, stored: StoredPull | undefined, now: number): boolean {
  if (now - broadcast.lastSampleAt < BROADCAST_ENDED_AFTER_MS) return false;
  if (!stored) return true;
  if (stored.final || stored.status === "unavailable") return false;
  const mayRetry = stored.attempts < PULL_MAX_ATTEMPTS && now - stored.lastAttemptAt.getTime() >= PULL_RETRY_AFTER_MS;
  if (stored.status === "failed") return mayRetry;
  // Collected, not final: the final pull once the lag is over -- a failed one is retried like any other, within the same cap.
  return now >= broadcast.lastSampleAt + FINAL_PULL_AFTER_MS && mayRetry;
}

export function createBroadcastAnalyticsCollector(deps: CollectorDeps) {
  async function pull(broadcast: { channelId: string; broadcastId: string; firstSampleAt: number; lastSampleAt: number }, stored: StoredPull | undefined, now: number) {
    const base = { channelId: broadcast.channelId, videoId: broadcast.broadcastId, startDate: utcDate(broadcast.firstSampleAt - DAY_MS), endDate: utcDate(now) };
    const run = async (metricNames: readonly string[], dimensions?: string): Promise<{ outcome: ReportOutcome; rows: ReportRow[]; error?: string }> => {
      try {
        return { outcome: "ok", rows: await deps.query({ ...base, metricNames, ...(dimensions ? { dimensions } : {}) }) };
      } catch (error) {
        if (isDomainError(error) && STOP_CODES.has(error.code)) throw error;
        return { outcome: outcomeOf(error), rows: [], error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
      }
    };
    const concurrent = await run(CONCURRENT);
    const curve = await run(CONCURRENT, "livestreamPosition");
    const split = await run(SPLIT, "liveOrOnDemand");
    const outcomes = [concurrent.outcome, curve.outcome, split.outcome];
    const attempts = (stored?.attempts ?? 0) + 1;
    const at = new Date(now);
    const error = [concurrent.error, curve.error, split.error].filter(Boolean).join(" | ") || null;
    const gone = outcomes.every((o) => o === "unavailable");
    if (!outcomes.includes("ok")) {
      if (stored?.status === "collected") {
        // A failed retry keeps what an earlier pull collected; a video that is gone now makes that pull the final one.
        await deps.save({ ...stored, final: stored.final || gone, attempts, lastAttemptAt: at, error });
        return;
      }
      await deps.save({ broadcastId: broadcast.broadcastId, channelId: broadcast.channelId, status: gone ? "unavailable" : "failed", final: false, attempts, lastAttemptAt: at, collectedAt: null, dataJson: null, error });
      return;
    }
    let previous: BroadcastAnalyticsData | null = null;
    try {
      previous = stored?.dataJson ? (JSON.parse(stored.dataJson) as BroadcastAnalyticsData) : null;
    } catch {
      previous = null;
    }
    // Per report: one that did not answer this time keeps the earlier pull's value and outcome.
    const keep = <T,>(outcome: ReportOutcome, fresh: () => T, earlier: T | undefined, earlierOutcome: ReportOutcome | undefined): [T | null, ReportOutcome] =>
      outcome === "ok" ? [fresh(), outcome] : previous && earlierOutcome === "ok" ? [earlier ?? null, "ok"] : [null, outcome];
    const [concurrentValue, concurrentOutcome] = keep(concurrent.outcome, () => ({ average: metric(concurrent.rows[0], CONCURRENT[0]), peak: metric(concurrent.rows[0], CONCURRENT[1]) }), previous?.concurrent ?? undefined, previous?.reports.concurrent);
    const [curveValue, curveOutcome] = keep(
      curve.outcome,
      () =>
        curve.rows
          .map((row): [number, number | null, number | null] => [Number(row.dimensions.livestreamPosition), metric(row, CONCURRENT[0]), metric(row, CONCURRENT[1])])
          .filter(([position]) => Number.isFinite(position))
          .sort((a, b) => a[0] - b[0]),
      previous?.curve ?? undefined,
      previous?.reports.curve
    );
    const byKind = (kind: string) => split.rows.find((row) => row.dimensions.liveOrOnDemand === kind);
    const [splitValue, splitOutcome] = keep(split.outcome, () => ({ live: totals(byKind("LIVE")), onDemand: totals(byKind("ON_DEMAND")) }), previous ? { live: previous.live, onDemand: previous.onDemand } : undefined, previous?.reports.split);
    const data: BroadcastAnalyticsData = {
      concurrent: concurrentValue,
      curve: curveValue,
      live: splitValue?.live ?? null,
      onDemand: splitValue?.onDemand ?? null,
      reports: { concurrent: concurrentOutcome, curve: curveOutcome, split: splitOutcome },
    };
    await deps.save({
      broadcastId: broadcast.broadcastId,
      channelId: broadcast.channelId,
      status: "collected",
      final: now >= broadcast.lastSampleAt + FINAL_PULL_AFTER_MS,
      attempts,
      lastAttemptAt: at,
      collectedAt: at,
      dataJson: JSON.stringify(data),
      error: null,
    });
  }

  return {
    /** Pulls up to PULLS_PER_TICK due broadcasts, oldest ended first. Reads off or quota spent: stops, nothing counted. */
    async tick(): Promise<{ pulled: number }> {
      const now = deps.now().getTime();
      const broadcasts = await deps.broadcasts();
      const stored = new Map((await deps.stored(broadcasts.map((b) => b.broadcastId))).map((row) => [row.broadcastId, row]));
      const due = broadcasts.filter((b) => isDue(b, stored.get(b.broadcastId), now)).sort((a, b) => a.lastSampleAt - b.lastSampleAt).slice(0, PULLS_PER_TICK);
      let pulled = 0;
      for (const broadcast of due) {
        try {
          await pull(broadcast, stored.get(broadcast.broadcastId), now);
          pulled += 1;
        } catch (error) {
          if (isDomainError(error) && STOP_CODES.has(error.code)) break;
          throw error;
        }
      }
      return { pulled };
    },
  };
}
