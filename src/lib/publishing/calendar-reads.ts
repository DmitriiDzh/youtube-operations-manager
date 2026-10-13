import { buildPublishingCalendar, PUBLISHING_REMINDER_DAYS, type CalendarEntry, type CalendarSourceVideo, type PublishingCoverage } from "./calendar";

// BL-182 stage 1: the calendar and the reminder read from the local copy of the channel's videos -- never a YouTube call. The data
// age (`lastSyncedAt`) always comes with them, so a stale copy is never shown as current (FO-REQ-0023 §4 C3, D4).

export type PublishingCalendarResult = {
  channelId: string;
  lastSyncedAt: string | null;
  entries: CalendarEntry[];
  coverage: PublishingCoverage;
};

export type PublishingAlert = { channelId: string; lastSyncedAt: string | null } & PublishingCoverage;

export type PublishingCalendarDeps = {
  listVideos(channelId: string): Promise<CalendarSourceVideo[]>;
  getChannel(channelId: string): Promise<{ lastSyncedAt: Date | null } | null>;
  clock: { now(): Date };
  thresholdDays?: number;
};

export function createPublishingCalendarReads(deps: PublishingCalendarDeps) {
  const threshold = deps.thresholdDays ?? PUBLISHING_REMINDER_DAYS;
  return {
    async getCalendar(input: { channelId: string }): Promise<PublishingCalendarResult> {
      const [videos, channel] = await Promise.all([deps.listVideos(input.channelId), deps.getChannel(input.channelId)]);
      const { entries, coverage } = buildPublishingCalendar(videos, deps.clock.now(), threshold);
      return { channelId: input.channelId, lastSyncedAt: channel?.lastSyncedAt?.toISOString() ?? null, entries, coverage };
    },
    /** The reminder alone (the badge and the bell): a channel never synced has no alert rather than a false one. */
    async getAlert(input: { channelId: string }): Promise<PublishingAlert | null> {
      const channel = await deps.getChannel(input.channelId);
      if (!channel?.lastSyncedAt) return null;
      const { coverage } = buildPublishingCalendar(await deps.listVideos(input.channelId), deps.clock.now(), threshold);
      return { channelId: input.channelId, lastSyncedAt: channel.lastSyncedAt.toISOString(), ...coverage };
    },
  };
}

export type PublishingCalendarReads = ReturnType<typeof createPublishingCalendarReads>;
