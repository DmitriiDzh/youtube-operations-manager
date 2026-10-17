import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError, type SharedCostRun, type VideoCostsReport } from "./contracts";
import { createVideoCostsShareCore, type VideoCostsReportStore } from "./services";

// BL-194 stage 3 (VIDEO_COST_PLAN.md §2 stage 3, §4 criteria 5 and 9, ADR 0041): the video-costs report -- a per-device report whose
// peers are kept (their runs stay counted), strict, with no field that could carry a prompt, a path, a key or a provider's text.

function memoryStore(): VideoCostsReportStore {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    readLocal: async () => local,
    writeLocal: async (json) => void (local = json),
    readPeers: async () => ({ ...peers }),
    writePeer: async (deviceId, json) => void (peers[deviceId] = json),
  };
}

const run = (over: Partial<SharedCostRun> = {}): SharedCostRun => ({
  runId: "gemini:g1",
  source: "gemini",
  kind: "job",
  channelId: "UC1",
  video: "V49",
  label: "gemini-omni-1.1-flash",
  mediaKind: "video",
  storyboardId: "sb_bar",
  storyboardVersion: 2,
  segmentId: "s1",
  planId: null,
  status: "done",
  usd: 0.8,
  basis: "usage",
  overheadUsd: null,
  gpuSeconds: null,
  createdAt: "2026-10-17T09:00:00.000Z",
  finishedAt: "2026-10-17T09:01:00.000Z",
  ...over,
});
const report = (deviceId: string, runs: SharedCostRun[]): VideoCostsReport => ({ format: "ytm-video-costs", version: 1, deviceId, hostName: "WIN-PC", updatedAt: "2026-10-17T09:05:00.000Z", runs });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const refused = (e: unknown) => isDomainError(e) && e.code === "validation_failed";

test("BL-194: a peer's cost report is kept however long that computer is quiet", async () => {
  let now = new Date("2026-10-17T10:00:00.000Z");
  const core = createVideoCostsShareCore({ store: memoryStore(), ownDeviceId: async () => "mac", clock: { now: () => now } });
  assert.deepEqual(await core.mergeIncoming(bytes(report("win", [run()])), "win"), { accepted: true });
  now = new Date("2026-12-17T10:00:00.000Z");
  assert.deepEqual((await core.listPeerReports()).map((r) => [r.deviceId, r.runs[0].usd]), [["win", 0.8]]);
});

test("BL-194 criterion 9: a cost line refuses anything beyond its fields (a prompt, a path, a key), a malformed video and a negative cost", async () => {
  const core = createVideoCostsShareCore({ store: memoryStore(), ownDeviceId: async () => "mac", clock: { now: () => new Date("2026-10-17T10:00:00.000Z") } });
  for (const extra of [{ prompt: "a cat" }, { path: "/Users/x/out.mp4" }, { apiKey: "rpa_x" }]) {
    await assert.rejects(core.mergeIncoming(bytes(report("win", [{ ...run(), ...extra } as SharedCostRun])), "win"), refused, Object.keys(extra)[0]);
  }
  await assert.rejects(core.mergeIncoming(bytes(report("win", [run({ video: "V049" })])), "win"), refused);
  await assert.rejects(core.mergeIncoming(bytes(report("win", [run({ usd: -1 })])), "win"), refused);
  await assert.rejects(core.mergeIncoming(bytes(report("win", [run({ runId: "other:x" })])), "win"), refused);
  await assert.rejects(core.mergeIncoming(bytes(report("win", [run()])), "other"), refused, "a file naming another device");
  await assert.rejects(core.publishLocalReport(report("win", [run()])), refused, "this computer publishes only its own report");
});
