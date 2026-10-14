import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { DomainError } from "./contracts";
import {
  bindLiveBroadcast,
  insertLiveBroadcast,
  insertLiveStream,
  transitionLiveBroadcast,
  updateLiveBroadcast,
} from "./index";

// Expected request shapes come from the official reference pages
// (developers.google.com/youtube/v3/live/docs/{liveStreams,liveBroadcasts}/*, "Last updated 2026-09-14"),
// and from the plan's decisions (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.9), not from the implementation.

type Call = { method: string; params: unknown };

function fakeClient(responses: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const record = (method: string) => async (params: unknown) => {
    calls.push({ method, params });
    return { data: responses[method] ?? {} };
  };
  const youtube = {
    liveStreams: { insert: record("liveStreams.insert") },
    liveBroadcasts: {
      insert: record("liveBroadcasts.insert"),
      bind: record("liveBroadcasts.bind"),
      transition: record("liveBroadcasts.transition"),
      update: record("liveBroadcasts.update"),
    },
  } as unknown as youtube_v3.Youtube;
  return { youtube, calls };
}

test("insertLiveStream: a reusable RTMP stream with the required title, frameRate, ingestionType and resolution", async () => {
  const { youtube, calls } = fakeClient({
    "liveStreams.insert": { id: "STREAM1", cdn: { ingestionInfo: { streamName: "k3y-TEST-0000", rtmpsIngestionAddress: "rtmps://x/live2" } } },
  });
  const result = await insertLiveStream(youtube, { title: "Tropico 24/7", format: { resolution: "1080p", frameRate: "30fps" } });

  assert.equal(calls.length, 1);
  const params = calls[0].params as youtube_v3.Params$Resource$Livestreams$Insert;
  assert.deepEqual([...(params.part ?? [])].sort(), ["cdn", "contentDetails", "id", "snippet"]);
  assert.deepEqual(params.requestBody, {
    snippet: { title: "Tropico 24/7" },
    cdn: { ingestionType: "rtmp", resolution: "1080p", frameRate: "30fps" },
    contentDetails: { isReusable: true },
  });
  // Only the id comes back -- never the key YouTube returned with it.
  assert.deepEqual(result, { streamId: "STREAM1" });
  assert.ok(!JSON.stringify(result).includes("k3y-TEST-0000"));
});

test("insertLiveStream: a response without an id is an error, not an empty id", async () => {
  const { youtube } = fakeClient({ "liveStreams.insert": {} });
  await assert.rejects(() => insertLiveStream(youtube, { title: "t", format: { resolution: "1080p", frameRate: "30fps" } }));
});

test("insertLiveBroadcast: sends the three required properties and the plan's auto-start on, auto-stop off, monitor stream off, recording off", async () => {
  const { youtube, calls } = fakeClient({ "liveBroadcasts.insert": { id: "BC1", status: { lifeCycleStatus: "created" } } });
  const result = await insertLiveBroadcast(youtube, {
    title: "Tropico Jazz Radio",
    description: "Live 24/7",
    scheduledStartTime: "2026-10-12T12:02:00.000Z",
    privacyStatus: "unlisted",
    selfDeclaredMadeForKids: false,
    enableAutoStart: true,
    enableAutoStop: false,
    enableMonitorStream: false,
    recordFromStart: false,
  });

  const params = calls[0].params as youtube_v3.Params$Resource$Livebroadcasts$Insert;
  assert.deepEqual([...(params.part ?? [])].sort(), ["contentDetails", "id", "snippet", "status"]);
  assert.deepEqual(params.requestBody, {
    snippet: { title: "Tropico Jazz Radio", description: "Live 24/7", scheduledStartTime: "2026-10-12T12:02:00.000Z" },
    status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: true, enableAutoStop: false, monitorStream: { enableMonitorStream: false }, recordFromStart: false },
  });
  assert.deepEqual(result, { broadcastId: "BC1", lifeCycleStatus: "created" });
});

