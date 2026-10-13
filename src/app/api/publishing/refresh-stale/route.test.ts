import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshStaleHandler, type RefreshStaleDeps } from "./route";

// BL-182 stage 1 (FO-REQ-0023 §4 D4; PUBLISHING_PLAN.md §2 stage 1 item 2): once per dashboard load, every connected channel other
// than the active one whose videos were last synced more than 6 h ago is synced with its OWN connected user; fresher ones, the
// active one (synced on every load already) and a channel without a connected user are skipped; one failure does not stop the
// others; a second request while one runs does nothing.

const NOW = new Date("2026-10-13T12:00:00Z");

function deps(over: Partial<RefreshStaleDeps> & { synced?: Record<string, string | null>; failFor?: string[] } = {}) {
  const calls: Array<{ userId: string; channelId: string }> = [];
  const synced = over.synced ?? { UC_A: "2026-10-13T11:00:00Z", UC_B: "2026-10-13T05:00:00Z", UC_C: null, UC_D: "2026-10-13T05:00:00Z" };
  const d: RefreshStaleDeps = {
    getSession: async () => ({ user: { id: "user-a" } }),
    activeChannelId: async () => "UC_A",
    connections: async () => [
      { channelId: "UC_A", connectedUserId: "user-a" },
      { channelId: "UC_B", connectedUserId: "user-b" },
      { channelId: "UC_C", connectedUserId: "user-c" },
      { channelId: "UC_D", connectedUserId: null },
    ],
    lastSyncedAt: async (channelId) => (synced[channelId] ? new Date(synced[channelId] as string) : null),
    sync: async (input) => {
      calls.push(input);
      if (over.failFor?.includes(input.channelId)) throw new Error("token revoked");
    },
    clock: { now: () => NOW },
    flag: { running: false },
    ...over,
  };
  return { d, calls };
}

test("syncs only the other channels older than 6 h (or never synced), each with its own user", async () => {
  const { d, calls } = deps();
  const body = await (await createRefreshStaleHandler(d)()).json();
  // UC_A is active; UC_B was synced 7 h ago; UC_C never; UC_D has no connected user.
  assert.deepEqual(calls, [
    { userId: "user-b", channelId: "UC_B" },
    { userId: "user-c", channelId: "UC_C" },
  ]);
  assert.deepEqual(body, { refreshed: ["UC_B", "UC_C"], failed: [] });
});

test("exactly 6 h is still fresh; a failure is reported and the next channel still runs", async () => {
  const fresh = deps({ synced: { UC_A: null, UC_B: "2026-10-13T06:00:00Z", UC_C: "2026-10-13T05:59:00Z", UC_D: null } });
  await createRefreshStaleHandler(fresh.d)();
  assert.deepEqual(fresh.calls.map((c) => c.channelId), ["UC_C"]);

  const failing = deps({ failFor: ["UC_B"] });
  const body = await (await createRefreshStaleHandler(failing.d)()).json();
  assert.deepEqual(body, { refreshed: ["UC_C"], failed: [{ channelId: "UC_B", error: "token revoked" }] });
});

test("a refresh already running: nothing is called; no session: 401", async () => {
  const running = deps({ flag: { running: true } });
  assert.deepEqual(await (await createRefreshStaleHandler(running.d)()).json(), { refreshed: [], inProgress: true });
  assert.equal(running.calls.length, 0);
  const anonymous = deps({ getSession: async () => null });
  assert.equal((await createRefreshStaleHandler(anonymous.d)()).status, 401);
});
