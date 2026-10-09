import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import { z } from "zod";
import { DomainError, type ResolvedCredentials } from "./contracts";
import { parseWithSchema } from "./schemas";
import { toPacificCalendarDate } from "./comparable-age";
import { hasFinalPublishDate, type MilestoneVideo } from "./milestones";
import { failureKind } from "./query-failure";
import { labelDeviceType, labelTrafficSource } from "./breakdown-labels";

/**
 * BL-168 (FO-REQ-0015 item 2, docs/roadmap/plans/VIDEO_BREAKDOWNS_PLAN.md): traffic sources and devices per day, stored for each own
 * video's first 90 days and for the channel as a whole, so an agent reads them locally instead of asking YouTube live. Values are kept as
 * YouTube returned them (own-channel Analytics data, III.E.4.b); a read only sums them over the days asked for.
 *
 * Its own service next to the milestones: the same credentials, reads switch, quota reserve and failure rules (`query-failure.ts`), none
 * of the daily-row logic.
 */

export const BREAKDOWN_KINDS = ["traffic_source", "device_type"] as const;
export type BreakdownKind = (typeof BREAKDOWN_KINDS)[number];
/** Checked live 2026-10-10 (plan §1): both return rows per video (`video==<id>` filter) and per channel. */
export const BREAKDOWN_DIMENSIONS: Readonly<Record<BreakdownKind, string>> = {
  traffic_source: "day,insightTrafficSourceType",
  device_type: "day,deviceType",
};
export const BREAKDOWN_METRICS = ["views", "estimatedMinutesWatched"] as const;
/** A video's window: its first 90 days, the Pacific publish date .. +89. */
export const VIDEO_BREAKDOWN_WINDOW_DAYS = 90;
/** The channel's first collection reaches this many days back (latest day included). */
export const CHANNEL_BREAKDOWN_FIRST_DAYS = 90;
/** YouTube revises recent days: each collection reads the last 7 days of its range again. */
export const BREAKDOWN_REREAD_DAYS = 7;
/** Subjects (the channel or one video, 2 queries each) per channel per run; a larger backlog finishes over the next runs. */
export const MAX_BREAKDOWN_SUBJECTS_PER_RUN = 50;
export const MAX_BREAKDOWN_ATTEMPTS = 3;
export const BREAKDOWN_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** The state row of the channel as a whole; every other subject is a video id. */
export const CHANNEL_SUBJECT = "channel";

function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The window of a video published at `publishedAt` (Pacific dates, inclusive). */
export function videoBreakdownWindow(publishedAt: string): { windowStart: string; windowEnd: string } {
  const windowStart = toPacificCalendarDate(publishedAt);
  return { windowStart, windowEnd: shiftIsoDate(windowStart, VIDEO_BREAKDOWN_WINDOW_DAYS - 1) };
}

export type BreakdownState = {
  subject: string;
  rangeStart: string;
  collectedThrough: string | null;
  /** The Pacific date of the last successful collection. */
  collectedOn: string | null;
  status: "collected" | "retry" | "failed";
  nextAttemptAt: Date | null;
};

export type PlannedBreakdown = {
  /** `CHANNEL_SUBJECT` or the video id. */
  subject: string;
  videoId: string | null;
  rangeStart: string;
  from: string;
  to: string;
  /** No usable earlier collection for this range: every stored row of the subject is replaced. */
  fresh: boolean;
};

/**
 * The subjects to collect now, at most `max`: the channel first, then videos by publish date, newest first (current uploads are never
 * starved by the history backlog). A subject is due when its range has a day later than what is stored, or -- for a video whose window
 * has ended -- once for the final reread on or after window end + 7. A stored range for another window start (the publish date moved)
 * counts as never collected. `failed` subjects are never planned; a `retry` waits for its time.
 */
