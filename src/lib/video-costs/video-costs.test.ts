import assert from "node:assert/strict";
import test from "node:test";
import type { VideoCostRunpodJobRow, VideoCostGeminiJobRow } from "@/lib/db";
import type { VideoCostsReport } from "@/lib/sync-gateway";
import { isDomainError, type OwnRunRows, type StoryboardPicks, type VideoCostFile, type VideoCostsDeps, type VideoStateInfo } from "./contracts";
import { createVideoCostsService } from "./services";

// BL-194 stage 3 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 3, §4 criteria 3-6 and 9, ADR 0041). The expected totals are worked
// out by hand from the rows below: a video's total is the sum of every computer's runs linked to it -- RunPod shares of their
// session's charge, RunPod sessions without jobs, Gemini costs (an estimate while unknown) -- the same on every computer once their
// reports are read.

const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-17T12:00:00.000Z");

const runpod = (id: string, over: Partial<VideoCostRunpodJobRow> = {}): VideoCostRunpodJobRow => ({
  id,
  sessionId: "s1",
  channelId: "UC1",
  templateId: "wan-flf",
  templateName: "Wan first/last frame",
  status: "done",
  outputsJson: JSON.stringify([{ kind: "videos" }]),
  video: "V49",
  planId: null,
  storyboardId: "sb_bar",
  storyboardVersion: 2,
  segmentId: "s1",
  gpuSeconds: 60,
  allocatedUsd: 0.6667,
  overheadUsd: 0.6067,
  allocationBasis: "measured",
  createdAt: at("2026-10-17T10:00:00.000Z"),
  finishedAt: at("2026-10-17T10:01:10.000Z"),
  ...over,
});
const gemini = (jobId: string, over: Partial<VideoCostGeminiJobRow> = {}): VideoCostGeminiJobRow => ({
  jobId,
  channelId: "UC1",
  kind: "video",
  model: "gemini-omni-1.1-flash",
  status: "done",
  estimateUsd: 0.8,
  costUsd: 0.7421,
  costBasis: "usage",
  video: "V49",
  storyboardId: "sb_bar",
  storyboardVersion: 2,
  segmentId: "s2",
  createdAt: at("2026-10-17T11:00:00.000Z"),
  finishedAt: at("2026-10-17T11:01:00.000Z"),
  ...over,
});
const none = (): OwnRunRows => ({ runpod: [], sessions: [], gemini: [] });

type World = { reports: Map<string, VideoCostsReport>; files: Map<string, VideoCostFile>; storyboards: StoryboardPicks[]; states: Map<string, VideoStateInfo> };
const world = (): World => ({ reports: new Map(), files: new Map(), storyboards: [], states: new Map([["V49", { state: "in_work", folder: "04 Videos/10 October/1017 V49" }]]) });

/** One computer: its own rows, and every OTHER computer's last published report from the shared world (the sync carried it). */
function computer(deviceId: string, w: World, rows: () => OwnRunRows, over: Partial<VideoCostsDeps> = {}) {
  const writes: string[] = [];
  const service = createVideoCostsService({
    ownRows: async () => rows(),
    peers: async () => [...w.reports.values()].filter((r) => r.deviceId !== deviceId),
    publishReport: async (report) => void w.reports.set(report.deviceId, structuredClone(report)),
    ownDevice: async () => ({ deviceId, hostName: deviceId === "mac" ? "Mac" : "WIN-PC" }),
    isChannelConnected: async (channelId) => channelId === "UC1",
    storyboards: async () => w.storyboards,
    videoStates: async () => w.states,
    costFiles: {
      read: async (_c, p) => w.files.get(p) ?? null,
      write: async (_c, p, doc) => {
        writes.push(p);
        w.files.set(p, structuredClone(doc));
      },
    },
    now: () => NOW,
    ...over,
  });
  return { service, writes };
}

