import type { StoredPublishingUpload } from "@/lib/db";
import type { CoveragePreRead, CoverageSourceVideo, PublishingCoverageResult } from "@/lib/publishing-coverage";
import { buildPublishingCalendar, currentRows, PUBLISHING_REMINDER_DAYS, type CalendarEntry, type PublishingCoverage } from "./calendar";

// BL-182 stage 1: the calendar and the reminder read from the local copy of the channel's videos -- never a YouTube call. The data
// age (`lastSyncedAt`) always comes with them, so a stale copy is never shown as current (FO-REQ-0023 §4 C3, D4).

export type PublishingCalendarResult = {
  channelId: string;
  lastSyncedAt: string | null;
  entries: CalendarEntry[];
  coverage: PublishingCoverage;
  /**
   * BL-235: the next 14 days in the channel's time zone, each covered / missing_translations / gap (the shared coverage); null
   * when it was not wired or its read failed -- the calendar then keeps its own gaps.
   */
  dayCoverage: PublishingCoverageResult | null;
};

export type PublishingAlert = { channelId: string; lastSyncedAt: string | null } & PublishingCoverage;

/** The agents' and the Producer's view (`agent_get_publishing_calendar`): a window around today, days as UTC dates. */
export type AgentPublishingCalendar = {
  channelId: string;
  lastSyncedAt: string | null;
  window: { from: string; to: string };
  coverage: PublishingCoverage;
  /** Published, scheduled and overdue videos dated inside the window, oldest first. */
  entries: CalendarEntry[];
  /** Private videos without a date (any upload date). */
  unscheduled: CalendarEntry[];
  /**
   * Today and the next 13 days that are not covered. With the daily coverage (BL-235, Agent API 4.13.0): dates in the channel's
   * zone (`gapDatesTimeZone`) whose status is not `covered` (no release, or a release missing translations); without it: UTC
   * dates with no published, scheduled or pending video.
   */
  gapDates: string[];
  /** BL-235: those of `gapDates` that have a release missing translations; null without the daily coverage. */
  missingTranslationDates: string[] | null;
  /** The zone `gapDates` are dates in: the channel's, or "UTC" without the daily coverage. */
  gapDatesTimeZone: string;
  /** BL-182 stage 2 (FO-REQ-0023 §4 C4): the release packages in this computer's copy of the workspace, and this computer's uploads. */
  packages: AgentPackages;
  uploads: AgentUpload[];
};

export type AgentPackages =
  | { status: "no_workspace" | "unavailable" }
  | {
      status: "ok";
      items: Array<{ video: string | null; title: string | null; plannedPublishDate: string | null; state: string; problems: string[]; videoId: string | null }>;
    };
export type AgentUpload = {
  video: string;
  status: string;
  publishAt: string | null;
  videoId: string | null;
  pausedReason: string | null;
  errorCode: string | null;
  /** BL-209 (Agent API 3.20.0, Producer 1.10.0): queued by the owner's automatic-upload switch (private, no date), not an approval. */
  automatic: boolean;
  /** Bytes YouTube stored / the video's size, as a whole percent (rounded down); null when the size is unknown (0). */
  progressPercent: number | null;
  /** When the upload ended (done, failed or cancelled), ISO 8601; null while it is under way. */
  finishedAt: string | null;
};

/** BL-209: an upload's progress as the agents see it -- floor(stored / total * 100), at most 100; null when the total is unknown. */
export function uploadProgressPercent(storedBytes: number, totalBytes: number): number | null {
  if (!(totalBytes > 0)) return null;
  return Math.min(100, Math.max(0, Math.floor((storedBytes / totalBytes) * 100)));
}

