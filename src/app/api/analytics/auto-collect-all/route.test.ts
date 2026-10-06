import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoCollectAllHandler, type AutoCollectAllDeps } from "./route";

// BL-142: the route gates on a session, shows only the active channel (ADR 0004), and runs every planned catch-up after
// the response, one channel after another.
function setup(catchUps: Array<{ channelId: string; credentialRef: { userId: string } }> = []) {
  const calls: unknown[] = [];
  const deferred: Array<() => Promise<void>> = [];
  const core = {
    runAutoCollectionForAllChannels: async (input: { sessionUserId: string }) => {
      calls.push(["all", input.sessionUserId]);
      return {
        channels: [
          { channelId: "UC_A", collection: "collected" },
          { channelId: "UC_B", collection: "failed", error: "quota exceeded" },
        ],
        catchUps,
      };
    },
    runHistoryCatchUp: async (input: unknown) => {
      calls.push(["catchUp", (input as { channelId: string }).channelId, (input as { credentialRef: { userId: string } }).credentialRef.userId]);
      return { ranCatchUp: false };
    },
  } as unknown as AutoCollectAllDeps["core"];
  return { calls, deferred, core, runAfter: (work: () => Promise<void>) => deferred.push(work) };
}

test("BL-142: auto-collect-all needs a session", async () => {
  const { calls, core, runAfter } = setup();
  const res = await createAutoCollectAllHandler({ getSession: async () => null, core, getActiveChannelId: async () => "UC_A", runAfter })();
  assert.equal(res.status, 401);
  assert.deepEqual(calls, []);
});

test("BL-142: the response shows only the active channel; with no active channel it shows none", async () => {
  const { core, runAfter } = setup();
  const session = async () => ({ user: { id: "uS" } });
  const res = await createAutoCollectAllHandler({ getSession: session, core, getActiveChannelId: async () => "UC_A", runAfter })();
  assert.deepEqual(await res.json(), { channels: [{ channelId: "UC_A", collection: "collected" }], catchUpScheduled: false });
  const none = await createAutoCollectAllHandler({ getSession: session, core, getActiveChannelId: async () => null, runAfter })();
  assert.deepEqual(await none.json(), { channels: [], catchUpScheduled: false });
});

test("BL-142: every planned catch-up runs after the response, in order, each with its own credentials", async () => {
  const { calls, deferred, core, runAfter } = setup([
    { channelId: "UC_A", credentialRef: { userId: "uS" } },
    { channelId: "UC_C", credentialRef: { userId: "uC" } },
  ]);
  const res = await createAutoCollectAllHandler({ getSession: async () => ({ user: { id: "uS" } }), core, getActiveChannelId: async () => "UC_A", runAfter })();
  assert.equal((await res.json()).catchUpScheduled, true);
  assert.deepEqual(calls, [["all", "uS"]], "nothing heavy before the response");
  assert.equal(deferred.length, 1);
  await deferred[0]();
  assert.deepEqual(calls.slice(1), [
    ["catchUp", "UC_A", "uS"],
    ["catchUp", "UC_C", "uC"],
  ]);
});
