import assert from "node:assert/strict";
import test from "node:test";
import { createChannelSyncHandler } from "./route";

// BL-197 acceptance (owner, Telegram 2026-10-18, msg 2988): the dashboard's automatic sync (`onlyIfStale`) makes no YouTube call while
// this identity's copy of its active channel is younger than 6 h; a just-connected channel and every explicit sync still run.

const NOW = new Date("2026-10-18T12:00:00Z");

function harness(stored: { connectedUserId: string | null; lastSyncedAt: Date | null } | null, active: string | null = "UC_own", live: string | null = active) {
  const syncs: Array<{ userId: string; trackedChannelId: string; payload: Record<string, unknown> }> = [];
  const handler = createChannelSyncHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    activeChannelId: async () => active,
    liveChannelId: () => live,
    storedChannel: async () => stored,
    sync: async (args) => {
      syncs.push(args);
      return { channelId: "UC_own", videoCount: 3 };
    },
    clock: { now: () => NOW },
  });
  const post = (body: unknown) => handler(new Request("http://localhost/api/channels/sync", { method: "POST", body: JSON.stringify(body) }));
  return { post, syncs };
}

test("channels/sync onlyIfStale: an owned copy synced 1 h ago is skipped with no sync", async () => {
  const h = harness({ connectedUserId: "user-1", lastSyncedAt: new Date("2026-10-18T11:00:00Z") });
  const res = await h.post({ onlyIfStale: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: true, reason: "fresh", channelId: "UC_own", lastSyncedAt: "2026-10-18T11:00:00.000Z" });
  assert.equal(h.syncs.length, 0);
});

test("channels/sync onlyIfStale: a copy 7 h old is synced, and the flag never reaches the sync input", async () => {
  const h = harness({ connectedUserId: "user-1", lastSyncedAt: new Date("2026-10-18T05:00:00Z") });
  const res = await h.post({ onlyIfStale: true });
  assert.deepEqual(await res.json(), { channelId: "UC_own", videoCount: 3 });
  assert.deepEqual(h.syncs, [{ userId: "user-1", trackedChannelId: "UC_own", payload: {} }]);
});

test("channels/sync onlyIfStale: a just-connected channel (row not owned by this identity yet) is synced at once", async () => {
  const h = harness({ connectedUserId: null, lastSyncedAt: new Date("2026-10-18T11:30:00Z") });
  await h.post({ onlyIfStale: true });
  assert.equal(h.syncs.length, 1);
});

test("channels/sync onlyIfStale: no active channel recorded yet (first sign-in) runs the sync unscoped", async () => {
  const h = harness(null, null);
  await h.post({ onlyIfStale: true });
  assert.deepEqual(h.syncs, [{ userId: "user-1", trackedChannelId: "unscoped", payload: {} }]);
});

test("channels/sync: without onlyIfStale a fresh copy is still synced (a sync the operator asks for always runs)", async () => {
  const h = harness({ connectedUserId: "user-1", lastSyncedAt: new Date("2026-10-18T11:59:00Z") });
  await h.post({});
  assert.equal(h.syncs.length, 1);
});

test("channels/sync: an explicit channelId is never skipped, even with onlyIfStale", async () => {
  const h = harness({ connectedUserId: "user-1", lastSyncedAt: new Date("2026-10-18T11:59:00Z") });
  await h.post({ onlyIfStale: true, channelId: "UC_other" });
  assert.deepEqual(h.syncs, [{ userId: "user-1", trackedChannelId: "UC_other", payload: { channelId: "UC_other" } }]);
});

test("channels/sync onlyIfStale: no live read yet for this identity (a fresh Google sign-in forgot it) -- the sync runs, even with a fresh owned copy of the stored selection", async () => {
  // The stored selection still names UC_own (owned, synced 1 h ago) while channel-info has not answered for the new grant yet.
  const h = harness({ connectedUserId: "user-1", lastSyncedAt: new Date("2026-10-18T11:00:00Z") }, "UC_own", null);
  await h.post({ onlyIfStale: true });
  assert.deepEqual(h.syncs, [{ userId: "user-1", trackedChannelId: "UC_own", payload: {} }]);
});