test("bindLiveBroadcast: sends the broadcast id and the stream id, no request body", async () => {
  const { youtube, calls } = fakeClient({ "liveBroadcasts.bind": { id: "BC1", contentDetails: { boundStreamId: "STREAM1" } } });
  const result = await bindLiveBroadcast(youtube, { broadcastId: "BC1", streamId: "STREAM1" });

  const params = calls[0].params as youtube_v3.Params$Resource$Livebroadcasts$Bind & { requestBody?: unknown };
  assert.equal(params.id, "BC1");
  assert.equal(params.streamId, "STREAM1");
  assert.equal(params.requestBody, undefined);
  assert.ok(params.part && params.part.length > 0);
  assert.deepEqual(result, { boundStreamId: "STREAM1" });
});

test("bindLiveBroadcast: an empty or blank stream id is refused before any call (bind without streamId unbinds)", async () => {
  for (const streamId of ["", "   "]) {
    const { youtube, calls } = fakeClient();
    await assert.rejects(
      () => bindLiveBroadcast(youtube, { broadcastId: "BC1", streamId }),
      (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
    );
    assert.equal(calls.length, 0);
  }
});

test("transitionLiveBroadcast: live and complete are sent as broadcastStatus with the broadcast id", async () => {
  for (const broadcastStatus of ["live", "complete"] as const) {
    const { youtube, calls } = fakeClient({ "liveBroadcasts.transition": { id: "BC1", status: { lifeCycleStatus: broadcastStatus } } });
    const result = await transitionLiveBroadcast(youtube, { broadcastId: "BC1", broadcastStatus });
    const params = calls[0].params as youtube_v3.Params$Resource$Livebroadcasts$Transition;
    assert.equal(params.id, "BC1");
    assert.equal(params.broadcastStatus, broadcastStatus);
    assert.deepEqual(result, { lifeCycleStatus: broadcastStatus });
  }
});

test("transitionLiveBroadcast: testing (or anything else) is refused before any call", async () => {
  for (const broadcastStatus of ["testing", "", "LIVE"]) {
    const { youtube, calls } = fakeClient();
    await assert.rejects(
      () => transitionLiveBroadcast(youtube, { broadcastId: "BC1", broadcastStatus: broadcastStatus as "live" }),
      (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
    );
    assert.equal(calls.length, 0);
  }
});

test("updateLiveBroadcast: sends the full snippet with scheduledStartTime and the privacy; never contentDetails", async () => {
  const { youtube, calls } = fakeClient();
  await updateLiveBroadcast(youtube, {
    broadcastId: "BC1",
    snippet: { title: "New title", description: "New description", scheduledStartTime: "2026-10-12T12:02:00Z" },
    privacyStatus: "public",
  });

  const params = calls[0].params as youtube_v3.Params$Resource$Livebroadcasts$Update;
  assert.ok(!params.part?.includes("contentDetails"));
  assert.ok(params.part?.includes("snippet") && params.part?.includes("status"));
  assert.deepEqual(params.requestBody, {
    id: "BC1",
    snippet: { title: "New title", description: "New description", scheduledStartTime: "2026-10-12T12:02:00Z" },
    status: { privacyStatus: "public" },
  });
});

test("updateLiveBroadcast: the current scheduledEndTime is sent back, so the wholesale replacement does not delete it", async () => {
  const { youtube, calls } = fakeClient();
  await updateLiveBroadcast(youtube, {
    broadcastId: "BC1",
    snippet: { title: "t", description: "d", scheduledStartTime: "2026-10-12T12:02:00Z", scheduledEndTime: "2026-10-13T12:02:00Z" },
    privacyStatus: "unlisted",
  });
  const body = (calls[0].params as youtube_v3.Params$Resource$Livebroadcasts$Update).requestBody;
  assert.equal(body?.snippet?.scheduledEndTime, "2026-10-13T12:02:00Z");
});

test("updateLiveBroadcast: a missing scheduledStartTime is refused before any call (required by liveBroadcasts.update)", async () => {
  const { youtube, calls } = fakeClient();
  await assert.rejects(
    () =>
      updateLiveBroadcast(youtube, {
        broadcastId: "BC1",
        snippet: { title: "t", description: "d", scheduledStartTime: "" },
        privacyStatus: "unlisted",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
  assert.equal(calls.length, 0);
});
