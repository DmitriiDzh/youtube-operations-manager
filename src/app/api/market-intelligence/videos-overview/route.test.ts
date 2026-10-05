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
