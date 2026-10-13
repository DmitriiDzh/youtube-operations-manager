import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createPublishingCalendarHandler, type PublishingCalendarDeps } from "./route";

// BL-182 stage 1 (AGENTS.md §F: a route taking a channelId checks it belongs to the caller): the calendar of the caller's active
// channel only; another channel is refused before anything is read.

const params = (channelId: string) => ({ params: Promise.resolve({ channelId }) });

function deps(reads: string[]): PublishingCalendarDeps {
  return {
    getSession: async () => ({ user: { id: "u1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_A") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    getCalendar: async ({ channelId }) => {
      reads.push(channelId);
      return { channelId, lastSyncedAt: null, entries: [], coverage: { coveredThrough: null, scheduledCount: 0, unscheduledCount: 0, daysCovered: 0, due: true, thresholdDays: 7 } };
    },
  };
}

test("the active channel's calendar is returned; another channel is refused and never read", async () => {
  const reads: string[] = [];
  const handler = createPublishingCalendarHandler(deps(reads));
  assert.equal((await handler(new Request("http://x"), params("UC_A"))).status, 200);
  const refused = await handler(new Request("http://x"), params("UC_B"));
  assert.notEqual(refused.status, 200);
  assert.equal(((await refused.json()) as { error: string }).error, "CHANNEL_NOT_ACTIVE");
  assert.deepEqual(reads, ["UC_A"]);
});

test("no session: 401", async () => {
  const handler = createPublishingCalendarHandler({ ...deps([]), getSession: async () => null });
  assert.equal((await handler(new Request("http://x"), params("UC_A"))).status, 401);
});
