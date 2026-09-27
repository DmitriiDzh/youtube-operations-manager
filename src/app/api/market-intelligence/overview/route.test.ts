import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createOverviewGetHandler } from "./route";

test("overview route GET: returns the core's result", async () => {
  const handler = createOverviewGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getMarketOverview() {
        return { watchlistCount: 3 } as never;
      },
    },
  });

  const response = await handler();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.watchlistCount, 3);
});

test("overview route GET: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createOverviewGetHandler({
    getSession: async () => null,
    core: {
      async getMarketOverview() {
        called = true;
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler();
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("overview route GET: a DomainError from the core is mapped to its own error code", async () => {
  const handler = createOverviewGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getMarketOverview() {
        throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry", details: {} });
      },
    },
  });

  const response = await handler();
  const payload = await response.json();
  assert.equal(payload.error, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});

test("overview route GET: an unexpected error maps to a 500", async () => {
  const handler = createOverviewGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getMarketOverview() {
        throw new Error("boom");
      },
    },
  });

  const response = await handler();
  assert.equal(response.status, 500);
});
