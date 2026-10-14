import assert from "node:assert/strict";
import test from "node:test";
import type { MediaJobsReport, SharedMediaJob } from "@/lib/sync-gateway";
import { peerTakes, peerVideoPath, takeKey } from "./services";

// BL-189 (FO-REQ-0025 §3 step 1, STORYBOARD_TAKES_PLAN.md §2.1-§2.2): the Mac rendered bar_loop v3 -- 8 GPU jobs, 2 takes per
// segment S1-S4 -- and Windows must list all 8 from the Mac's job report. Expected values are written from the request, not run.

const job = (over: Partial<SharedMediaJob> & Pick<SharedMediaJob, "jobId">): SharedMediaJob => ({
  source: "runpod",
  channelId: "UC_tropico",
  mediaKind: "video",
  status: "done",
  createdBy: "factory",
  label: "h0004-ltx25-flf v3",
  sessionId: "652aa3bc",
  progress: null,
  plan: null,
  storyboard: { storyboardId: "bar_loop", versionNumber: 3, segmentId: "S1" },
  costUsd: null,
  costIsEstimate: false,
  errorCode: null,
  createdAt: "2026-10-14T15:00:00.000Z",
  submittedAt: null,
  finishedAt: null,
  outputs: [`From YTM/media/${over.jobId}/ltx25_flf_00001_.mp4`, `From YTM/media/${over.jobId}/manifest.json`],
  ...over,
});
const report = (deviceId: string, jobs: SharedMediaJob[], updatedAt = "2026-10-14T16:00:00.000Z"): MediaJobsReport => ({ format: "ytm-media-jobs", version: 3, deviceId, hostName: deviceId === "mac" ? "Mac-mini-Violetta.local" : "DESKTOP", updatedAt, jobs });

test("FO-REQ-0025 §3.1: the Mac's 8 bar_loop v3 jobs are 8 takes on Windows, 2 per segment, each naming the Mac", () => {
  const macJobs = ["S1", "S2", "S3", "S4"].flatMap((segmentId, i) => [
    job({ jobId: `j${i}a`, storyboard: { storyboardId: "bar_loop", versionNumber: 3, segmentId } }),
    job({ jobId: `j${i}b`, storyboard: { storyboardId: "bar_loop", versionNumber: 3, segmentId } }),
  ]);
  const takes = peerTakes([report("mac", macJobs)], { channelId: "UC_tropico", storyboardId: "bar_loop", ownKeys: new Set() });
  assert.equal(takes.length, 8);
  for (const segmentId of ["S1", "S2", "S3", "S4"]) assert.equal(takes.filter((t) => t.segmentId === segmentId).length, 2, segmentId);
  assert.ok(takes.every((t) => t.source === "media" && t.versionNumber === 3 && t.device?.hostName === "Mac-mini-Violetta.local" && t.localPath === null));
  assert.equal(takes.find((t) => t.jobId === "j0a")?.exchangePath, "From YTM/media/j0a/ltx25_flf_00001_.mp4");
});

test("only the storyboard's own channel and id; this computer's own jobs are not listed twice; one job once across reports", () => {
  const reports = [
    report("mac", [
      job({ jobId: "keep" }),
      job({ jobId: "other-channel", channelId: "UC_japan" }),
      job({ jobId: "other-board", storyboard: { storyboardId: "sea_loop", versionNumber: 1, segmentId: "S1" } }),
      job({ jobId: "no-link", storyboard: null }),
      job({ jobId: "mine" }),
    ]),
    report("pc2", [job({ jobId: "keep", status: "failed" })], "2026-10-14T15:00:00.000Z"),
  ];
  const takes = peerTakes(reports, { channelId: "UC_tropico", storyboardId: "bar_loop", ownKeys: new Set([takeKey({ source: "media", jobId: "mine" })]) });
  assert.deepEqual(
    takes.map((t) => [t.jobId, t.status, t.device?.deviceId]),
    [["keep", "done", "mac"]],
    "the newer report wins for the same job"
  );
});

test("a Gemini job is a gemini take; a seed from the plan link joins the label; a failure carries its code only", () => {
  const takes = peerTakes(
    [
      report("mac", [
        job({ jobId: "g1", source: "gemini", label: "gemini-omni-1.1-flash", outputs: ["From YTM/gemini/g1/video-1.mp4"] }),
        job({ jobId: "r1", plan: { planId: "p", itemKey: "S1", seed: 8 }, status: "failed", errorCode: "media_job_failed" }),
      ]),
    ],
    { channelId: "UC_tropico", storyboardId: "bar_loop", ownKeys: new Set() }
  );
  assert.deepEqual(
    takes.map((t) => [t.source, t.jobId, t.label, t.error, t.exchangePath]),
    [
      ["gemini", "g1", "gemini-omni-1.1-flash", null, "From YTM/gemini/g1/video-1.mp4"],
      ["media", "r1", "h0004-ltx25-flf v3 · seed 8", "media_job_failed", "From YTM/media/r1/ltx25_flf_00001_.mp4"],
    ]
  );
});

test("another computer's output is used only as a video inside that job's own folder (never another job's, `..` or a non-video)", () => {
  assert.equal(peerVideoPath({ source: "runpod", jobId: "a", outputs: ["From YTM/media/b/x.mp4"] }), null, "another job's folder");
  assert.equal(peerVideoPath({ source: "runpod", jobId: "a", outputs: ["From YTM/gemini/a/x.mp4"] }), null, "the other module's folder");
  assert.equal(peerVideoPath({ source: "runpod", jobId: "a", outputs: ["From YTM/media/a/../b/x.mp4"] }), null, "..");
  assert.equal(peerVideoPath({ source: "runpod", jobId: "a", outputs: ["Sent to YTM/x.mp4"] }), null, "not a job output");
  assert.equal(peerVideoPath({ source: "runpod", jobId: "a", outputs: ["From YTM/media/a/manifest.json", "From YTM/media/a/still.png"] }), null, "no video");
  assert.equal(peerVideoPath({ source: "runpod", jobId: "a", outputs: ["From YTM/media/a/manifest.json", "From YTM/media/a/sub/x.MOV"] }), "From YTM/media/a/sub/x.MOV");
});