test("criterion 4: a Gemini job keeps its own cost_usd; one still running counts its estimate, marked as an estimate", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), gemini: [gemini("g1"), gemini("g2", { status: "running", costUsd: null, costBasis: null, estimateUsd: 0.4, finishedAt: null }), gemini("g3", { status: "failed", costUsd: 0.8, costBasis: "unknown_outcome" })] }));
  const detail = await mac.service.videoCost({ channelId: "UC1", video: "V49" });
  const byId = Object.fromEntries(detail.runs.map((r) => [r.runId, r]));
  assert.equal(byId["gemini:g1"].usd, 0.7421);
  assert.equal(byId["gemini:g1"].estimate, false);
  assert.equal(byId["gemini:g2"].usd, 0.4);
  assert.equal(byId["gemini:g2"].basis, "estimate");
  assert.equal(byId["gemini:g2"].estimate, true);
  assert.equal(byId["gemini:g3"].estimate, true, "unknown outcome: the estimate is counted so the spend is never under-counted");
  assert.deepEqual(detail.totals, { runpodUsd: 0, geminiUsd: 1.9421, totalUsd: 1.9421, runs: 3, estimated: true });
});

test("criterion 3 (totals): RunPod shares are the session's split; a session without jobs is a session-level line for its plan's video", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({
    runpod: [runpod("a"), runpod("b", { gpuSeconds: 30, allocatedUsd: 0.3333, overheadUsd: 0.3033, video: "V50" })],
    sessions: [{ id: "idle", channelId: "UC1", planId: "plan-1", planVideo: "V49", usdCharged: 0.12, createdAt: at("2026-10-17T09:00:00.000Z"), stoppedAt: at("2026-10-17T09:05:00.000Z") }],
    gemini: [],
  }));
  const v49 = await mac.service.videoCost({ channelId: "UC1", video: "V49" });
  assert.deepEqual(v49.totals, { runpodUsd: 0.7867, geminiUsd: 0, totalUsd: 0.7867, runs: 2, estimated: false });
  assert.equal(v49.runs.find((r) => r.runId === "session:idle")?.result, "session");
  const summary = await mac.service.summary({ channelId: "UC1" });
  assert.deepEqual(
    summary.videos.map((v) => [v.video, v.totals.totalUsd]),
    [
      ["V50", 0.3333],
      ["V49", 0.7867],
    ]
  );
});

test("a RunPod job of a session still running counts 0 until the session ends, marked as an estimate (pending)", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), runpod: [runpod("a", { status: "generating", allocatedUsd: null, overheadUsd: null, allocationBasis: null, gpuSeconds: null, finishedAt: null })] }));
  const [run] = (await mac.service.videoCost({ channelId: "UC1", video: "V49" })).runs;
  assert.deepEqual([run.usd, run.basis, run.estimate, run.result], [0, "pending", true, "active"]);
});

test("criterion 5: once the two computers' reports have synced, V49 shows the same total on both", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), runpod: [runpod("a")] }));
  const win = computer("win", w, () => ({ ...none(), gemini: [gemini("g1")] }));
  // Before the sync each one knows only its own runs.
  assert.equal((await mac.service.videoCost({ channelId: "UC1", video: "V49" })).totals.totalUsd, 0.6667);
  await mac.service.publishOwnReport();
  await win.service.publishOwnReport();
  const onMac = await mac.service.videoCost({ channelId: "UC1", video: "V49" });
  const onWin = await win.service.videoCost({ channelId: "UC1", video: "V49" });
  assert.deepEqual(onMac.totals, { runpodUsd: 0.6667, geminiUsd: 0.7421, totalUsd: 1.4088, runs: 2, estimated: false });
  assert.deepEqual(onWin.totals, onMac.totals);
  assert.deepEqual(
    onMac.runs.map((r) => [r.runId, r.hostName, r.thisComputer]),
    [
      ["gemini:g1", "WIN-PC", false],
      ["runpod:a", "Mac", true],
    ]
  );
  assert.deepEqual(
    onWin.computers.map((c) => [c.deviceId, c.thisComputer]).sort(),
    [
      ["mac", false],
      ["win", true],
    ]
  );
});

