import { createPublishingCoverageCore, ownerTimeZone, type CoverageTimeZoneSource, type PublishingCoverageReads } from "@/lib/publishing-coverage";

/**
 * BL-235 (owner msgs 3806/3807, AGENTS.md §M): the publishing coverage with the channel's time zone, composed at the app layer --
 * the shared publishing-coverage module imports no feature module. The channel's zone is the one its weekly publishing plans are
 * kept in (the newest week's `timeZone`, WEEKLY_PUBLISHING_PLAN.md: "slots in the channel's time zone"); a channel without a plan,
 * or a plan read that fails, falls back to the owner's own zone (Settings), then UTC. Used by the Content calendar, the publishing
 * reminder, «План недели» and the agents' coverage tools. Local reads only.
 */
export async function channelTimeZone(channelId: string): Promise<{ timeZone: string; source: CoverageTimeZoneSource }> {
  try {
    const { createPublishingPlansAgentCore } = await import("@/lib/publishing-plans");
    const { plans } = await createPublishingPlansAgentCore().list({ channelId, limit: 1 });
    const zone = plans[0]?.timeZone;
    if (typeof zone === "string" && zone.length > 0) return { timeZone: zone, source: "publishing_plan" };
  } catch {
    // Not connected here, or the plans module failed: the coverage still answers, in the owner's zone (§M).
  }
  return ownerTimeZone();
}

export function createChannelPublishingCoverage(): PublishingCoverageReads {
  return createPublishingCoverageCore({ timeZoneOf: channelTimeZone });
}
