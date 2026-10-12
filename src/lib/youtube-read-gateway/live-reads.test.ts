import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { getLiveBroadcasts, getLiveStreamStatuses, getLiveViewerCounts, readLiveStreamIngestion } from "./data-api";

// Expected shapes come from the liveBroadcast / liveStream resource pages and the list methods' pages
// (developers.google.com/youtube/v3/live/docs, "Last updated 2026-09-14"): list takes at most 50 ids, and
// `liveStreams.list` accepts the parts id, snippet, cdn and status.

type Call = { method: string; params: { part?: string[]; id?: string[]; maxResults?: number } };

function fakeClient(responder: (method: string, params: Call["params"]) => unknown) {
  const calls: Call[] = [];
  const record = (method: string) => async (params: Call["params"]) => {
    calls.push({ method, params });
    return { data: responder(method, params) };
  };
  const youtube = {
    liveBroadcasts: { list: record("liveBroadcasts.list") },
    liveStreams: { list: record("liveStreams.list") },
    videos: { list: record("videos.list") },
  } as unknown as youtube_v3.Youtube;
  return { youtube, calls };
}

const KEY = "k3y-TEST-0000";

test("getLiveBroadcasts maps the lifecycle, privacy, bound stream and the snippet an update must echo", async () => {
  const { youtube, calls } = fakeClient(() => ({
    items: [
      {
        id: "BC1",
        snippet: {
          title: "Tropico Jazz Radio",
          description: "24/7",
          scheduledStartTime: "2026-10-12T12:02:00Z",
          actualStartTime: "2026-10-12T12:02:41Z",
          categoryId: "10",
        },
        status: { lifeCycleStatus: "live", privacyStatus: "unlisted" },
        contentDetails: { boundStreamId: "STREAM1" },
      },
    ],
  }));
  const [broadcast] = await getLiveBroadcasts(youtube, ["BC1"]);
  assert.deepEqual(calls[0].params.id, ["BC1"]);
  assert.deepEqual(broadcast, {
    broadcastId: "BC1",
    title: "Tropico Jazz Radio",
    description: "24/7",
    scheduledStartTime: "2026-10-12T12:02:00Z",
    scheduledEndTime: null,
    actualStartTime: "2026-10-12T12:02:41Z",
    actualEndTime: null,
    lifeCycleStatus: "live",
    privacyStatus: "unlisted",
    boundStreamId: "STREAM1",
    categoryId: "10",
  });
});

test("live list reads ask for at most 50 ids per call (51 ids -> 2 calls)", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `ID${i}`);
  for (const read of [getLiveBroadcasts, getLiveStreamStatuses, getLiveViewerCounts] as const) {
    const { youtube, calls } = fakeClient(() => ({ items: [] }));
    await read(youtube, ids);
    assert.deepEqual(calls.map((c) => c.params.id?.length), [50, 1], read.name);
  }
});

test("getLiveStreamStatuses never requests cdn, so a status poll cannot carry the key", async () => {
  const { youtube, calls } = fakeClient(() => ({
    items: [
      {
        id: "STREAM1",
        status: {
          streamStatus: "active",
          healthStatus: {
            status: "ok",
            lastUpdateTimeSeconds: "1791806935",
            configurationIssues: [{ type: "bitrateLow", severity: "warning", reason: "Low bitrate", description: "…" }],
          },
        },
      },
    ],
  }));
  const [status] = await getLiveStreamStatuses(youtube, ["STREAM1"]);
  assert.ok(!calls[0].params.part?.includes("cdn"));
  assert.deepEqual(status, {
    streamId: "STREAM1",
    streamStatus: "active",
    healthStatus: "ok",
    configurationIssues: [{ type: "bitrateLow", severity: "warning" }],
    healthUpdatedAt: 1791806935,
  });
});

test("readLiveStreamIngestion returns the RTMPS address and key of the asked stream only", async () => {
  const { youtube, calls } = fakeClient(() => ({
    items: [
      { id: "OTHER", cdn: { ingestionInfo: { rtmpsIngestionAddress: "rtmps://other", streamName: "other-key" } } },
      { id: "STREAM1", cdn: { ingestionInfo: { rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2", streamName: KEY } } },
    ],
  }));
  const ingestion = await readLiveStreamIngestion(youtube, "STREAM1");
  assert.ok(calls[0].params.part?.includes("cdn"));
  assert.deepEqual(calls[0].params.id, ["STREAM1"]);
  assert.deepEqual(ingestion, { rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2", streamName: KEY });
});

test("readLiveStreamIngestion is null when the stream is unknown or YouTube returns no RTMPS address or no key", async () => {
  const cases = [
    { items: [] },
    { items: [{ id: "STREAM1", cdn: { ingestionInfo: { streamName: KEY } } }] },
    { items: [{ id: "STREAM1", cdn: { ingestionInfo: { rtmpsIngestionAddress: "rtmps://x/live2" } } }] },
  ];
  for (const data of cases) {
    const { youtube } = fakeClient(() => data);
    assert.equal(await readLiveStreamIngestion(youtube, "STREAM1"), null, JSON.stringify(data));
  }
});

test("getLiveViewerCounts: concurrent viewers per video; missing or non-numeric is null", async () => {
  const { youtube, calls } = fakeClient(() => ({
    items: [
      { id: "BC1", liveStreamingDetails: { concurrentViewers: "17" } },
      { id: "BC2", liveStreamingDetails: {} },
      { id: "BC3", liveStreamingDetails: { concurrentViewers: "n/a" } },
    ],
  }));
  const viewers = await getLiveViewerCounts(youtube, ["BC1", "BC2", "BC3"]);
  assert.ok(calls[0].params.part?.includes("liveStreamingDetails"));
  assert.deepEqual(viewers, { BC1: 17, BC2: null, BC3: null });
});
