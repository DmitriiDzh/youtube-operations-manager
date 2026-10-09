import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createChannelPauseHandler } from "./route";

// BL-163 (FO-REQ-0014 §A3): the owner pauses or resumes one watchlist entry -- session-gated; the channel id comes from the path.

const CHANNEL = "UCaaaaaaaaaaaaaaaaaaaaaa";
const params = (channelId = CHANNEL) => ({ params: Promise.resolve({ channelId }) });
function post(body: unknown) {
  return new Request(`http://localhost/api/market-intelligence/channels/${CHANNEL}/pause`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("pause route: forwards { channelId from the path, paused } and returns the entry; unauthenticated is 401 without reaching the core", async () => {
  const received: unknown[] = [];
  const core = {
    async setWatchlistPause(input: unknown) {
      received.push(input);
      return { channelId: CHANNEL, pausedReason: "owner" } as never;
    },
  };
  const handler = createChannelPauseHandler({ getSession: async () => ({ user: { id: "u1" } }), core });
  const response = await handler(post({ paused: true, channelId: "UCsomeoneelse_ignored_xx" }), params());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { channel: { channelId: CHANNEL, pausedReason: "owner" } });
  assert.deepEqual(received, [{ channelId: CHANNEL, paused: true }], "the body cannot redirect the call to another entry");

  const denied = createChannelPauseHandler({ getSession: async () => null, core });
  assert.equal((await denied(post({ paused: false }), params())).status, 401);
  assert.equal(received.length, 1);
});

test("pause route: invalid JSON is 400; an entry not on the watchlist is 404", async () => {
  const handler = createChannelPauseHandler({
    getSession: async () => ({ user: { id: "u1" } }),
    core: {
      async setWatchlistPause() {
        throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry", details: {} });
      },
    },
  });
  assert.equal((await handler(post("not json"), params())).status, 400);
  const missing = await handler(post({ paused: true }), params());
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});
