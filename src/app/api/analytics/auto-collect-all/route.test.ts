import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@/lib/analytics/contracts";
import { createAutoCollectAllHandler, type AutoCollectAllDeps } from "./route";

// BL-142: the route gates on a session, collects the active channel before answering and everything else after it,
// shows only the active channel (ADR 0004), and lets one all-channels run go at a time.
function setup(opts: { activeCatchUp?: boolean; backgroundCatchUp?: boolean; failActive?: Error } = {}) {
  const calls: unknown[] = [];
  const deferred: Array<() => Promise<void>> = [];
  let running = false;
  const core = {
    runAutoCollectionForChannels: async (input: { sessionUserId: string; activeChannelId: string | null; which: string }) => {
      calls.push([input.which, input.sessionUserId, input.activeChannelId]);
      if (input.which === "active" && opts.failActive) throw opts.failActive;
      return input.which === "active"
        ? {
            channels: [{ channelId: "UC_A", collection: "collected" }],
            catchUps: opts.activeCatchUp ? [{ channelId: "UC_A", credentialRef: { userId: "uS" } }] : [],
          }
        : {
            channels: [{ channelId: "UC_B", collection: "failed", error: "token revoked" }],
            catchUps: opts.backgroundCatchUp ? [{ channelId: "UC_C", credentialRef: { userId: "uC" } }] : [],
          };
    },
    runHistoryCatchUp: async (input: unknown) => {
      const i = input as { channelId: string; credentialRef: { userId: string } };
      calls.push(["catchUp", i.channelId, i.credentialRef.userId]);
      return { ranCatchUp: false };
    },
  } as unknown as AutoCollectAllDeps["core"];
  const deps: AutoCollectAllDeps = {
    getSession: async () => ({ user: { id: "uS" } }),
    core,
    getActiveChannelId: async () => "UC_A",
    runAfter: (work) => deferred.push(work),
    beginRun: () => (running ? false : (running = true)),
    endRun: () => {
      running = false;
    },
  };
  return { calls, deferred, deps, isRunning: () => running };
}

test("BL-142: auto-collect-all needs a session", async () => {
  const { calls, deps } = setup();
  const res = await createAutoCollectAllHandler({ ...deps, getSession: async () => null })();
  assert.equal(res.status, 401);
  assert.deepEqual(calls, []);
});

test("BL-142: the active channel is collected before the answer, which shows only it; the rest runs after it", async () => {
  const { calls, deferred, deps, isRunning } = setup({ activeCatchUp: true, backgroundCatchUp: true });
  const res = await createAutoCollectAllHandler(deps)();
  assert.deepEqual(await res.json(), { channels: [{ channelId: "UC_A", collection: "collected" }], catchUpScheduled: true });
  assert.deepEqual(calls, [["active", "uS", "UC_A"]], "nothing else before the response");
  assert.equal(isRunning(), true, "the run is held until the background part finishes");
  await deferred[0]();
  assert.deepEqual(calls.slice(1), [
    ["background", "uS", "UC_A"],
    ["catchUp", "UC_A", "uS"],
    ["catchUp", "UC_C", "uC"],
  ]);
  assert.equal(isRunning(), false);
});

test("BL-142: while a run is still going, another request does nothing", async () => {
  const { calls, deps } = setup();
  const handler = createAutoCollectAllHandler(deps);
  await handler();
  const second = await handler();
  assert.deepEqual(await second.json(), { channels: [], catchUpScheduled: false, inProgress: true });
  assert.equal(calls.filter((c) => (c as string[])[0] === "active").length, 1);
});

test("BL-142: a domain error keeps its own status and code, and the run is released", async () => {
  const { deps, isRunning } = setup({ failActive: new DomainError({ code: "unauthorized", message: "no" } as never) });
  const res = await createAutoCollectAllHandler(deps)();
  assert.notEqual(res.status, 500);
  assert.equal((await res.json()).error, "unauthorized");
  assert.equal(isRunning(), false);
});
