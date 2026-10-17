import assert from "node:assert/strict";
import test from "node:test";
import { createActivitySummary, type ActivityDeps } from "./services";

// BL-195 stage D (UI_FEEDBACK_CLARITY_PLAN.md §3, AC-FB-08). Expected from the plan: only unfinished work is listed (running or
// cancelling operations, unfinished media jobs, uploads queued/uploading/processing/finishing/paused, streams that are on); a
// source that fails is `unavailable` and the others are still listed; without an active channel the channel's sources are
// `no_channel` and only this computer's streams are read; a peer's job names its computer, an own job does not; a job of a computer
// whose report is stale (media-jobs-pool's own limit) is not known to run and is not listed.

const NOW = new Date("2026-10-17T10:00:00.000Z");

function deps(overrides: Partial<ActivityDeps> = {}): ActivityDeps {
  return {
    activeChannelOf: async () => "UC1",
    operations: () => [
      { id: "op1", kind: "channel-sync", status: "running", startedAt: Date.parse("2026-10-17T09:59:00.000Z"), done: 3, total: 10 },
      { id: "op2", kind: "analytics-collect", status: "success", startedAt: Date.parse("2026-10-17T09:00:00.000Z"), done: 5, total: 5 },
      { id: "op3", kind: "ai-generation", status: "cancelling", startedAt: Date.parse("2026-10-17T09:58:00.000Z"), done: 0, total: 0 },
    ],
    mediaJobs: async () => [
      { jobId: "j1", source: "runpod", status: "running", label: "loop v3", hostName: "mac", own: true, createdAt: "2026-10-17T09:50:00.000Z", finished: false, stale: false },
      { jobId: "j2", source: "gemini", status: "running", label: "gemini-omni-1.1-flash", hostName: "win-pc", own: false, createdAt: "2026-10-17T09:55:00.000Z", finished: false, stale: false },
      { jobId: "j3", source: "gemini", status: "done", label: "gemini-omni-1.1-flash", hostName: "mac", own: true, createdAt: "2026-10-17T08:00:00.000Z", finished: true, stale: false },
      // The PC went to sleep with a job still running in its last report, older than the pool's stale limit: not listed.
      { jobId: "j4", source: "gemini", status: "running", label: "gemini-omni-1.1-flash", hostName: "win-pc", own: false, createdAt: "2026-10-17T07:00:00.000Z", finished: false, stale: true },
    ],
    uploads: async () => [
      { id: "u1", video: "V49", status: "uploading", storedBytes: 50, totalBytes: 200, createdAt: new Date("2026-10-17T09:40:00.000Z") },
      { id: "u2", video: "V48", status: "done", storedBytes: 100, totalBytes: 100, createdAt: new Date("2026-10-16T09:40:00.000Z") },
      { id: "u3", video: "V50", status: "paused", storedBytes: 0, totalBytes: 300, createdAt: new Date("2026-10-17T09:45:00.000Z") },
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

test("only unfinished work of computers still reporting is listed, each in its own shape", async () => {
  const summary = await createActivitySummary(deps()).summary("u1");
  assert.equal(summary.channelId, "UC1");
  assert.equal(summary.at, "2026-10-17T10:00:00.000Z");
  assert.deepEqual(summary.sources, { operations: "ok", media_jobs: "ok", uploads: "ok", live_streams: "ok" });
  assert.deepEqual(
    summary.items.filter((i) => i.source === "operations"),
    [
      { source: "operations", id: "op1", kind: "channel-sync", status: "running", startedAt: "2026-10-17T09:59:00.000Z", done: 3, total: 10 },
      { source: "operations", id: "op3", kind: "ai-generation", status: "cancelling", startedAt: "2026-10-17T09:58:00.000Z", done: 0, total: 0 },
    ]
  );
  assert.deepEqual(
    summary.items.filter((i) => i.source === "media_jobs"),
    [
      { source: "media_jobs", id: "j1", provider: "runpod", status: "running", label: "loop v3", device: null, own: true, createdAt: "2026-10-17T09:50:00.000Z" },
      { source: "media_jobs", id: "j2", provider: "gemini", status: "running", label: "gemini-omni-1.1-flash", device: "win-pc", own: false, createdAt: "2026-10-17T09:55:00.000Z" },
    ]
  );
  assert.deepEqual(
    summary.items.filter((i) => i.source === "uploads").map((i) => (i.source === "uploads" ? [i.video, i.status, i.storedBytes, i.totalBytes] : null)),
    [
      ["V49", "uploading", 50, 200],
      ["V50", "paused", 0, 300],
    ]
  );
  assert.deepEqual(summary.items.filter((i) => i.source === "live_streams"), [{ source: "live_streams", channelId: "UC1", state: "live", since: "2026-10-17T08:00:00.000Z" }]);
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

test("without an active channel the channel's sources are `no_channel` and are never read; streams still are", async () => {
  const read: string[] = [];
  const summary = await createActivitySummary(
    deps({
      activeChannelOf: async () => null,
      operations: () => (read.push("operations"), []),
      mediaJobs: async () => (read.push("media_jobs"), []),
      uploads: async () => (read.push("uploads"), []),
    })
  ).summary("u1");
  assert.equal(summary.channelId, null);
  assert.deepEqual(summary.sources, { operations: "no_channel", media_jobs: "no_channel", uploads: "no_channel", live_streams: "ok" });
  assert.deepEqual(read, []);
  assert.deepEqual(summary.items.map((i) => i.source), ["live_streams"]);
});