export function planDueBreakdowns(
  videos: MilestoneVideo[],
  states: BreakdownState[],
  now: Date,
  max: number = MAX_BREAKDOWN_SUBJECTS_PER_RUN
): PlannedBreakdown[] {
  const today = toPacificCalendarDate(now.toISOString());
  const latest = shiftIsoDate(today, -1);
  const stateOf = new Map(states.map((state) => [state.subject, state]));

  const consider = (subject: string, videoId: string | null, rangeStart: string, windowEnd: string | null): PlannedBreakdown | null => {
    const through = windowEnd !== null && windowEnd < latest ? windowEnd : latest;
    if (through < rangeStart) return null;
    const stored = stateOf.get(subject);
    const state = stored && stored.rangeStart === rangeStart ? stored : undefined;
    if (state?.status === "failed") return null;
    if (state?.status === "retry" && state.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) return null;
    const collectedThrough = state?.collectedThrough ?? null;
    if (collectedThrough === null) return { subject, videoId, rangeStart, from: rangeStart, to: through, fresh: true };
    const newDay = through > collectedThrough;
    const settledOn = windowEnd === null ? null : shiftIsoDate(windowEnd, BREAKDOWN_REREAD_DAYS);
    const finalPass =
      settledOn !== null && collectedThrough === windowEnd && today >= settledOn && (state?.collectedOn ?? "") < settledOn;
    if (!newDay && !finalPass) return null;
    const dayAfter = shiftIsoDate(collectedThrough, 1);
    const reread = shiftIsoDate(through, -(BREAKDOWN_REREAD_DAYS - 1));
    const earlier = dayAfter < reread ? dayAfter : reread;
    return { subject, videoId, rangeStart, from: earlier > rangeStart ? earlier : rangeStart, to: through, fresh: false };
  };

  const plan: PlannedBreakdown[] = [];
  const channelState = stateOf.get(CHANNEL_SUBJECT);
  const channel = consider(CHANNEL_SUBJECT, null, channelState?.rangeStart ?? shiftIsoDate(latest, -(CHANNEL_BREAKDOWN_FIRST_DAYS - 1)), null);
  if (channel) plan.push(channel);

  const dated = videos
    .filter(hasFinalPublishDate)
    .map((video) => ({ video, at: Date.parse(video.publishedAt as string) }))
    .sort((a, b) => b.at - a.at || a.video.videoId.localeCompare(b.video.videoId));
  for (const { video } of dated) {
    const window = videoBreakdownWindow(video.publishedAt as string);
    const planned = consider(video.videoId, video.videoId, window.windowStart, window.windowEnd);
    if (planned) plan.push(planned);
  }
  return plan.slice(0, max);
}

export type BreakdownRowValue = { day: string; value: string; views: number | null; estimatedMinutesWatched: number | null };

type ReportRow = { dimensionValues: string[]; metrics: Record<string, number> };

function metricOrNull(row: ReportRow, name: string): number | null {
  const value = row.metrics[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Rows of the range only, one per (day, value) -- a repeated pair keeps YouTube's last one. */
export function toBreakdownRows(rows: ReportRow[], from: string, to: string): BreakdownRowValue[] {
  const byKey = new Map<string, BreakdownRowValue>();
  for (const row of rows) {
    const [day, value] = row.dimensionValues;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || day < from || day > to || !value) continue;
    byKey.set(`${day}|${value}`, { day, value, views: metricOrNull(row, "views"), estimatedMinutesWatched: metricOrNull(row, "estimatedMinutesWatched") });
  }
  return [...byKey.values()];
}

export type StoredBreakdownRow = BreakdownRowValue & { subject: string; breakdown: BreakdownKind };

export type StoredBreakdownStateRow = BreakdownState & { attempts: number; lastError: string | null; collectedAt: Date | null };

export type BreakdownDependencies = {
  clock: { now(): Date };
  authResolver: { resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials> };
  channelAccess: { assertActiveChannel(args: { userId: string | null | undefined; channelId: string }): Promise<string> };
  videoStore: { listVideos(channelId: string): Promise<MilestoneVideo[]> };
  youtubeApi: {
    queryChannelBreakdownReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      dimensions?: string;
      metricNames: readonly string[];
      filters?: string;
    }): Promise<ReportRow[]>;
  };
  store: {
    listStates(channelId: string): Promise<StoredBreakdownStateRow[]>;
    /** Replaces the subject's rows in from..to (every row when `fresh`) with the answer and records the range, atomically. */
    saveCollected(row: {
      channelId: string;
      subject: string;
      videoId: string | null;
      rangeStart: string;
      from: string;
      to: string;
      fresh: boolean;
      rows: Record<BreakdownKind, BreakdownRowValue[]>;
      collectedOn: string;
      at: Date;
    }): Promise<void>;
    /** Puts a subject back until `retryAt` without counting an attempt. */
    defer(row: { channelId: string; subject: string; rangeStart: string; error: string; at: Date; retryAt: Date }): Promise<void>;
    recordFailure(row: {
      channelId: string;
      subject: string;
      rangeStart: string;
      error: string;
      at: Date;
      retryAt: Date;
      maxAttempts: number;
    }): Promise<"retry" | "failed">;
    listRows(channelId: string, subjects: string[], startDate: string, endDate: string): Promise<StoredBreakdownRow[]>;
  };
};

