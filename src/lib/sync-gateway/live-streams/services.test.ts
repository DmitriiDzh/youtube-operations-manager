import assert from "node:assert/strict";
import test from "node:test";
import { liveStreamsReportSchema, type LiveStreamsReport } from "./contracts";
import { createLiveStreamsShareCore, type LiveStreamsReportStore } from "./services";

// BL-176 acceptance, LIVE_STREAMS_PLAN.md §4.1 "Report": the strict schema rejects any extra field; no field can hold a URL or a
// key; a newer report version is refused as "update the app" (an older build ignores the family altogether: it is registered
// in code, so it never reads it).

const KEY = "k3y-TEST-0000";
const report = (overrides: Partial<LiveStreamsReport> = {}): LiveStreamsReport => ({
  format: "ytm-live-streams",
  version: 1,
  deviceId: "mac-1",
  hostName: "Mac mini",
  updatedAt: "2026-10-12T12:00:00.000Z",
  streams: [
    {
      channelId: "UC1",
      state: "live",
      since: "2026-10-12T10:00:00.000Z",
      playing: { index: 1, total: 3, videoId: "BBBBBBBBBB2" },
      health: { lifeCycleStatus: "live", streamStatus: "active", healthStatus: "good", issueTypes: ["bitrateLow"] },
      lastInterruption: { at: "2026-10-12T11:00:00.000Z", cause: "encoder_exit" },
      viewers: 12,
    },
  ],
  ...overrides,
});

test("a well-formed report passes", () => {
  assert.equal(liveStreamsReportSchema.safeParse(report()).success, true);
});

test("an extra field anywhere is rejected", () => {
  assert.equal(liveStreamsReportSchema.safeParse({ ...report(), ingestUrl: "x" }).success, false);
  const stream = { ...report().streams[0], streamKey: KEY };
  assert.equal(liveStreamsReportSchema.safeParse({ ...report(), streams: [stream] }).success, false);
  const health = { ...report().streams[0].health!, description: "x" };
  assert.equal(liveStreamsReportSchema.safeParse({ ...report(), streams: [{ ...report().streams[0], health }] }).success, false);
});

test("no field can hold a URL or a key", () => {
  const s = report().streams[0];
  const bad = [
    { ...s, playing: { ...s.playing!, videoId: `rtmps://x/${KEY}` } },
    { ...s, lastInterruption: { at: s.lastInterruption!.at, cause: `rtmps://a.rtmps.youtube.com/live2/${KEY}` } },
    { ...s, health: { ...s.health!, lifeCycleStatus: `live/${KEY}` } },
    { ...s, health: { ...s.health!, issueTypes: [`https://x/${KEY}`] } },
    { ...s, channelId: "rtmps://x" },
  ];
  for (const stream of bad) assert.equal(liveStreamsReportSchema.safeParse({ ...report(), streams: [stream] }).success, false, JSON.stringify(stream));
  assert.equal(liveStreamsReportSchema.safeParse({ ...report(), hostName: "rtmps://x/y" }).success, false);
});

function memoryStore(): LiveStreamsReportStore {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    readLocal: async () => local,
    writeLocal: async (json) => void (local = json),
    readPeers: async () => ({ ...peers }),
    writePeer: async (id, json) => void (peers[id] = json),
  };
}

test("a peer's report is kept and listed; a newer version is refused as 'update the app'", async () => {
  const windows = createLiveStreamsShareCore({ store: memoryStore(), ownDeviceId: async () => "win-1", clock: { now: () => new Date("2026-10-12T12:01:00Z") } });
  await windows.mergeIncoming(new TextEncoder().encode(JSON.stringify(report())), "mac-1");
  assert.deepEqual((await windows.listPeerReports()).map((r) => r.streams[0].state), ["live"]);
  await assert.rejects(() => windows.mergeIncoming(new TextEncoder().encode(JSON.stringify({ ...report(), version: 2 })), "mac-1"), /newer than this app understands/);
});
