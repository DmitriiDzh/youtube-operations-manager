import assert from "node:assert/strict";
import test from "node:test";
import type { PoolView } from "@/lib/media-jobs-pool/contracts";
import { createMediaJobsGetHandler } from "./route";

// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.1): Media's shared list -- a session is required, the channel is the session's ACTIVE one
// (never taken from the request, ADR 0004 (b)), and the kind and the number of rows are checked.

const empty: PoolView = { jobs: [], devices: [] };

function handler(options: { session?: boolean; active?: string | null } = {}) {
  const calls: Array<{ channelId: string; kind: string | null; limit: number }> = [];
  const get = createMediaJobsGetHandler({
    getSession: async () => (options.session === false ? null : { user: { id: "u1" } }),
    activeChannelOf: async () => (options.active === undefined ? "UC1" : options.active),
    list: async (input) => {
      calls.push(input);
      return empty;
    },
  });
  return { get, calls };
}

test("401 without a session; nothing is listed", async () => {
  const { get, calls } = handler({ session: false });
  assert.equal((await get(new Request("http://x/api/media-jobs"))).status, 401);
  assert.equal(calls.length, 0);
});

test("the active channel is used, even when the request names another; kind and limit pass through", async () => {
  const { get, calls } = handler();
  const response = await get(new Request("http://x/api/media-jobs?kind=video&limit=20&channelId=UC_OTHER"));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ channelId: "UC1", kind: "video", limit: 20 }]);
});

test("defaults: every kind, the newest 50", async () => {
  const { get, calls } = handler();
  await get(new Request("http://x/api/media-jobs"));
  assert.deepEqual(calls, [{ channelId: "UC1", kind: null, limit: 50 }]);
});

test("no active channel: an empty list, nothing read", async () => {
  const { get, calls } = handler({ active: null });
  const response = await get(new Request("http://x/api/media-jobs"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), empty);
  assert.equal(calls.length, 0);
});

test("400 for an unknown kind or a limit outside 1..200", async () => {
  for (const query of ["kind=pdf", "limit=0", "limit=201", "limit=abc", "limit=2.5"]) {
    const { get, calls } = handler();
    assert.equal((await get(new Request(`http://x/api/media-jobs?${query}`))).status, 400, query);
    assert.equal(calls.length, 0);
  }
  const { get } = handler();
  assert.equal((await get(new Request("http://x/api/media-jobs?limit=200"))).status, 200);
});
