import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createIntelligenceSummaryGetHandler } from "./route";

function makeRequest() {
  return new Request("http://localhost/api/market-intelligence/channels/UC1234567890123456789012/intelligence-summary");
}

const params = Promise.resolve({ channelId: "UC1234567890123456789012" });

test("intelligence-summary route GET: forwards channelId and returns the core's result", async () => {
  let receivedInput: unknown;
  const handler = createIntelligenceSummaryGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getChannelIntelligenceSummary(input: unknown) {
        receivedInput = input;
        return { channel: { channelId: "UC1234567890123456789012" } } as never;
      },
    },
  });

  const response = await handler(makeRequest(), { params });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(receivedInput, { channelId: "UC1234567890123456789012" });
  assert.equal(payload.channel.channelId, "UC1234567890123456789012");
});

test("intelligence-summary route GET: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createIntelligenceSummaryGetHandler({
    getSession: async () => null,
    core: {
      async getChannelIntelligenceSummary() {
        called = true;
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler(makeRequest(), { params });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("intelligence-summary route GET: a DomainError from the core is mapped to its own error code", async () => {
  const handler = createIntelligenceSummaryGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getChannelIntelligenceSummary() {
        throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry", details: {} });
      },
    },
  });

  const response = await handler(makeRequest(), { params });
  const payload = await response.json();
  assert.equal(payload.error, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});
