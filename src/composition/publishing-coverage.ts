import {
  createPublishingCoverageCore,
  ownerTimeZone,
  type CoveragePreRead,
  type CoverageTimeZoneSource,
  type PublishingCoverageReads,
} from "@/lib/publishing-coverage";
import { isValidIanaTimezone } from "@/lib/zoned-time";

/**
 * BL-235 (owner msgs 3806/3807, AGENTS.md §M): the publishing coverage with the channel's time zone and its live broadcasts,
 * composed at the app layer -- the shared publishing-coverage module imports no feature module. The channel's zone is the one its
 * weekly publishing plans are kept in (the newest week's `timeZone`, WEEKLY_PUBLISHING_PLAN.md: "slots in the channel's time
 * zone"); no plan, an invalid zone or a failed plan read falls back to the owner's own zone (Settings), then UTC. Used by the
 * Content calendar, the publishing reminder, «План недели» and the agents' coverage tools. Local reads only.
 */

type Zone = { timeZone: string; source: CoverageTimeZoneSource };

/** How long a channel's resolved zone is kept (review item 2: the alerts poll every channel every minute). */
export const CHANNEL_ZONE_TTL_MS = 5 * 60_000;

/**
 * A per-channel cache of the resolved zone. `readPlanZone` is the plan store read (the newest plan's zone, or null); it is not
 * called again for a channel within `ttlMs`, unless `invalidate(channelId)` (a plan of that channel was saved here).
 */
export function createChannelZoneCache(deps: {
  readPlanZone(channelId: string): Promise<string | null>;
  ownerZone(): Promise<Zone>;
  nowMs(): number;
  ttlMs?: number;
}) {
  const ttl = deps.ttlMs ?? CHANNEL_ZONE_TTL_MS;
  const cache = new Map<string, { zone: Zone; at: number }>();
  return {
    async get(channelId: string): Promise<Zone> {
      const hit = cache.get(channelId);
      if (hit && deps.nowMs() - hit.at < ttl) return hit.zone;
      let planZone: string | null = null;
      try {
        planZone = await deps.readPlanZone(channelId);
      } catch {
        // Not connected here, or the plans module failed: the coverage still answers, in the owner's zone (§M).
      }
      const zone: Zone = planZone && isValidIanaTimezone(planZone) ? { timeZone: planZone, source: "publishing_plan" } : await deps.ownerZone();
      cache.set(channelId, { zone, at: deps.nowMs() });
      return zone;
    },
    invalidate(channelId: string): void {
      cache.delete(channelId);
    },
  };
}

const holder = globalThis as typeof globalThis & { [key: symbol]: ReturnType<typeof createChannelZoneCache> | undefined };
const ZONE_CACHE_KEY = Symbol.for("ytom.publishingCoverage.zoneCache");

function zoneCache(): ReturnType<typeof createChannelZoneCache> {
  holder[ZONE_CACHE_KEY] ??= createChannelZoneCache({
    async readPlanZone(channelId) {
      const { createPublishingPlansAgentCore } = await import("@/lib/publishing-plans");
      const { plans } = await createPublishingPlansAgentCore().list({ channelId, limit: 1 });
      const zone = plans[0]?.timeZone;
      return typeof zone === "string" && zone.length > 0 ? zone : null;
    },
    ownerZone: () => ownerTimeZone(),
    nowMs: () => Date.now(),
  });
  return holder[ZONE_CACHE_KEY];
}

export function channelTimeZone(channelId: string): Promise<Zone> {
  return zoneCache().get(channelId);
}

/** A plan of the channel was saved on this computer: its zone may have changed. */
export function invalidateChannelTimeZone(channelId: string): void {
  zoneCache().invalidate(channelId);
}

/** BL-235 review item 4: the broadcasts the app ran on the channel (segments and viewer samples) -- their recordings are not releases. */
async function liveBroadcastIds(channelId: string): Promise<string[]> {
  const { listAppBroadcastIds } = await import("@/lib/db");
  return listAppBroadcastIds(channelId);
}

export function createChannelPublishingCoverage(): PublishingCoverageReads {
  return createPublishingCoverageCore({ timeZoneOf: channelTimeZone, liveBroadcastIds });
}

/** The calendar's, the alerts' and the agents' calendar hook: `days` from today in the channel's zone, on the rows already read. */
export function dailyPublishingCoverage(channelId: string, days: number, preRead?: CoveragePreRead) {
  return createChannelPublishingCoverage().get({ channelId, days }, preRead);
}

/** «План недели»: the plan's week (weekStart .. +6) in the plan's own zone (an invalid one: the owner's, then UTC). */
export async function weekPublishingCoverage(channelId: string, weekStart: string, timeZone: string) {
  const zone: Zone = isValidIanaTimezone(timeZone) ? { timeZone, source: "publishing_plan" } : await ownerTimeZone();
  return createPublishingCoverageCore({ timeZoneOf: async () => zone, liveBroadcastIds }).get({ channelId, days: 7, fromDate: weekStart });
}
