import assert from "node:assert/strict";
import test from "node:test";
import { createActivitySummary, jobProgress, operationProgress, uploadProgress, type ActivityDeps } from "./services";

// BL-195 stage D (UI_FEEDBACK_CLARITY_PLAN.md §3, AC-FB-08) as changed by BL-258 (owner msg 4385, 2026-11-15: «надо показывать общую
// очередь. Ведь в фоне делаются все каналы и не надо фильтровать по каналу это. Плюс ... прогресс бар»). The requirement that
// changed: the channel's sources were read for the ACTIVE channel only (`no_channel` without one); now every channel's work is
// listed, each item naming its channel, read with or without an active channel. Unchanged: only unfinished work is listed; a failing
// source is `unavailable` and the others are still listed; a peer's job names its computer; a stale computer's job is not listed.
// Expected values by hand: progress = floor(done / total * 100); 50 of 200 bytes = 25; step 3 of 12 = 25.

const NOW = new Date("2026-10-17T10:00:00.000Z");

function deps(overrides: Partial<ActivityDeps> = {}): ActivityDeps {
  return {
    activeChannelOf: async () => "UC1",
    operations: () => [
      { id: "op1", channelId: "UC1", kind: "channel-sync", status: "running", startedAt: Date.parse("2026-10-17T09:59:00.000Z"), done: 3, total: 10 },
      { id: "op2", channelId: "UC1", kind: "analytics-collect", status: "success", startedAt: Date.parse("2026-10-17T09:00:00.000Z"), done: 5, total: 5 },
      { id: "op3", channelId: "UC2", kind: "ai-generation", status: "cancelling", startedAt: Date.parse("2026-10-17T09:58:00.000Z"), done: 0, total: 0 },
    ],
    mediaJobs: async () => [
      { jobId: "j0", channelId: "UC3", source: "runpod", status: "queued", label: "loop v3", hostName: "mac", own: true, createdAt: "2026-10-17T09:40:00.000Z", finished: false, stale: false, progress: null },
      { jobId: "j1", channelId: "UC1", source: "runpod", status: "running", label: "loop v3", hostName: "mac", own: true, createdAt: "2026-10-17T09:50:00.000Z", finished: false, stale: false, progress: { percent: null, step: { value: 3, max: 12 } } },
      { jobId: "j2", channelId: "UC2", source: "gemini", status: "running", label: "gemini-omni-1.1-flash", hostName: "win-pc", own: false, createdAt: "2026-10-17T09:55:00.000Z", finished: false, stale: false, progress: null },
      { jobId: "j3", channelId: "UC1", source: "gemini", status: "done", label: "gemini-omni-1.1-flash", hostName: "mac", own: true, createdAt: "2026-10-17T08:00:00.000Z", finished: true, stale: false, progress: null },
      // The PC went to sleep with a job still running in its last report, older than the pool's stale limit: not listed.
      { jobId: "j4", channelId: "UC2", source: "gemini", status: "running", label: "gemini-omni-1.1-flash", hostName: "win-pc", own: false, createdAt: "2026-10-17T07:00:00.000Z", finished: false, stale: true, progress: null },
    ],
    uploads: async () => [
      { id: "u4", channelId: "UC2", video: "V12", status: "queued", storedBytes: 0, totalBytes: 400, createdAt: new Date("2026-10-17T09:30:00.000Z"), queuePosition: 2 },
      { id: "u1", channelId: "UC1", video: "V49", status: "uploading", storedBytes: 50, totalBytes: 200, createdAt: new Date("2026-10-17T09:40:00.000Z"), queuePosition: null },
      { id: "u2", channelId: "UC1", video: "V48", status: "done", storedBytes: 100, totalBytes: 100, createdAt: new Date("2026-10-16T09:40:00.000Z"), queuePosition: null },
      { id: "u5", channelId: "UC3", video: "V7", status: "queued", storedBytes: 0, totalBytes: 500, createdAt: new Date("2026-10-17T09:50:00.000Z"), queuePosition: 1 },
      { id: "u3", channelId: "UC2", video: "V50", status: "processing", storedBytes: 300, totalBytes: 300, createdAt: new Date("2026-10-17T09:45:00.000Z"), queuePosition: null },
    ],
    streams: async () => [
      { channelId: "UC1", state: "live", since: "2026-10-17T08:00:00.000Z" },
      { channelId: "UC2", state: "off", since: null },
      { channelId: "UC3", state: "ended_by_youtube", since: null },
    ],
    now: () => NOW,
    ...overrides,
  };
}

