import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createChannelCollectionDepthHandlers } from "./route";

const CHANNEL = "UC1234567890123456789012";
const params = Promise.resolve({ channelId: CHANNEL });
const PROGRESS = {
  maxVideosPerChannel: 120,
  maxVideosPerChannelOverride: 120,
  publishedAfter: null,
  publishedAfterOverride: null,
  videosStored: 80,
  complete: false,
  completeReason: null,
  estimatedFirstCollectionUnits: 4,
  estimatedFirstCollectionWorstCaseUnits: 7,
};

function post(body: unknown) {
  return new Request(`http://localhost/api/market-intelligence/channels/${CHANNEL}/collection-depth`, { method: "POST", body: JSON.stringify(body) });
}

test("channel collection-depth route: GET returns the channel's progress; unauthenticated is 401 and never reaches the core", async () => {
  let called = 0;
  const core = {
    async getChannelCollectionProgress(input: unknown) {
      called += 1;
      assert.deepEqual(input, { channelId: CHANNEL });
      return PROGRESS;
    },
    async setChannelCollectionDepth() {},
  };
  const ok = createChannelCollectionDepthHandlers({ getSession: async () => ({ user: { id: "u1" } }), core });
  const response = await ok.GET(new Request("http://localhost/x"), { params });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PROGRESS);

  called = 0;
  const denied = createChannelCollectionDepthHandlers({ getSession: async () => null, core });
  assert.equal((await denied.GET(new Request("http://localhost/x"), { params })).status, 401);
  assert.equal((await denied.POST(post({}), { params })).status, 401);
  assert.equal(called, 0);
});

test("channel collection-depth route: POST sets the override for the URL's channel (the URL wins over a body channelId) and returns the new progress", async () => {
  let received: unknown;
  const handlers = createChannelCollectionDepthHandlers({
    getSession: async () => ({ user: { id: "u1" } }),
    core: {
      async getChannelCollectionProgress() {
        return PROGRESS;
      },
      async setChannelCollectionDepth(input: unknown) {
        received = input;
      },
    },
  });
  const response = await handlers.POST(post({ maxVideosPerChannel: 120, publishedAfter: "2026-01-01", channelId: "UCother" }), { params });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { maxVideosPerChannel: 120, publishedAfter: "2026-01-01", channelId: CHANNEL });
  assert.deepEqual(await response.json(), PROGRESS);
});

test("channel collection-depth route: a channel that is not on the watchlist maps its DomainError code", async () => {
  const handlers = createChannelCollectionDepthHandlers({
    getSession: async () => ({ user: { id: "u1" } }),
    core: {
      async getChannelCollectionProgress() {
        throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry", details: {} });
      },
      async setChannelCollectionDepth() {},
    },
  });
  const response = await handlers.GET(new Request("http://localhost/x"), { params });
  assert.notEqual(response.status, 200);
  assert.equal((await response.json()).error, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});
