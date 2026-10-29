import { z } from "zod";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { getChannelExpectedLanguages, getChannelTargetLanguages, getUserTimezone } from "@/lib/db";
import { DomainError, parseWithSchema } from "@/lib/shared-domain";
import { isValidIanaTimezone } from "@/lib/zoned-time";
import { COVERAGE_MAX_DAYS, computePublishingCoverage, todayIn, type CoverageDay, type CoverageSourceVideo, type CoverageSummary } from "./coverage";

// BL-235 (owner, Telegram msgs 3806/3807): the shared publishing-coverage module -- the one answer to "is this publishing day
// covered" for the Content calendar, the weekly plan and the agents (AGENTS.md §M). It imports no feature module (publishing,
// publishing-plans, localization): the per-video calendar rule and the translation rule are shared modules of their own, and the
// channel's time zone comes in through `timeZoneOf` (the composition `src/composition/publishing-coverage.ts` reads the weekly
// plan's zone). A LOCAL read: never a YouTube call.

export {
  addCalendarDays,
  COVERAGE_MAX_DAYS,
  computePublishingCoverage,
  todayIn,
  type CoverageDay,
  type CoverageDayStatus,
  type CoverageDayVideo,
  type CoverageReport,
  type CoverageSourceVideo,
  type CoverageSummary,
} from "./coverage";
export { classifyCalendarVideo, currentRows, type CalendarEntry, type CalendarEntryKind, type CalendarSourceVideo } from "./rules";

/** Where the days' time zone came from: the channel's newest weekly plan, the owner's own zone (Settings), or UTC. */
export type CoverageTimeZoneSource = "publishing_plan" | "owner" | "utc";

export type PublishingCoverageResult = {
  channelId: string;
  /** When this computer last synced the channel's videos (ISO 8601); null when never -- the days are then not to be trusted. */
  asOf: string | null;
  timeZone: string;
  timeZoneSource: CoverageTimeZoneSource;
  /** The channel's tracked languages and its language, as the required translations were read. */
  trackedLanguages: string[];
  channelLanguage: string | null;
  from: string;
  to: string;
  days: CoverageDay[];
  summary: CoverageSummary;
};

export const publishingCoverageInputSchema = z
  .object({
    channelId: z.string().min(1).max(64),
    days: z.number().int().min(1).max(COVERAGE_MAX_DAYS).default(7),
    /** The first day (YYYY-MM-DD in the channel's zone); absent = today there. */
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();
export type PublishingCoverageInput = z.input<typeof publishingCoverageInputSchema>;

export type PublishingCoveragePorts = {
  getChannel(channelId: string): Promise<{ lastSyncedAt: Date | null } | null>;
  listVideos(channelId: string): Promise<CoverageSourceVideo[]>;
  trackedLanguages(channelId: string): Promise<string[]>;
  channelLanguage(channelId: string): Promise<string | null>;
  /** The channel's time zone and where it came from; an invalid zone falls back to UTC. */
  timeZoneOf(channelId: string): Promise<{ timeZone: string; source: CoverageTimeZoneSource }>;
  clock: { now(): Date };
};

export function createPublishingCoverageReads(ports: PublishingCoveragePorts) {
  return {
    async get(input: unknown): Promise<PublishingCoverageResult> {
      const parsed = parseWithSchema(publishingCoverageInputSchema, input, "publishing coverage input");
      const channel = await ports.getChannel(parsed.channelId);
      if (!channel) throw new DomainError({ code: "not_found", message: "This channel has not been synced on this computer", details: { channelId: parsed.channelId } });
      const [videos, trackedLanguages, channelLanguage, zone] = await Promise.all([
        ports.listVideos(parsed.channelId),
        ports.trackedLanguages(parsed.channelId),
        ports.channelLanguage(parsed.channelId),
        ports.timeZoneOf(parsed.channelId),
      ]);
      const { timeZone, source } = isValidIanaTimezone(zone.timeZone) ? zone : { timeZone: "UTC", source: "utc" as const };
      const now = ports.clock.now();
      const report = computePublishingCoverage({
        videos,
        channelSyncedAtMs: channel.lastSyncedAt?.getTime() ?? null,
        trackedLanguages,
        channelLanguage,
        timeZone,
        fromDate: parsed.fromDate ?? todayIn(timeZone, now),
        days: parsed.days,
        now,
      });
      return {
        channelId: parsed.channelId,
        asOf: channel.lastSyncedAt?.toISOString() ?? null,
        timeZone,
        timeZoneSource: source,
        trackedLanguages: [...trackedLanguages].sort(),
        channelLanguage,
        ...report,
      };
    },
  };
}

export type PublishingCoverageReads = ReturnType<typeof createPublishingCoverageReads>;

/** The owner's own zone (Settings), else UTC: the fallback when the channel has no weekly plan. */
export async function ownerTimeZone(): Promise<{ timeZone: string; source: CoverageTimeZoneSource }> {
  const zone = await getUserTimezone().catch(() => null);
  return zone && isValidIanaTimezone(zone) ? { timeZone: zone, source: "owner" } : { timeZone: "UTC", source: "utc" };
}

/** This computer's coverage reads. `timeZoneOf` defaults to the owner's zone; the composition passes the weekly plan's first. */
export function createPublishingCoverageCore(options: { timeZoneOf?: PublishingCoveragePorts["timeZoneOf"] } = {}): PublishingCoverageReads {
  const store = createChannelVideoStoreAdapter();
  return createPublishingCoverageReads({
    getChannel: (channelId) => store.getChannel(channelId),
    async listVideos(channelId) {
      return (await store.listVideosByChannel(channelId)).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        description: video.description,
        privacyStatus: video.privacyStatus,
        publishedAt: video.publishedAt,
        publishAt: video.publishAt,
        liveBroadcastContent: video.liveBroadcastContent ?? null,
        syncedAtMs: video.lastSyncedAt.getTime(),
        defaultLanguage: video.defaultLanguage,
        localizations: video.existingLocalizations,
      }));
    },
    trackedLanguages: (channelId) => getChannelTargetLanguages(channelId),
    channelLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage,
    timeZoneOf: options.timeZoneOf ?? (() => ownerTimeZone()),
    clock: { now: () => new Date() },
  });
}
