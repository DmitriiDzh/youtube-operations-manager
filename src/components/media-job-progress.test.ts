import assert from "node:assert/strict";
import test from "node:test";
import type { JobLiveProgress } from "@/lib/media-generation/job-progress";
import type { MediaJob } from "@/lib/media-generation/contracts";
import { describeJobProgress, describeSessionJobCounts, fromSharedProgress } from "./media-job-progress";
import { nowRunningOn } from "./media-generation-settings";

// BL-144 (owner, Telegram 2026-10-06, msg 1887): what the owner reads about a running job, only ComfyUI's own facts.
const base: JobLiveProgress = {
  state: "running",
  nodesTotal: 9,
  nodesDone: 4,
  nodesCached: 2,
  currentNode: { id: "3", type: "KSampler" },
  step: { value: 18, max: 30 },
  percent: 51,
  startedAt: "2026-10-06T20:00:00.000Z",
  updatedAt: "2026-10-06T20:01:00.000Z",
  detail: null,
};

test("a running job: percent and node N of M, then the node, its steps and what came from cache", () => {
  assert.deepEqual(describeJobProgress(base), {
    headline: "51 % · node 5 of 9",
    detail: "KSampler · step 18 of 30 · 2 from cache",
    percent: 51,
    tone: "info",
  });
});

test("without a graph there is no percent and no node count, only what ComfyUI said", () => {
  assert.deepEqual(describeJobProgress({ ...base, nodesTotal: null, percent: null, nodesCached: 0, currentNode: { id: "7", type: null } }), {
    headline: "Running",
    detail: "#7 · step 18 of 30",
    percent: null,
    tone: "info",
  });
});

test("waiting, error and unavailable say so plainly; unavailable reminds that the job continues", () => {
  assert.equal(describeJobProgress({ ...base, state: "waiting" }).headline, "Waiting in ComfyUI's queue");
  assert.deepEqual(describeJobProgress({ ...base, state: "error", detail: "CUDA out of memory · node KSampler #3" }).detail, "CUDA out of memory · node KSampler #3");
  assert.deepEqual(describeJobProgress({ ...base, state: "unavailable", detail: "closed (1006)", percent: null }), {
    headline: "Live progress unavailable",
    detail: "the job continues; closed (1006)",
    percent: null,
    tone: "warn",
  });
  assert.equal(describeJobProgress({ ...base, state: "finished", percent: 100 }).percent, 100);
});

function job(jobId: string, sessionId: string, status: MediaJob["status"], createdAt: string): MediaJob {
  return { jobId, sessionId, channelId: "UC1", templateId: "t", templateVersion: 1, params: {}, status, createdBy: "factory", promptId: null, outputs: [], assetIds: [], error: null, createdAt, submittedAt: null, finishedAt: null, plan: null };
}

test("Now on a session: the generating job, and how many others of that session still wait", () => {
  const jobs = [
    job("a", "s1", "done", "2026-10-06T19:00:00Z"),
    job("b", "s1", "submitted", "2026-10-06T19:02:00Z"),
    job("c", "s1", "generating", "2026-10-06T19:01:00Z"),
    job("d", "s1", "queued", "2026-10-06T19:03:00Z"),
    job("e", "s2", "generating", "2026-10-06T19:00:00Z"),
  ];
  const now = nowRunningOn("s1", jobs);
  assert.equal(now.current?.jobId, "c");
  assert.equal(now.waiting, 2);
  assert.deepEqual(nowRunningOn("s3", jobs), { current: null, waiting: 0 });
  // Nothing generating: the oldest submitted one is next.
  assert.equal(nowRunningOn("s1", jobs.filter((j) => j.jobId !== "c")).current?.jobId, "b");
});

test("BL-144 review: when ComfyUI reports which job runs, that one is current and the other in-flight jobs wait", () => {
  const running: MediaJob = { ...job("young", "s1", "generating", "2026-10-06T19:05:00Z"), progress: { ...base } };
  const queuedInComfy: MediaJob = { ...job("old", "s1", "generating", "2026-10-06T19:00:00Z"), progress: { ...base, state: "waiting", percent: 0, currentNode: null, step: null, nodesDone: 0, nodesCached: 0 } };
  const now = nowRunningOn("s1", [queuedInComfy, running, job("q", "s1", "queued", "2026-10-06T19:06:00Z")]);
  assert.equal(now.current?.jobId, "young");
  assert.equal(now.waiting, 2, "the job still in ComfyUI's queue and the queued one");
});

// BL-148 (CROSS_DEVICE_JOB_PROGRESS_PLAN.md): another device's session reads in the same words as a local one.
test("another device's job counts leave out zeros", () => {
  assert.equal(describeSessionJobCounts({ counts: { queued: 3, running: 1, done: 4, failed: 1, cancelled: 0 } }), "4 done · 1 running · 3 queued · 1 failed");
  assert.equal(describeSessionJobCounts({ counts: { queued: 0, running: 0, done: 1200, failed: 0, cancelled: 0 } }), "1200 done");
  assert.equal(describeSessionJobCounts({ counts: { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 } }), "no jobs yet");
});

test("another device's reported progress is described like a local one (node type, step, percent)", () => {
  const view = describeJobProgress(
    fromSharedProgress({ state: "running", percent: 45, nodesTotal: 10, nodesDone: 4, nodesCached: 0, currentNodeType: "KSampler", step: { value: 25, max: 50 }, startedAt: null, updatedAt: "2026-10-07T12:00:00.000Z" })
  );
  assert.deepEqual(view, { headline: "45 % · node 5 of 10", detail: "KSampler · step 25 of 50", percent: 45, tone: "info" });
});
