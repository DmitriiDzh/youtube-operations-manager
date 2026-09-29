import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createSnapshotHistoryGetHandler } from "./route";

function makeRequest() {
  return new Request(
    "http://localhost/api/market-intelligence/channels/UC1234567890123456789012/videos/dQw4w9WgXcQ/snapshot-history"
  );
}

const params = Promise.resolve({ channelId: "UC1234567890123456789012", videoId: "dQw4w9WgXcQ" });

test("snapshot-history route GET: forwards channelId/videoId and returns the core's bounded result", async () => {
  let receivedInput: unknown;
  const handler = createSnapshotHistoryGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getChannelVideoSnapshotHistory(input: unknown) {
        receivedInput = input;
        return { snapshots: [] };
      },
    },
  });

  const response = await handler(makeRequest(), { params });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(receivedInput, { channelId: "UC1234567890123456789012", videoId: "dQw4w9WgXcQ" });
  assert.deepEqual(payload.snapshots, []);
});

test("snapshot-history route GET: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createSnapshotHistoryGetHandler({
    getSession: async () => null,
    core: {
      async getChannelVideoSnapshotHistory() {
        called = true;
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler(makeRequest(), { params });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("snapshot-history route GET: a DomainError from the core is mapped to its own error code", async () => {
  const handler = createSnapshotHistoryGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getChannelVideoSnapshotHistory() {
        throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry", details: {} });
      },
    },
  });

  const response = await handler(makeRequest(), { params });
  const payload = await response.json();
  assert.equal(payload.error, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});
