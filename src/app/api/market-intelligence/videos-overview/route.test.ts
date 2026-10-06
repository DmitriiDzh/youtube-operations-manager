import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createVideosOverviewGetHandler } from "./route";

test("videos-overview route GET: returns the core's result", async () => {
  const handler = createVideosOverviewGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getMarketVideosOverview() {
        return { videos: [{ videoId: "v1" }] } as never;
      },
    },
  });

  const response = await handler();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.videos, [{ videoId: "v1" }]);
});

test("videos-overview route GET: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createVideosOverviewGetHandler({
    getSession: async () => null,
    core: {
      async getMarketVideosOverview() {
        called = true;
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler();
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("videos-overview route GET: a DomainError from the core is mapped to its own error code", async () => {
  const handler = createVideosOverviewGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getMarketVideosOverview() {
        throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry", details: {} });
      },
    },
  });

  const response = await handler();
  const payload = await response.json();
  assert.equal(payload.error, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});

test("videos-overview route GET: an unexpected error maps to a 500", async () => {
  const handler = createVideosOverviewGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getMarketVideosOverview() {
        throw new Error("boom");
      },
    },
  });

  const response = await handler();
  assert.equal(response.status, 500);
});

test("BL-140 AC-R2-1/4: with ?page= the route returns one page; without it the old response", async () => {
  const videos = Array.from({ length: 120 }, (_, i) => ({
    videoId: `v${i}`,
    channelId: "c1",
    channelHandleOrUrl: "@c1",
    title: `Video ${i}`,
    publishedAt: new Date(Date.UTC(2026, 9, 6) - i * 3_600_000).toISOString(),
    viewCount: i,
    observedAt: "2026-10-06T12:00:00.000Z",
    velocity: { value: null, basis: "withheld_by_policy" },
    breakout: null,
    topics: [],
  }));
  const handler = createVideosOverviewGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: { getMarketVideosOverview: async () => ({ videos, methodology: {} }) as never },
  });
  const paged = await (await handler(new Request("http://localhost/api/market-intelligence/videos-overview?page=3"))).json();
  assert.equal(paged.total, 120);
  assert.deepEqual(paged.rows.map((r: { videoId: string }) => r.videoId), Array.from({ length: 20 }, (_, i) => `v${100 + i}`));
  const old = await (await handler(new Request("http://localhost/api/market-intelligence/videos-overview"))).json();
  assert.equal(old.videos.length, 120);
});
