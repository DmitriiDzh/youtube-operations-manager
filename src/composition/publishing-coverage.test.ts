import assert from "node:assert/strict";
import test from "node:test";
import { createPublishingCoverageReads } from "@/lib/publishing-coverage";
import { createPublishingCalendarReads } from "@/lib/publishing/calendar-reads";
import { CHANNEL_ZONE_TTL_MS, createChannelZoneCache } from "./publishing-coverage";

// BL-235 review items 2 and 8. The channel's zone is the newest weekly plan's; with no usable one -- none, an invalid zone, a
// failed read -- the owner's zone (as documented), and only then UTC. The plan store is read at most once per channel per 5 min
// (the alerts poll every channel every minute), again after a plan of the channel was saved here.

const OWNER = { timeZone: "Europe/Helsinki", source: "owner" as const };

function cache(readPlanZone: (channelId: string) => Promise<string | null>) {
  const clock = { ms: Date.parse("2026-11-05T03:00:00.000Z") };
  const reads: string[] = [];
  const zones = createChannelZoneCache({
    readPlanZone: async (channelId) => {
      reads.push(channelId);
      return readPlanZone(channelId);
    },
    ownerZone: async () => OWNER,
    nowMs: () => clock.ms,
  });
  return { zones, reads, clock };
}

test("BL-235 item 8: an invalid plan zone, no plan or a failed plan read fall back to the owner's zone", async () => {
  assert.deepEqual(await cache(async () => "Mars/Base").zones.get("UC_A"), OWNER);
  assert.deepEqual(await cache(async () => null).zones.get("UC_A"), OWNER);
  assert.deepEqual(
    await cache(async () => {
      throw new Error("plans down");
    }).zones.get("UC_A"),
    OWNER
  );
  assert.deepEqual(await cache(async () => "Asia/Tokyo").zones.get("UC_A"), { timeZone: "Asia/Tokyo", source: "publishing_plan" });
});

test("BL-235 item 2: within 5 min the plan store is read once per channel; after the TTL or a save it is read again", async () => {
  const { zones, reads, clock } = cache(async () => "Asia/Tokyo");
  await zones.get("UC_A");
  await zones.get("UC_A");
  await zones.get("UC_B");
  assert.deepEqual(reads, ["UC_A", "UC_B"]);
  clock.ms += CHANNEL_ZONE_TTL_MS - 1;
  await zones.get("UC_A");
  assert.deepEqual(reads, ["UC_A", "UC_B"]);
  clock.ms += 1;
  await zones.get("UC_A");
  assert.deepEqual(reads, ["UC_A", "UC_B", "UC_A"]);
  zones.invalidate("UC_A");
  await zones.get("UC_A");
  assert.deepEqual(reads, ["UC_A", "UC_B", "UC_A", "UC_A"]);
});

test("BL-235 item 2: repeated alerts within the TTL read the plan store once and the videos once per alert", async () => {
  const { zones, reads } = cache(async () => "Asia/Tokyo");
  const coverageVideoReads: string[] = [];
  const coverage = createPublishingCoverageReads({
    getChannel: async () => ({ lastSyncedAt: new Date("2026-11-05T02:00:00.000Z") }),
    listVideos: async (channelId) => (coverageVideoReads.push(channelId), []),
    trackedLanguages: async () => [],
    channelLanguage: async () => null,
    timeZoneOf: (channelId) => zones.get(channelId),
    clock: { now: () => new Date("2026-11-05T03:00:00.000Z") },
  });
  const calendarVideoReads: string[] = [];
  const calendar = createPublishingCalendarReads({
    listVideos: async (channelId) => (calendarVideoReads.push(channelId), []),
    getChannel: async () => ({ lastSyncedAt: new Date("2026-11-05T02:00:00.000Z") }),
    clock: { now: () => new Date("2026-11-05T03:00:00.000Z") },
    dailyCoverage: (channelId, days, preRead) => coverage.get({ channelId, days }, preRead),
  });
  for (let poll = 0; poll < 3; poll += 1) await calendar.getAlert({ channelId: "UC_A" });
  assert.deepEqual(reads, ["UC_A"]);
  assert.deepEqual(calendarVideoReads, ["UC_A", "UC_A", "UC_A"]);
  assert.deepEqual(coverageVideoReads, [], "the coverage reuses the rows the alert read");
});
