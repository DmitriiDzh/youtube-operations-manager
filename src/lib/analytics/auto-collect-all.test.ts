import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createBackgroundFailureBackoff } from "@/lib/channel-fanout/policy";
import { beginAllChannelsRun, endAllChannelsRun, runAutoCollectionForChannels, type AutoCollectAllDeps } from "./auto-collect-all";

// BL-142 (owner, Telegram 2026-10-06, msgs 1867/1868/1874): on dashboard load, the automatic Analytics collection runs
// for EVERY connected channel. The active channel (session token) is collected first; every other channel with its own
// Google user's token through the same per-channel functions and their active-channel check. Expected values by hand.

type Call = [string, string, string];

function fixture(opts: {
  connections: Array<{ channelId: string; connectedUserId: string | null }>;
  activeByUser: Record<string, string>;
  failCollectFor?: Record<string, Error>;
  current?: string[];
  catchUpFor?: string[];
  now?: () => Date;
}) {
  const calls: Call[] = [];
  const issues: string[] = [];
  const assertActive = (userId: string, channelId: string) => {
    if (opts.activeByUser[userId] !== channelId) {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" } as never);
    }
  };
  const ref = (input: unknown) => input as { credentialRef: { userId: string }; channelId: string };
  const deps: AutoCollectAllDeps = {
    listChannelConnections: async () => opts.connections,
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
      return {};
    },
    async getHistoryCatchUpPlan(input) {
      const { credentialRef, channelId } = ref(input);
      assertActive(credentialRef.userId, channelId);
      return opts.catchUpFor?.includes(channelId)
        ? { videoRanges: [{ videoId: "v", startDate: "2026-01-01", endDate: "2026-01-02" }], channelRange: null }
        : { videoRanges: [], channelRange: null };
    },
    backoff: createBackgroundFailureBackoff(opts.now ? { now: opts.now } : undefined),
    onBackgroundIssue: (channelId, message) => issues.push(`${channelId}: ${message}`),
  };
  return { deps, calls, issues };
}

const TWO = [
  { channelId: "UC_A", connectedUserId: "uA-stored" },
  { channelId: "UC_B", connectedUserId: "uB" },
];

test("BL-142: the active part collects only the active channel, with the session token, then its weekly report", async () => {
  const { deps, calls } = fixture({ connections: TWO, activeByUser: { uS: "UC_A", uB: "UC_B" } });
  const result = await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: "UC_A", which: "active" });
  assert.deepEqual(calls, [
    ["collect", "UC_A", "uS"],
    ["weekly", "UC_A", "uS"],
  ]);
  assert.deepEqual(result.channels, [{ channelId: "UC_A", collection: "collected" }]);
});

test("BL-142: the background part collects every other channel with its own user's token", async () => {
  const { deps, calls } = fixture({ connections: TWO, activeByUser: { uS: "UC_A", uB: "UC_B" }, current: ["UC_B"] });
  const result = await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: "UC_A", which: "background" });
  assert.deepEqual(calls, [
    ["collect", "UC_B", "uB"],
    ["weekly", "UC_B", "uB"],
  ]);
  assert.deepEqual(result.channels, [{ channelId: "UC_B", collection: "current" }]);
});

test("BL-142: with no active channel, the active part does nothing and every channel is background", async () => {
  const { deps, calls } = fixture({ connections: TWO, activeByUser: { "uA-stored": "UC_A", uB: "UC_B" } });
  assert.deepEqual((await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: null, which: "active" })).channels, []);
  await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: null, which: "background" });
  assert.deepEqual(calls.filter((c) => c[0] === "collect"), [
    ["collect", "UC_A", "uA-stored"],
    ["collect", "UC_B", "uB"],
  ]);
});

test("BL-142: a background channel whose user switched away fails closed, still gets its weekly report, and is reported", async () => {
  const { deps, calls, issues } = fixture({ connections: TWO, activeByUser: { uS: "UC_A", uB: "UC_OTHER" } });
  const result = await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: "UC_A", which: "background" });
  assert.equal(result.channels[0].collection, "failed");
  assert.equal((result.channels[0] as { code?: string }).code, "CHANNEL_NOT_ACTIVE");
  assert.deepEqual(calls, [
    ["collect", "UC_B", "uB"],
    ["weekly", "UC_B", "uB"],
  ]);
  assert.deepEqual(issues, ["UC_B: not collected: CHANNEL_NOT_ACTIVE"]);
});

test("BL-142: a failing background channel is held back for 6 hours; a failing active channel is retried at once", async () => {
  let now = new Date("2026-10-06T12:00:00Z");
  const { deps, calls } = fixture({
    connections: TWO,
    activeByUser: { uS: "UC_A", uB: "UC_B" },
    failCollectFor: { UC_A: new Error("quota exceeded"), UC_B: new Error("token revoked") },
    now: () => now,
  });
  const run = (which: "active" | "background") => runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: "UC_A", which });
  assert.deepEqual((await run("background")).channels, [{ channelId: "UC_B", collection: "failed", error: "token revoked" }]);
  now = new Date("2026-10-06T13:00:00Z");
  assert.deepEqual((await run("background")).channels, [
    { channelId: "UC_B", collection: "skipped_backoff", since: "2026-10-06T12:00:00.000Z", reason: "token revoked" },
  ]);
  await run("active");
  await run("active");
  assert.equal(calls.filter((c) => c[0] === "collect" && c[1] === "UC_A").length, 2, "the active channel is never held back");
  assert.equal(calls.filter((c) => c[0] === "collect" && c[1] === "UC_B").length, 1, "Google was not asked again for UC_B");
  now = new Date("2026-10-06T18:00:00Z");
  await run("background");
  assert.equal(calls.filter((c) => c[0] === "collect" && c[1] === "UC_B").length, 2, "after 6 hours it is tried again");
});

test("BL-142: a background channel with no connected user is skipped and reported", async () => {
  const { deps, calls, issues } = fixture({
    connections: [{ channelId: "UC_GONE", connectedUserId: null }],
    activeByUser: { uS: "UC_A" },
  });
  const result = await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: "UC_A", which: "background" });
  assert.deepEqual(result.channels, [{ channelId: "UC_GONE", collection: "skipped_no_user" }]);
  assert.deepEqual(calls, []);
  assert.equal(issues.length, 1);
});

test("BL-142: history catch-up is handed back for channels with a gap, each with its own credentials, never after a failure", async () => {
  const { deps } = fixture({
    connections: [...TWO, { channelId: "UC_C", connectedUserId: "uC" }],
    activeByUser: { uS: "UC_A", uB: "UC_B", uC: "UC_C" },
    catchUpFor: ["UC_A", "UC_B", "UC_C"],
    failCollectFor: { UC_B: new Error("boom") },
  });
  const active = await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: "UC_A", which: "active" });
  const background = await runAutoCollectionForChannels(deps, { sessionUserId: "uS", activeChannelId: "UC_A", which: "background" });
  assert.deepEqual([...active.catchUps, ...background.catchUps], [
    { channelId: "UC_A", credentialRef: { userId: "uS" } },
    { channelId: "UC_C", credentialRef: { userId: "uC" } },
  ]);
});

test("BL-142: only one all-channels run at a time", () => {
  assert.equal(beginAllChannelsRun(), true);
  assert.equal(beginAllChannelsRun(), false);
  endAllChannelsRun();
  assert.equal(beginAllChannelsRun(), true);
  endAllChannelsRun();
});