test("a run's result: the owner's pick or a render's take is chosen, another take of a segment rejected, a failure failed, others a test", async () => {
  const w = world();
  w.storyboards = [{ id: "sb_bar", picks: { "2": { s1: { source: "media", jobId: "a" } } }, renders: { r1: { picks: { s2: { source: "gemini", jobId: "g1" } } } } }];
  const mac = computer("mac", w, () => ({
    runpod: [runpod("a"), runpod("b"), runpod("c", { status: "failed" }), runpod("t", { storyboardId: null, storyboardVersion: null, segmentId: null })],
    sessions: [],
    gemini: [gemini("g1"), gemini("g9")],
  }));
  const results = Object.fromEntries((await mac.service.videoCost({ channelId: "UC1", video: "V49" })).runs.map((r) => [r.runId, r.result]));
  assert.deepEqual(results, { "runpod:a": "chosen", "runpod:b": "rejected", "runpod:c": "failed", "runpod:t": "test", "gemini:g1": "chosen", "gemini:g9": "rejected" });
});

test("runs linked to no video are «не привязано» in the summary, never in a video's total", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), gemini: [gemini("g1", { video: null }), gemini("g2")] }));
  const summary = await mac.service.summary({ channelId: "UC1" });
  assert.equal(summary.unlinked.totalUsd, 0.7421);
  assert.deepEqual(summary.videos.map((v) => [v.video, v.totals.runs]), [["V49", 1]]);
});

test("the report keeps a bounded window: runs of a cancelled video go, a published video's after 120 days, unlinked ones after 90", async () => {
  const w = world();
  w.states = new Map<string, VideoStateInfo>([
    ["V40", { state: "cancelled", folder: null }],
    ["V41", { state: "published", folder: "04 Videos/06 June/0601 V41" }],
    ["V49", { state: "in_work", folder: null }],
  ]);
  const old = at("2026-06-01T10:00:00.000Z"); // 138 days before NOW
  const recent = at("2026-08-01T10:00:00.000Z"); // 77 days before NOW
  const mac = computer("mac", w, () => ({
    ...none(),
    gemini: [
      gemini("cancelled", { video: "V40" }),
      gemini("published-old", { video: "V41", createdAt: old }),
      gemini("published-recent", { video: "V41", createdAt: recent }),
      gemini("unlinked-old", { video: null, createdAt: old }),
      gemini("unlinked-new", { video: null }),
      gemini("in-work-old", { video: "V49", createdAt: old }),
    ],
  }));
  await mac.service.publishOwnReport();
  assert.deepEqual(w.reports.get("mac")!.runs.map((r) => r.runId).sort(), ["gemini:in-work-old", "gemini:published-recent", "gemini:unlinked-new"]);
});

test("criterion 9: the report carries no prompt, parameter, path or provider text -- only the cost line's fields", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), runpod: [runpod("a", { outputsJson: JSON.stringify([{ kind: "videos", localPath: "/Users/dima/secret.mp4" }]) })] }));
  await mac.service.publishOwnReport();
  const text = JSON.stringify(w.reports.get("mac"));
  assert.ok(!text.includes("/Users/dima"), "no local path");
  assert.deepEqual(Object.keys(w.reports.get("mac")!.runs[0]).sort(), ["basis", "channelId", "createdAt", "finishedAt", "gpuSeconds", "kind", "label", "mediaKind", "overheadUsd", "planId", "runId", "segmentId", "source", "status", "storyboardId", "storyboardVersion", "usd", "video"].sort());
});

test("criterion 6: the upload writes V49_cost.json next to V49_release.json with the same total as Content", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), runpod: [runpod("a")], gemini: [gemini("g1")] }));
  await mac.service.writeCostFile({ channelId: "UC1", video: "V49", folder: "04 Videos/10 October/1017 V49" });
  const file = w.files.get("04 Videos/10 October/1017 V49/V49_cost.json")!;
  const content = await mac.service.videoCost({ channelId: "UC1", video: "V49" });
  assert.equal(file.schema, "ytm.video-cost");
  assert.equal(file.revision, 1);
  assert.equal(file.previous, null);
  assert.deepEqual(file.totals, content.totals);
  assert.equal(file.totals.totalUsd, 1.4088);
  assert.deepEqual(file.runs.map((r) => r.runId).sort(), ["gemini:g1", "runpod:a"]);
});

