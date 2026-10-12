import assert from "node:assert/strict";
import test from "node:test";
import { createLiveNoticesGetHandler } from "./route";

// BL-176 (§3.10): a Web session is required; a failure never breaks the bell (no notices this time).

test("401 without a session; notices with one; an error gives an empty list, not a failure", async () => {
  const notice = { channelId: "UC1", kind: "live_stream_down" as const, since: 1 };
  assert.equal((await createLiveNoticesGetHandler({ getSession: async () => null, list: async () => [notice] })()).status, 401);
  const ok = await createLiveNoticesGetHandler({ getSession: async () => ({ user: { id: "u1" } }), list: async () => [notice] })();
  assert.deepEqual(await ok.json(), { notices: [notice] });
  const failing = await createLiveNoticesGetHandler({ getSession: async () => ({ user: { id: "u1" } }), list: async () => { throw new Error("disk"); } })();
  assert.deepEqual([failing.status, await failing.json()], [200, { notices: [] }]);
});