const credentialRefSchema = z.object({ userId: z.string().min(1) }).strict();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date, YYYY-MM-DD");
export const MAX_BREAKDOWN_READ_DAYS = 92;
export const collectDueBreakdownsInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();
export const listStoredBreakdownsInputSchema = z
  .object({
    channelId: z.string().min(1),
    credentialRef: credentialRefSchema.optional(),
    videoIds: z.array(z.string().min(1)).min(1).max(20).optional(),
    startDate: isoDate,
    endDate: isoDate,
    groupBy: z.enum(["total", "day"]).optional(),
  })
  .strict()
  .refine((input) => input.startDate <= input.endDate, { message: "startDate must not be after endDate" })
  .refine((input) => Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`) <= (MAX_BREAKDOWN_READ_DAYS - 1) * 86_400_000, {
    message: `at most ${MAX_BREAKDOWN_READ_DAYS} days`,
  });

export type BreakdownReadRow = { day?: string; value: string; label: string; views: number | null; estimatedMinutesWatched: number | null };
export type StoredBreakdownSubject = {
  /** Stored days (the subject's range start .. the last collected day) and when they were last read; null when never collected. */
  coverage: { from: string; through: string; collectedAt: string | null } | null;
  status: "collected" | "retry" | "failed" | "not_collected";
  lastError: string | null;
  trafficSources: BreakdownReadRow[];
  devices: BreakdownReadRow[];
};
export type ListStoredBreakdownsResult = {
  channelId: string;
  startDate: string;
  endDate: string;
  groupBy: "total" | "day";
  channel?: StoredBreakdownSubject;
  videos?: Array<StoredBreakdownSubject & { videoId: string; publishedAt: string; window: { start: string; end: string } }>;
};

function userIdOf(credentialRef: unknown): string | null {
  return credentialRef && typeof credentialRef === "object" && typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

function addOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

const LABEL_OF: Record<BreakdownKind, (values: string[]) => string> = { traffic_source: labelTrafficSource, device_type: labelDeviceType };

/** Rows of one subject and breakdown, as stored (by day) or summed per value over the days asked for (most views first). */
function shapeRows(rows: StoredBreakdownRow[], kind: BreakdownKind, groupBy: "total" | "day"): BreakdownReadRow[] {
  const label = LABEL_OF[kind];
  const byViews = (a: BreakdownReadRow, b: BreakdownReadRow) => (b.views ?? -1) - (a.views ?? -1) || a.value.localeCompare(b.value);
  if (groupBy === "day") {
    return rows
      .map((row) => ({ day: row.day, value: row.value, label: label([row.value]), views: row.views, estimatedMinutesWatched: row.estimatedMinutesWatched }))
      .sort((a, b) => a.day.localeCompare(b.day) || byViews(a, b));
  }
  const totals = new Map<string, BreakdownReadRow>();
  for (const row of rows) {
    const total = totals.get(row.value) ?? { value: row.value, label: label([row.value]), views: null, estimatedMinutesWatched: null };
    total.views = addOrNull(total.views, row.views);
    total.estimatedMinutesWatched = addOrNull(total.estimatedMinutesWatched, row.estimatedMinutesWatched);
    totals.set(row.value, total);
  }
  return [...totals.values()].sort(byViews);
}

export function createBreakdownServices(deps: BreakdownDependencies) {
  return {
    /**
     * Collects the channel's due subjects (at most MAX_BREAKDOWN_SUBJECTS_PER_RUN, 2 queries each). A subject is saved only when both of
     * its queries answered. Failures follow the milestone rules (`query-failure.ts`): `stop` ends the run with nothing written, `defer`
     * puts the subject back by a day and ends the run, `attempt` counts one of its 3 attempts and the run goes on.
     */
    async collectDueBreakdowns(input: unknown): Promise<{ attempted: number; collected: number; failed: number }> {
      const parsed = parseWithSchema(collectDueBreakdownsInputSchema, input, "collect due breakdowns input");
      await deps.channelAccess.assertActiveChannel({ userId: parsed.credentialRef.userId, channelId: parsed.channelId });
      const now = deps.clock.now();
      const [videos, states] = await Promise.all([deps.videoStore.listVideos(parsed.channelId), deps.store.listStates(parsed.channelId)]);
      const plan = planDueBreakdowns(videos, states, now);
      if (plan.length === 0) return { attempted: 0, collected: 0, failed: 0 };
      const credentials = await deps.authResolver.resolve({ credentialRef: parsed.credentialRef, requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE] });
      const collectedOn = toPacificCalendarDate(now.toISOString());
      let collected = 0;
      let failed = 0;
      for (const item of plan) {
        try {
          const rows = {} as Record<BreakdownKind, BreakdownRowValue[]>;
          for (const kind of BREAKDOWN_KINDS) {
            const answer = await deps.youtubeApi.queryChannelBreakdownReport({
              credentials,
              channelId: parsed.channelId,
              startDate: item.from,
              endDate: item.to,
              dimensions: BREAKDOWN_DIMENSIONS[kind],
              metricNames: BREAKDOWN_METRICS,
              ...(item.videoId ? { filters: `video==${item.videoId}` } : {}),
            });
            rows[kind] = toBreakdownRows(answer, item.from, item.to);
          }
          await deps.store.saveCollected({
            channelId: parsed.channelId,
            subject: item.subject,
            videoId: item.videoId,
            rangeStart: item.rangeStart,
            from: item.from,
            to: item.to,
            fresh: item.fresh,
            rows,
            collectedOn,
            at: deps.clock.now(),
          });
          collected += 1;
        } catch (error) {
          const kind = failureKind(error);
          if (kind === "stop") throw error;
          const at = deps.clock.now();
          const failure = {
            channelId: parsed.channelId,
            subject: item.subject,
            rangeStart: item.rangeStart,
            error: error instanceof Error ? error.message : String(error),
            at,
            retryAt: new Date(at.getTime() + BREAKDOWN_RETRY_AFTER_MS),
          };
          if (kind === "defer") {
            await deps.store.defer(failure);
            throw error;
          }
          failed += 1;
          await deps.store.recordFailure({ ...failure, maxAttempts: MAX_BREAKDOWN_ATTEMPTS });
        }
      }
      return { attempted: plan.length, collected, failed };
    },

    /**
     * The stored breakdowns of the session channel (without `videoIds`) or of its videos, for startDate..endDate. Local only. A video
     * of another channel, without a final publish date, or never synced is not listed; rows of a range collected for another window
     * start (the publish date moved) are not returned until it is collected again.
     */
    async listStoredBreakdowns(input: unknown): Promise<ListStoredBreakdownsResult> {
      const parsed = parseWithSchema(listStoredBreakdownsInputSchema, input, "list stored breakdowns input");
      await deps.channelAccess.assertActiveChannel({ userId: userIdOf(parsed.credentialRef), channelId: parsed.channelId });
      const groupBy = parsed.groupBy ?? "total";
      const states = new Map((await deps.store.listStates(parsed.channelId)).map((state) => [state.subject, state]));

      const subjectOf = (subject: string, rangeStart: string, rows: StoredBreakdownRow[]): StoredBreakdownSubject => {
        const stored = states.get(subject);
        const state = stored && stored.rangeStart === rangeStart ? stored : undefined;
        const current = state?.collectedThrough ? rows.filter((row) => row.subject === subject && row.day >= rangeStart && row.day <= (state.collectedThrough as string)) : [];
        return {
          coverage: state?.collectedThrough ? { from: state.rangeStart, through: state.collectedThrough, collectedAt: state.collectedAt ? state.collectedAt.toISOString() : null } : null,
          status: state ? state.status : "not_collected",
          lastError: state?.lastError ?? null,
          trafficSources: shapeRows(current.filter((row) => row.breakdown === "traffic_source"), "traffic_source", groupBy),
          devices: shapeRows(current.filter((row) => row.breakdown === "device_type"), "device_type", groupBy),
        };
      };
      const base = { channelId: parsed.channelId, startDate: parsed.startDate, endDate: parsed.endDate, groupBy };

      if (!parsed.videoIds) {
        const rows = await deps.store.listRows(parsed.channelId, [CHANNEL_SUBJECT], parsed.startDate, parsed.endDate);
        const rangeStart = states.get(CHANNEL_SUBJECT)?.rangeStart ?? "";
        return { ...base, channel: subjectOf(CHANNEL_SUBJECT, rangeStart, rows) };
      }

      const wanted = new Set(parsed.videoIds);
      const videos = (await deps.videoStore.listVideos(parsed.channelId)).filter((video) => wanted.has(video.videoId) && hasFinalPublishDate(video));
      const rows = await deps.store.listRows(parsed.channelId, videos.map((video) => video.videoId), parsed.startDate, parsed.endDate);
      return {
        ...base,
        videos: videos.map((video) => {
          const window = videoBreakdownWindow(video.publishedAt as string);
          return {
            videoId: video.videoId,
            publishedAt: video.publishedAt as string,
            window: { start: window.windowStart, end: window.windowEnd },
            ...subjectOf(video.videoId, window.windowStart, rows),
          };
        }),
      };
    },
  };
}

export type BreakdownServices = ReturnType<typeof createBreakdownServices>;

/** AC-VB-14: the background gate -- while less than the configured reserve of the Analytics quota is left, nothing is queried. */
export function gateBreakdownCollection(
  guard: { isBackgroundReadAllowed(service: "analytics"): Promise<boolean> },
  collect: BreakdownServices["collectDueBreakdowns"]
): BreakdownServices["collectDueBreakdowns"] {
  return async (input) => ((await guard.isBackgroundReadAllowed("analytics")) ? collect(input) : { attempted: 0, collected: 0, failed: 0 });
}
export { DomainError };
