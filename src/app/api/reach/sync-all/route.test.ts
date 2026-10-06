import { test } from "node:test";
import assert from "node:assert/strict";
import { createReachSyncAllHandler, type ReachSyncAllDeps } from "./route";

// BL-141: the route only gates on a session and passes `onlyIfDue` through; the per-channel rules live in the service.
function setup() {
  const calls: unknown[] = [];
  const core = {
    syncAllReachReports: async (input: { onlyIfDue: boolean }) => {
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
  assert.deepEqual(calls, [{ onlyIfDue: true }, { onlyIfDue: false }]);
});

test("BL-141: with no active channel the response lists nothing, though every channel was still checked", async () => {
  const { calls, core } = setup();
  const res = await createReachSyncAllHandler({ getSession: async () => ({ user: { id: "u" } }), core, getActiveChannelId: async () => null })(
    new Request("http://x", { method: "POST" })
  );
  assert.deepEqual(await res.json(), { channels: [] });
  assert.equal(calls.length, 1);
});