test("BL-258: every channel's unfinished work, each naming its channel, with its progress", async () => {
  const summary = await createActivitySummary(deps()).summary("u1");
  assert.equal(summary.channelId, "UC1");
  assert.equal(summary.at, "2026-10-17T10:00:00.000Z");
  assert.deepEqual(summary.sources, { operations: "ok", media_jobs: "ok", uploads: "ok", live_streams: "ok" });
  // Oldest first.
  assert.deepEqual(
    summary.items.filter((i) => i.source === "operations"),
    [
      { source: "operations", id: "op3", channelId: "UC2", kind: "ai-generation", status: "cancelling", startedAt: "2026-10-17T09:58:00.000Z", done: 0, total: 0, progress: null },
      { source: "operations", id: "op1", channelId: "UC1", kind: "channel-sync", status: "running", startedAt: "2026-10-17T09:59:00.000Z", done: 3, total: 10, progress: 30 },
    ]
  );
  // Running first (oldest first), then waiting.
  assert.deepEqual(
    summary.items.filter((i) => i.source === "media_jobs"),
    [
      { source: "media_jobs", id: "j1", channelId: "UC1", provider: "runpod", status: "running", label: "loop v3", device: null, own: true, createdAt: "2026-10-17T09:50:00.000Z", progress: 25 },
      { source: "media_jobs", id: "j2", channelId: "UC2", provider: "gemini", status: "running", label: "gemini-omni-1.1-flash", device: "win-pc", own: false, createdAt: "2026-10-17T09:55:00.000Z", progress: null },
      { source: "media_jobs", id: "j0", channelId: "UC3", provider: "runpod", status: "queued", label: "loop v3", device: null, own: true, createdAt: "2026-10-17T09:40:00.000Z", progress: null },
    ]
  );
  // The shared queue: in progress first (oldest first), then the queued by their place.
  assert.deepEqual(
    summary.items.filter((i) => i.source === "uploads").map((i) => (i.source === "uploads" ? [i.video, i.channelId, i.status, i.queuePosition, i.progress] : null)),
    [
      ["V49", "UC1", "uploading", null, 25],
      ["V50", "UC2", "processing", null, null],
      ["V7", "UC3", "queued", 1, null],
      ["V12", "UC2", "queued", 2, null],
    ]
  );
  assert.deepEqual(summary.items.filter((i) => i.source === "live_streams"), [{ source: "live_streams", channelId: "UC1", state: "live", since: "2026-10-17T08:00:00.000Z" }]);
});

test("BL-258: without an active channel every source is still read and listed", async () => {
  const summary = await createActivitySummary(deps({ activeChannelOf: async () => null })).summary("u1");
  assert.equal(summary.channelId, null);
  assert.deepEqual(summary.sources, { operations: "ok", media_jobs: "ok", uploads: "ok", live_streams: "ok" });
  assert.deepEqual([...new Set(summary.items.map((i) => i.source))].sort(), ["live_streams", "media_jobs", "operations", "uploads"]);
});

test("a failing source is `unavailable`; the others are still listed", async () => {
  const summary = await createActivitySummary(
    deps({
      mediaJobs: async () => Promise.reject(new Error("peer folder unreadable")),
      operations: () => {
        throw new Error("registry gone");
      },
    })
  ).summary("u1");
  assert.deepEqual(summary.sources, { operations: "unavailable", media_jobs: "unavailable", uploads: "ok", live_streams: "ok" });
  assert.deepEqual([...new Set(summary.items.map((i) => i.source))].sort(), ["live_streams", "uploads"]);
  assert.ok(!JSON.stringify(summary).includes("peer folder unreadable"), "no error text in the answer");
});

test("BL-258: progress -- operations done/total, uploads sent bytes while uploading or paused, jobs percent else step; bounded 0..100", () => {
  assert.equal(operationProgress(3, 10), 30);
  assert.equal(operationProgress(0, 0), null);
  assert.equal(operationProgress(12, 10), 100);
  assert.equal(uploadProgress("uploading", 50, 200), 25);
  assert.equal(uploadProgress("paused", 199, 200), 99);
  assert.equal(uploadProgress("queued", 0, 200), null);
  assert.equal(uploadProgress("processing", 200, 200), null);
  assert.equal(uploadProgress("uploading", 10, 0), null);
  assert.equal(jobProgress(null), null);
  assert.equal(jobProgress({ percent: 42.7, step: null }), 42);
  assert.equal(jobProgress({ percent: null, step: { value: 3, max: 12 } }), 25);
  assert.equal(jobProgress({ percent: null, step: { value: 1, max: 0 } }), null);
});