test("criterion 6: a late report that changes the total rewrites the file and says so; an unchanged total leaves it alone", async () => {
  const w = world();
  w.states = new Map([["V49", { state: "published", folder: "04 Videos/10 October/1017 V49" }]]);
  const mac = computer("mac", w, () => ({ ...none(), runpod: [runpod("a")] }));
  await mac.service.writeCostFile({ channelId: "UC1", video: "V49", folder: "04 Videos/10 October/1017 V49" });
  assert.equal(await mac.service.refreshCostFiles(), 0, "nothing changed");
  // The other computer's Gemini run arrives after the upload.
  const win = computer("win", w, () => ({ ...none(), gemini: [gemini("g1")] }));
  await win.service.publishOwnReport();
  assert.equal(await win.service.refreshCostFiles(), 0, "only the computer that uploaded rewrites the file (one writer in the synced folder)");
  assert.equal(await mac.service.refreshCostFiles(), 1);
  const file = w.files.get("04 Videos/10 October/1017 V49/V49_cost.json")!;
  assert.equal(file.revision, 2);
  assert.deepEqual(file.writtenBy, { deviceId: "mac", hostName: "Mac" });
  assert.equal(file.totals.totalUsd, 1.4088);
  assert.deepEqual(file.previous, { totalUsd: 0.6667, computedAt: NOW.toISOString() });
  assert.match(file.note ?? "", /0\.6667.*1\.4088/);
  assert.equal(mac.writes.length, 2);
});

test("a cost file is never written for a video without a folder, and a video file without one is not created by the refresh", async () => {
  const w = world();
  w.states = new Map([["V49", { state: "published", folder: "04 Videos/10 October/1017 V49" }]]);
  const mac = computer("mac", w, () => ({ ...none(), runpod: [runpod("a")] }));
  assert.equal(await mac.service.refreshCostFiles(), 0);
  assert.equal(w.files.size, 0, "only the upload writes the first file");
  await assert.rejects(mac.service.writeCostFile({ channelId: "UC1", video: "V49", folder: "../outside" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});

test("§F: a channel not connected here, or a malformed video number, is refused", async () => {
  const w = world();
  const mac = computer("mac", w, () => none());
  await assert.rejects(mac.service.videoCost({ channelId: "UC_OTHER", video: "V49" }), (e: unknown) => isDomainError(e) && e.code === "video_costs_unavailable");
  await assert.rejects(mac.service.summary({ channelId: "UC_OTHER" }), (e: unknown) => isDomainError(e) && e.code === "video_costs_unavailable");
  await assert.rejects(mac.service.videoCost({ channelId: "UC1", video: "V049" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(mac.service.videoCost({ channelId: "UC1", video: "V49", extra: 1 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});

test("another channel's runs never count for this channel's video", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), gemini: [gemini("mine"), gemini("theirs", { channelId: "UC2" })] }));
  assert.deepEqual((await mac.service.videoCost({ channelId: "UC1", video: "V49" })).runs.map((r) => r.runId), ["gemini:mine"]);
});

test("criterion 8: a peer report that cannot be read, or video states that cannot be listed, leave this computer's own runs counted", async () => {
  const w = world();
  const mac = computer("mac", w, () => ({ ...none(), gemini: [gemini("g1")] }), {
    peers: async () => {
      throw new Error("sync folder unavailable");
    },
    videoStates: async () => {
      throw new Error("workspace unreadable");
    },
  });
  assert.equal((await mac.service.videoCost({ channelId: "UC1", video: "V49" })).totals.totalUsd, 0.7421);
  await mac.service.publishOwnReport();
  assert.equal(w.reports.get("mac")!.runs.length, 1);
});
