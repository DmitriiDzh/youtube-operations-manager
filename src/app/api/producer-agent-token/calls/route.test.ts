import assert from "node:assert/strict";
import test from "node:test";
import { createProducerCallsGetHandler } from "./route";

// docs/roadmap/plans/PRODUCER_ROLE_PLAN.md AC-PR-09: the owner sees what the Producer looked at -- operator-only (401 without a Web
// session, before the log is read), newest first as stored, each channel named by its title when this device knows it.

test("AC-PR-09: without a Web session the call log is not read", async () => {
  const response = await createProducerCallsGetHandler({
    getSession: async () => null,
    listCalls: async () => {
      throw new Error("must not be called");
    },
    channelTitles: async () => new Map(),
  })();
  assert.equal(response.status, 401);
});

test("AC-PR-09: the calls come back as stored, with channel titles where known", async () => {
  let asked = 0;
  const response = await createProducerCallsGetHandler({
    getSession: async () => ({ user: { id: "owner" } }),
    listCalls: async (limit) => {
      asked = limit;
      return [
        { at: new Date("2026-10-09T10:05:00Z"), tool: "agent_query_channel_reach", channelId: "UC_T", outcome: "ok", errorCode: null },
        { at: new Date("2026-10-09T10:04:00Z"), tool: "channel_video_list", channelId: "UC_GONE", outcome: "error", errorCode: "CHANNEL_NOT_ACTIVE" },
        { at: new Date("2026-10-09T10:03:00Z"), tool: "producer_list_channels", channelId: null, outcome: "ok", errorCode: null },
      ];
    },
    channelTitles: async () => new Map([["UC_T", "Tropico Jazz"]]),
  })();
  assert.equal(response.status, 200);
  assert.equal(asked, 30);
  assert.deepEqual((await response.json()).calls, [
    { at: "2026-10-09T10:05:00.000Z", tool: "agent_query_channel_reach", channelId: "UC_T", channelTitle: "Tropico Jazz", outcome: "ok", errorCode: null },
    { at: "2026-10-09T10:04:00.000Z", tool: "channel_video_list", channelId: "UC_GONE", channelTitle: null, outcome: "error", errorCode: "CHANNEL_NOT_ACTIVE" },
    { at: "2026-10-09T10:03:00.000Z", tool: "producer_list_channels", channelId: null, channelTitle: null, outcome: "ok", errorCode: null },
  ]);
});
