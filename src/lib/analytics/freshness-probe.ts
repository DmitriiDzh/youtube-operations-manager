import { errorCodeOf, type ChannelConnection } from "@/lib/channel-fanout/policy";

/**
 * BL-245 (owner, Telegram 2026-11-06): WHEN a day's data first appears in the YouTube Analytics API, to the hour. BL-181's
 * `returnLag` could only say "by the next collection run", and runs happen once or twice a day. This probe asks every connected
 * channel once an hour (minute :07 UTC, `instrumentation.ts`) for ONE channel-level report -- `views` by `day` over the last
 * `FRESHNESS_PROBE_RANGE_DAYS` days -- and stores only the newest day it got back (`analytics_freshness_probes`, schema v119).
 * `returnLagOf` (services.ts) reads these rows next to the collection runs.
 *
 * - Never a collection: nothing is stored from the rows, no collection run is recorded, staleness and coverage do not move.
 * - Channel level only: the probe says nothing about per-video data (each video would cost a query); video lag still comes
 *   from the collection runs.
 * - Dates: `endDate` is today's UTC date, `startDate` 5 days before -- the convention the hourly broadcast pull (BL-212) already
 *   sends to the real API. Any day whose first return we want to time (yesterday or the day before, Pacific) lies inside it.
 * - Off with Settings → "Analytics reads" (the client constructor refuses): such a tick records nothing, since nothing was asked.
 *   Any other failure is recorded on the channel's row (`error`, short, never a token) and the next channel is probed.
 * - One tick at a time: a tick that finds the previous one still running is skipped.
 * - Probe rows older than `FRESHNESS_PROBE_RETENTION_DAYS` are deleted at the start of each tick.
 */

export const FRESHNESS_PROBE_MINUTE = 7;
export const FRESHNESS_PROBE_RANGE_DAYS = 5;
export const FRESHNESS_PROBE_RETENTION_DAYS = 45;
/** The probe's one metric: the cheapest channel total that every channel with any activity has. */
export const FRESHNESS_PROBE_METRICS = ["views"] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_ERROR_LENGTH = 200;

/** Milliseconds from `now` to the next instant at `minute` past a UTC hour -- strictly after `now` (exactly at :07:00.000 = one hour). */
export function msUntilNextProbe(now: Date, minute: number = FRESHNESS_PROBE_MINUTE): number {
  const intoHour = ((now.getTime() % HOUR_MS) + HOUR_MS) % HOUR_MS;
  const delay = minute * 60_000 - intoHour;
  return delay > 0 ? delay : delay + HOUR_MS;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type FreshnessProbeRow = {
  channelId: string;
  probedAt: Date;
  requestedStartDate: string;
  requestedEndDate: string;
  newestChannelDate: string | null;
  error: string | null;
};

export type FreshnessProbeDeps = {
  listChannels(): Promise<ChannelConnection[]>;
  /** One channel-level `dimensions=day` Analytics query under the channel's own Google user; the rows' `date` is the day. */
  queryChannelDays(args: { channelId: string; userId: string; startDate: string; endDate: string }): Promise<Array<{ date: string }>>;
  store: {
    record(row: FreshnessProbeRow): Promise<void>;
    deleteBefore(cutoff: Date): Promise<number>;
  };
  clock: { now(): Date };
  onIssue?(message: string): void;
};

export type FreshnessProbeTickResult =
  | { skipped: "previous_tick_running" }
  | { skipped: "analytics_reads_disabled"; probed: number }
  | { skipped: null; probed: number; failed: number };

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(error);
  const text = message || code || "Unknown error";
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

export function createFreshnessProbe(deps: FreshnessProbeDeps) {
  let running = false;

  async function probeAll(): Promise<FreshnessProbeTickResult> {
    const now = deps.clock.now();
    try {
      await deps.store.deleteBefore(new Date(now.getTime() - FRESHNESS_PROBE_RETENTION_DAYS * DAY_MS));
    } catch (error) {
      deps.onIssue?.(`retention failed: ${shortError(error)}`);
    }
    const requestedEndDate = utcDate(now.getTime());
    const requestedStartDate = utcDate(now.getTime() - FRESHNESS_PROBE_RANGE_DAYS * DAY_MS);
    let probed = 0;
    let failed = 0;
    for (const { channelId, connectedUserId } of await deps.listChannels()) {
      if (!connectedUserId) continue; // no Google user on this computer: nothing can be asked
      const probedAt = deps.clock.now();
      let newestChannelDate: string | null = null;
      let error: string | null = null;
      try {
        const rows = await deps.queryChannelDays({ channelId, userId: connectedUserId, startDate: requestedStartDate, endDate: requestedEndDate });
        for (const row of rows) if (newestChannelDate === null || row.date > newestChannelDate) newestChannelDate = row.date;
      } catch (caught) {
        if (errorCodeOf(caught) === "analytics_reads_disabled") return { skipped: "analytics_reads_disabled", probed };
        error = shortError(caught);
      }
      try {
        await deps.store.record({ channelId, probedAt, requestedStartDate, requestedEndDate, newestChannelDate, error });
        probed += 1;
        if (error !== null) failed += 1;
      } catch (caught) {
        deps.onIssue?.(`${channelId}: probe not recorded: ${shortError(caught)}`);
      }
    }
    return { skipped: null, probed, failed };
  }

  return {
    async tick(): Promise<FreshnessProbeTickResult> {
      if (running) return { skipped: "previous_tick_running" };
      running = true;
      try {
        return await probeAll();
      } finally {
        running = false;
      }
    },
  };
}
