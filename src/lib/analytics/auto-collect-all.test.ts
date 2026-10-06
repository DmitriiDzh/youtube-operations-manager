import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { runAutoCollectionForAllChannels, type AutoCollectAllDeps } from "./auto-collect-all";

// BL-142 (owner, Telegram 2026-10-06, msgs 1867/1868/1874): on dashboard load, the automatic Analytics collection runs
// for EVERY connected channel, not only the active one. The active channel uses the session's token (as before); every
// other channel uses its own Google user's token through the same per-channel functions and their active-channel
// check. Channels run one after another; per channel: collection, then the weekly report. Expected values by hand.

type Call = [string, string, string];

function fixture(opts: {
  connections: Array<{ channelId: string; connectedUserId: string | null }>;
  activeByUser: Record<string, string>;
  failCollectFor?: Record<string, Error>;
  current?: string[];
  catchUpFor?: string[];
}) {
  const calls: Call[] = [];
  const assertActive = (userId: string, channelId: string) => {
    if (opts.activeByUser[userId] !== channelId) {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" } as never);
    }
  };
  const ref = (input: unknown) => input as { credentialRef: { userId: string }; channelId: string };
  const deps: AutoCollectAllDeps = {
    listChannelConnections: async () => opts.connections,
    getActiveChannelId: async (userId) => opts.activeByUser[userId] ?? null,
    async runAutoCollectionIfStale(input) {
      const { credentialRef, channelId } = ref(input);
      calls.push(["collect", channelId, credentialRef.userId]);
      assertActive(credentialRef.userId, channelId);
      if (opts.failCollectFor?.[channelId]) throw opts.failCollectFor[channelId];
      return opts.current?.includes(channelId) ? { ranCollection: false } : ({ ranCollection: true, result: {} } as never);
    },
    async runWeeklyReportIfDue(input) {
      const { credentialRef, channelId } = ref(input);
      calls.push(["weekly", channelId, credentialRef.userId]);
      assertActive(credentialRef.userId, channelId);
      return {};
    },
    async getHistoryCatchUpPlan(input) {
      const { channelId } = ref(input);
      return opts.catchUpFor?.includes(channelId)
        ? { videoRanges: [{ videoId: "v", startDate: "2026-01-01", endDate: "2026-01-02" }], channelRange: null }
        : { videoRanges: [], channelRange: null };
    },
  };
  return { deps, calls };
}

test("BL-142: every channel is collected, the active one with the session token, then its weekly report, in order", async () => {
  const { deps, calls } = fixture({
    connections: [
      { channelId: "UC_A", connectedUserId: "uA-stored" },
      { channelId: "UC_B", connectedUserId: "uB" },
    ],
    activeByUser: { uS: "UC_A", "uA-stored": "UC_A", uB: "UC_B" },
    current: ["UC_B"],
  });
  const result = await runAutoCollectionForAllChannels(deps, { sessionUserId: "uS" });
  assert.deepEqual(calls, [
    ["collect", "UC_A", "uS"],
    ["weekly", "UC_A", "uS"],
    ["collect", "UC_B", "uB"],
    ["weekly", "UC_B", "uB"],
  ]);
  assert.deepEqual(
    result.channels.map((c) => [c.channelId, c.collection]),
    [
      ["UC_A", "collected"],
      ["UC_B", "current"],
    ]
  );
});

test("BL-142: a channel whose user switched away fails closed (no weekly report for it); the next still runs", async () => {
  const { deps, calls } = fixture({
    connections: [
      { channelId: "UC_A", connectedUserId: "uA" },
      { channelId: "UC_B", connectedUserId: "uB" },
    ],
    activeByUser: { uA: "UC_OTHER", uB: "UC_B" },
  });
  const result = await runAutoCollectionForAllChannels(deps, { sessionUserId: "uB" });
  assert.equal(result.channels[0].collection, "failed");
  assert.equal(result.channels[0].code, "CHANNEL_NOT_ACTIVE");
  assert.equal(result.channels[1].collection, "collected");
  assert.deepEqual(calls, [
    ["collect", "UC_A", "uA"],
    ["collect", "UC_B", "uB"],
    ["weekly", "UC_B", "uB"],
  ]);
});

test("BL-142: a background channel with no connected user is skipped; the active channel never needs one", async () => {
  const { deps, calls } = fixture({
    connections: [
      { channelId: "UC_GONE", connectedUserId: null },
      { channelId: "UC_A", connectedUserId: null },
    ],
    activeByUser: { uS: "UC_A" },
  });
  const result = await runAutoCollectionForAllChannels(deps, { sessionUserId: "uS" });
  assert.deepEqual(result.channels[0], { channelId: "UC_GONE", collection: "skipped_no_user" });
  assert.equal(result.channels[1].collection, "collected");
  assert.deepEqual(calls.map((c) => c[1]), ["UC_A", "UC_A"]);
});

test("BL-142: a Google error on one channel keeps its message and the next channel still runs", async () => {
  const { deps } = fixture({
    connections: [
      { channelId: "UC_A", connectedUserId: "uA" },
      { channelId: "UC_B", connectedUserId: "uB" },
    ],
    activeByUser: { uA: "UC_A", uB: "UC_B" },
    failCollectFor: { UC_A: new Error("quota exceeded") },
  });
  const result = await runAutoCollectionForAllChannels(deps, { sessionUserId: "uB" });
  assert.deepEqual(result.channels[0], { channelId: "UC_A", collection: "failed", error: "quota exceeded" });
  assert.equal(result.channels[1].collection, "collected");
});

test("BL-142: history catch-up is handed back for every channel that has a gap, each with its own credentials", async () => {
  const { deps } = fixture({
    connections: [
      { channelId: "UC_A", connectedUserId: "uA" },
      { channelId: "UC_B", connectedUserId: "uB" },
      { channelId: "UC_C", connectedUserId: "uC" },
    ],
    activeByUser: { uS: "UC_A", uB: "UC_B", uC: "UC_C" },
    catchUpFor: ["UC_A", "UC_C"],
  });
  const result = await runAutoCollectionForAllChannels(deps, { sessionUserId: "uS" });
  assert.deepEqual(result.catchUps, [
    { channelId: "UC_A", credentialRef: { userId: "uS" } },
    { channelId: "UC_C", credentialRef: { userId: "uC" } },
  ]);
});
