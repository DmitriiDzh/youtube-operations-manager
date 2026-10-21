import type { StoredPublishingUpload } from "@/lib/db";
import { buildPublishingCalendar, currentRows, PUBLISHING_REMINDER_DAYS, type CalendarEntry, type CalendarSourceVideo, type PublishingCoverage } from "./calendar";

// BL-182 stage 1: the calendar and the reminder read from the local copy of the channel's videos -- never a YouTube call. The data
// age (`lastSyncedAt`) always comes with them, so a stale copy is never shown as current (FO-REQ-0023 §4 C3, D4).

export type PublishingCalendarResult = {
  channelId: string;
  lastSyncedAt: string | null;
  entries: CalendarEntry[];
  coverage: PublishingCoverage;
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
  /** UTC dates from today through the next 13 days with no published or scheduled video. */
  gapDates: string[];
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
  listVideos(channelId: string): Promise<CalendarSourceVideo[]>;
  /** Fails closed unless `channelId` is the caller's active channel (AGENTS.md §F); used by the agent read only. */
  assertActiveChannel?(args: { userId: string | null; channelId: string }): Promise<void>;
  getChannel(channelId: string): Promise<{ lastSyncedAt: Date | null } | null>;
  clock: { now(): Date };
  thresholdDays?: number;
  /** BL-182 stage 2: the agent read's packages and uploads (absent: none listed). */
  packages?(channelId: string): Promise<AgentPackages>;
  uploads?(channelId: string): Promise<AgentUpload[]>;
};

export function createPublishingCalendarReads(deps: PublishingCalendarDeps) {
  const threshold = deps.thresholdDays ?? PUBLISHING_REMINDER_DAYS;
  return {
    async getCalendar(input: { channelId: string }): Promise<PublishingCalendarResult> {
      const [videos, channel] = await Promise.all([deps.listVideos(input.channelId), deps.getChannel(input.channelId)]);
      const { entries, coverage } = buildPublishingCalendar(currentRows(videos, channel?.lastSyncedAt?.getTime() ?? null), deps.clock.now(), threshold);
      return { channelId: input.channelId, lastSyncedAt: channel?.lastSyncedAt?.toISOString() ?? null, entries, coverage };
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
      const { channelId, lastSyncedAt, entries, coverage } = await this.getCalendar({ channelId: input.channelId });
      const dayMs = 86_400_000;
      const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const fromMs = todayUtc - 14 * dayMs;
      const toMs = todayUtc + 15 * dayMs; // through the end of the 14th day ahead
      const dated = entries.filter((entry) => entry.at !== null && Date.parse(entry.at) >= fromMs && Date.parse(entry.at) < toMs);
      const filledDays = new Set(dated.filter((entry) => entry.kind === "published" || entry.kind === "scheduled").map((entry) => (entry.at as string).slice(0, 10)));
      const gapDates: string[] = [];
      for (let offset = 0; offset < 14; offset += 1) {
        const day = new Date(todayUtc + offset * dayMs).toISOString().slice(0, 10);
        if (!filledDays.has(day)) gapDates.push(day);
      }
      return {
        channelId,
        lastSyncedAt,
        window: { from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs - dayMs).toISOString().slice(0, 10) },
        coverage,
        entries: dated,
        unscheduled: entries.filter((entry) => entry.kind === "unscheduled"),
        gapDates,
        packages: deps.packages ? await deps.packages(channelId).catch((): AgentPackages => ({ status: "unavailable" })) : { status: "unavailable" },
        uploads: deps.uploads ? await deps.uploads(channelId) : [],
      };
    },

    /** The reminder alone (the badge and the bell): a channel never synced has no alert rather than a false one. */
    async getAlert(input: { channelId: string }): Promise<PublishingAlert | null> {
      const channel = await deps.getChannel(input.channelId);
      if (!channel?.lastSyncedAt) return null;
      const { coverage } = buildPublishingCalendar(currentRows(await deps.listVideos(input.channelId), channel.lastSyncedAt.getTime()), deps.clock.now(), threshold);
      return { channelId: input.channelId, lastSyncedAt: channel.lastSyncedAt.toISOString(), ...coverage };
    },
  };
}

export type PublishingCalendarReads = ReturnType<typeof createPublishingCalendarReads>;