/** The agents' view of one upload row of this computer (`agent_get_publishing_calendar`'s `uploads`). */
export function agentUploadOf(
  row: Pick<StoredPublishingUpload, "video" | "status" | "publishAt" | "videoId" | "pausedReason" | "errorCode" | "automatic" | "storedBytes" | "totalBytes" | "finishedAt">
): AgentUpload {
  return {
    video: row.video,
    status: row.status,
    publishAt: row.publishAt,
    videoId: row.videoId,
    pausedReason: row.pausedReason,
    errorCode: row.errorCode,
    automatic: row.automatic,
    progressPercent: uploadProgressPercent(row.storedBytes, row.totalBytes),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export type PublishingCalendarDeps = {
  /** The channel's rows; with their language fields (BL-235) the daily coverage reuses them. */
  listVideos(channelId: string): Promise<CoverageSourceVideo[]>;
  /** Fails closed unless `channelId` is the caller's active channel (AGENTS.md §F); used by the agent read only. */
  assertActiveChannel?(args: { userId: string | null; channelId: string }): Promise<void>;
  getChannel(channelId: string): Promise<{ lastSyncedAt: Date | null } | null>;
  clock: { now(): Date };
  thresholdDays?: number;
  /**
   * BL-235: the shared daily coverage (`@/lib/publishing-coverage`, with the channel's zone); absent = the older reminder rule. It
   * gets the rows and the sync time already read here (review item 2: read once).
   */
  dailyCoverage?(channelId: string, days: number, preRead: CoveragePreRead): Promise<PublishingCoverageResult>;
  /** BL-182 stage 2: the agent read's packages and uploads (absent: none listed). */
  packages?(channelId: string): Promise<AgentPackages>;
  uploads?(channelId: string): Promise<AgentUpload[]>;
};

/** The calendar's gap window: today and the next 13 days (FO-REQ-0023 §4 C1). */
const CALENDAR_GAP_DAYS = 14;

export function createPublishingCalendarReads(deps: PublishingCalendarDeps) {
  const threshold = deps.thresholdDays ?? PUBLISHING_REMINDER_DAYS;
  /** The daily coverage, or null when not wired or failed: a broken coverage never takes the calendar down (AGENTS.md §M). */
  async function readDailyCoverage(channelId: string, days: number, preRead: CoveragePreRead): Promise<PublishingCoverageResult | null> {
    if (!deps.dailyCoverage) return null;
    try {
      return await deps.dailyCoverage(channelId, days, preRead);
    } catch {
      return null;
    }
  }
  /** BL-235 (owner msg 3806): with the daily coverage, the reminder is "fewer than `threshold` covered days in a row from today". */
  function withDailyDue(coverage: PublishingCoverage, daily: PublishingCoverageResult | null): PublishingCoverage {
    if (!daily) return coverage;
    const inARow = daily.summary.coveredDaysInARow;
    return { ...coverage, due: inARow < threshold, coveredDaysInARow: inARow };
  }
  return {
    async getCalendar(input: { channelId: string }): Promise<PublishingCalendarResult> {
      const [videos, channel] = await Promise.all([deps.listVideos(input.channelId), deps.getChannel(input.channelId)]);
      const dayCoverage = await readDailyCoverage(input.channelId, Math.max(threshold, CALENDAR_GAP_DAYS), { channel, videos });
      const { entries, coverage } = buildPublishingCalendar(currentRows(videos, channel?.lastSyncedAt?.getTime() ?? null), deps.clock.now(), threshold);
      return { channelId: input.channelId, lastSyncedAt: channel?.lastSyncedAt?.toISOString() ?? null, entries, coverage: withDailyDue(coverage, dayCoverage), dayCoverage };
    },
    /**
     * BL-182 stage 1 (FO-REQ-0023 §4 C4): the read-only calendar for agents and the Producer -- the past and the next 14 days, the
     * undated uploads, the coverage and the gaps. A local read; the caller's active channel only.
     */
    async getAgentCalendar(input: { credentialRef: unknown; channelId: string }): Promise<AgentPublishingCalendar> {
      const userId =
        input.credentialRef !== null && typeof input.credentialRef === "object" && typeof (input.credentialRef as { userId?: unknown }).userId === "string"
          ? (input.credentialRef as { userId: string }).userId
          : null;
      if (!deps.assertActiveChannel) throw new Error("The publishing calendar read needs the active-channel check.");
      await deps.assertActiveChannel({ userId, channelId: input.channelId });
      const now = deps.clock.now();
      const { channelId, lastSyncedAt, entries, coverage, dayCoverage } = await this.getCalendar({ channelId: input.channelId });
      const dayMs = 86_400_000;
      const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const fromMs = todayUtc - 14 * dayMs;
      const toMs = todayUtc + 15 * dayMs; // through the end of the 14th day ahead
      const dated = entries.filter((entry) => entry.at !== null && Date.parse(entry.at) >= fromMs && Date.parse(entry.at) < toMs);
      // BL-235 review item 3: with the daily coverage, the gaps are its days that are not covered (the channel's dates, the
      // translation check included) -- one answer with `coverage.due`; without it, UTC days without a release (the older rule).
      let gapDates: string[];
      let missingTranslationDates: string[] | null = null;
      if (dayCoverage) {
        gapDates = dayCoverage.days.filter((day) => day.status !== "covered").map((day) => day.date);
        missingTranslationDates = dayCoverage.days.filter((day) => day.status === "missing_translations").map((day) => day.date);
      } else {
        const filledDays = new Set(
          dated.filter((entry) => entry.kind === "published" || entry.kind === "scheduled" || entry.kind === "published_pending").map((entry) => (entry.at as string).slice(0, 10))
        );
        gapDates = [];
        for (let offset = 0; offset < 14; offset += 1) {
          const day = new Date(todayUtc + offset * dayMs).toISOString().slice(0, 10);
          if (!filledDays.has(day)) gapDates.push(day);
        }
      }
      return {
        channelId,
        lastSyncedAt,
        window: { from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs - dayMs).toISOString().slice(0, 10) },
        coverage,
        entries: dated,
        unscheduled: entries.filter((entry) => entry.kind === "unscheduled"),
        gapDates,
        missingTranslationDates,
        gapDatesTimeZone: dayCoverage ? dayCoverage.timeZone : "UTC",
        packages: deps.packages ? await deps.packages(channelId).catch((): AgentPackages => ({ status: "unavailable" })) : { status: "unavailable" },
        uploads: deps.uploads ? await deps.uploads(channelId) : [],
      };
    },

    /** The reminder alone (the badge and the bell): a channel never synced has no alert rather than a false one. */
    async getAlert(input: { channelId: string }): Promise<PublishingAlert | null> {
      const channel = await deps.getChannel(input.channelId);
      if (!channel?.lastSyncedAt) return null;
      const videos = await deps.listVideos(input.channelId);
      const daily = await readDailyCoverage(input.channelId, threshold, { channel, videos });
      const { coverage } = buildPublishingCalendar(currentRows(videos, channel.lastSyncedAt.getTime()), deps.clock.now(), threshold);
      return { channelId: input.channelId, lastSyncedAt: channel.lastSyncedAt.toISOString(), ...withDailyDue(coverage, daily) };
    },
  };
}

export type PublishingCalendarReads = ReturnType<typeof createPublishingCalendarReads>;
