import { test } from "node:test";
import assert from "node:assert/strict";
import { createWatchlistTableHandler, type WatchlistTableDeps } from "./route";

test("BL-140 R3: the watchlist table route returns the core's rows and needs a session", async () => {
  const core = { getWatchlistTable: async () => ({ channels: [{ channelId: "UC1" }] }) } as unknown as WatchlistTableDeps["core"];
  const ok = await createWatchlistTableHandler({ getSession: async () => ({ user: { id: "u" } }), core })();
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { channels: [{ channelId: "UC1" }] });
  const denied = await createWatchlistTableHandler({ getSession: async () => null, core })();
  assert.equal(denied.status, 401);
});
