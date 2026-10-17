import { test } from "node:test";
import assert from "node:assert/strict";
import { createReachSyncAllHandler, type ReachSyncAllDeps } from "./route";

// BL-141: the route only gates on a session and passes `onlyIfDue` through; the per-channel rules live in the service.
function setup() {
  const calls: unknown[] = [];
  const core = {
    syncAllReachReports: async (input: { onlyIfDue: boolean; sessionUserId: string }) => {
      calls.push(input);
      return {
        channels: [
          { channelId: "UC_A", outcome: "synced", filesImported: 2 },
          { channelId: "UC_B", outcome: "failed", error: "insufficient scope" },
        ],
      };
    },
  } as unknown as ReachSyncAllDeps["core"];
  return { calls, core };
}

test("BL-141: sync-all needs a session and never reaches the service without one", async () => {
  const { calls, core } = setup();
  const res = await createReachSyncAllHandler({ getSession: async () => null, core, getActiveChannelId: async () => "UC_A" })(new Request("http://x", { method: "POST" }));
  assert.equal(res.status, 401);
  assert.deepEqual(calls, []);
});

test("BL-141: sync-all passes onlyIfDue from the body (default false); the response shows only the active channel (ADR 0004)", async () => {
  const { calls, core } = setup();
  const handler = createReachSyncAllHandler({ getSession: async () => ({ user: { id: "u" } }), core, getActiveChannelId: async () => "UC_A" });
  const res = await handler(new Request("http://x", { method: "POST", body: JSON.stringify({ onlyIfDue: true }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { channels: [{ channelId: "UC_A", outcome: "synced", filesImported: 2 }] });
  await handler(new Request("http://x", { method: "POST" }));
  assert.deepEqual(calls, [
    { onlyIfDue: true, sessionUserId: "u" },
    { onlyIfDue: false, sessionUserId: "u" },
  ]);
});

test("BL-141: with no active channel the response lists nothing, though every channel was still checked", async () => {
  const { calls, core } = setup();
  const res = await createReachSyncAllHandler({ getSession: async () => ({ user: { id: "u" } }), core, getActiveChannelId: async () => null })(
    new Request("http://x", { method: "POST" })
  );
  assert.deepEqual(await res.json(), { channels: [] });
  assert.equal(calls.length, 1);
});

// BL-196 AC-FS-05 (FAST_STARTUP_PLAN.md §2 D): with onlyIfDue and nothing due, the answer comes before the other computer's import and
// without a sync; something due (or a failing check) keeps the old order: import first, then the sync. A manual sync is unchanged.
test("AC-FS-05: nothing due -> no import and no sync; due or a failing check -> import, then sync", async () => {
  const order: string[] = [];
  const { core } = setup();
  const make = (isAnyDue: () => Promise<boolean>) =>
    createReachSyncAllHandler({
      getSession: async () => ({ user: { id: "u" } }),
      core: { syncAllReachReports: async (input) => (order.push("sync"), core.syncAllReachReports(input)) },
      getActiveChannelId: async () => "UC_A",
      importPeers: async () => (order.push("import"), { imported: 0, pending: false }),
      isAnyDue: async (userId) => (order.push(`isAnyDue:${userId}`), isAnyDue()),
    });
  const body = JSON.stringify({ onlyIfDue: true });
  const idle = await make(async () => false)(new Request("http://x", { method: "POST", body }));
  assert.deepEqual(await idle.json(), { channels: [] });
  assert.deepEqual(order.splice(0), ["isAnyDue:u"]);

  await make(async () => true)(new Request("http://x", { method: "POST", body }));
  assert.deepEqual(order.splice(0), ["isAnyDue:u", "import", "sync"]);
  await make(async () => Promise.reject(new Error("db busy")))(new Request("http://x", { method: "POST", body }));
  assert.deepEqual(order.splice(0), ["isAnyDue:u", "import", "sync"]);

  await make(async () => false)(new Request("http://x", { method: "POST" }));
  assert.deepEqual(order.splice(0), ["sync"], "a manual sync never asks");
});
