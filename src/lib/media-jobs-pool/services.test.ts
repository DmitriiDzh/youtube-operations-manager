import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { GeminiJobView } from "@/lib/gemini-media";
import type { JobLiveProgress } from "@/lib/media-generation/job-progress";
import { MEDIA_JOBS_REPORT_FORMAT, mediaJobsReportSchema, type MediaJobsReport, type SharedMediaJob } from "@/lib/sync-gateway";
import { buildMediaJobsReport, geminiOutputPath, mergePool, runpodOutputPath, selectReportJobs, toSharedGeminiJob, toSharedRunpodJob, type LocalRunpodJob, type MergeInput } from "./services";

// BL-188 (owner, Telegram 2026-10-14, msgs 2801/2803/2806; SHARED_MEDIA_JOBS_PLAN.md §2.1 and acceptance §4.1 items 1–3, 7):
// - nothing secret crosses (no ComfyUI URL, parameters, prompt, input paths or provider error text -- a code only);
// - the report holds every unfinished job and finished jobs of the last 7 days, at most 1000, unfinished ones first;
// - every computer shows one list: its own jobs and the peers', with the computer, "stale" after 5 minutes, the active channel
//   and the tab's kind only; a peer's file counts as here only when it is in this computer's copy of the workspace.

const NOW = new Date("2026-10-14T12:00:00.000Z");
const SECRETS = ["https://abc123-8188.proxy.runpod.net/?token=PROXYTOKEN", "PROMPT_TEXT_SECRET", "/Users/owner/Secret Inputs/face.png", "CUDA error: device-side assert at /root/ComfyUI/main.py", "Google says: SAFETY_TEXT_SECRET"];

const progress: JobLiveProgress = {
  state: "running",
  nodesTotal: 10,
  nodesDone: 4,
  nodesCached: 1,
  currentNode: { id: "7", type: "KSampler" },
  step: { value: 12, max: 30 },
  percent: 40,
  startedAt: "2026-10-14T11:59:00.000Z",
  updatedAt: "2026-10-14T11:59:30.000Z",
  detail: "ComfyUI said: CUDA error: device-side assert at /root/ComfyUI/main.py",
};

// The shared progress shape, as media-generation converts it (no `detail`).
const shareProgress = (p: JobLiveProgress) => ({
  state: p.state,
  percent: p.percent,
  nodesTotal: p.nodesTotal,
  nodesDone: p.nodesDone,
  nodesCached: p.nodesCached,
  currentNodeType: p.currentNode?.type ?? null,
  step: p.step,
  startedAt: p.startedAt,
  updatedAt: p.updatedAt,
});
const errorCode = (error: string | null) => (error && /CUDA/.test(error) ? "media_gpu_host_incompatible" : null);

function runpodJob(extra: Partial<LocalRunpodJob> = {}): LocalRunpodJob {
  return {
    jobId: "rp1",
    sessionId: "s1",
    channelId: "UC1",
    templateId: "tpl-flux",
    templateVersion: 2,
    params: { prompt: SECRETS[1], url: SECRETS[0] },
    status: "done",
    createdBy: "factory",
    promptId: "prompt-123",
    outputs: [
      { nodeId: "9", kind: "images", filename: "flux_00001_.png", subfolder: "", remoteKey: "exchange/rp1/flux_00001_.png", localPath: "/Users/owner/Channel/99 Data Exchange/From YTM/media/rp1/flux_00001_.png", bytes: 10, sha256: "a", remoteDeleted: true, assetId: null },
    ],
    assetIds: [],
    error: null,
    createdAt: "2026-10-14T10:00:00.000Z",
    submittedAt: "2026-10-14T10:00:05.000Z",
    finishedAt: "2026-10-14T10:02:00.000Z",
    inputs: [{ parameter: "image", sourcePath: SECRETS[2], remoteKey: "exchange/in/x", bytes: 1, sha256: "b", uploadedAt: "2026-10-14T10:00:00.000Z", remoteDeleted: false }],
    plan: { planId: "plan-a", stageId: "st1", itemKey: "track-01", seed: 42 },
    storyboard: null,
    mediaKind: "image",
    templateName: "FLUX",
    ...extra,
  } as LocalRunpodJob;
}

function geminiJob(extra: Partial<GeminiJobView> = {}): GeminiJobView {
  return {
    jobId: "gm_1",
    channelId: "UC1",
    requestId: "req-1",
    kind: "video",
    model: "veo-3.1-generate-001",
    prompt: SECRETS[1],
    params: {} as GeminiJobView["params"],
    inputs: [{ role: "first_frame", path: SECRETS[2] }] as unknown as GeminiJobView["inputs"],
    status: "done",
    estimateUsd: 3.2,
    costUsd: 3.2,
    costBasis: "price_table",
    outputs: [{ path: "gemini/gm_1/video-1.mp4", localPath: "/Users/owner/Channel/99 Data Exchange/From YTM/gemini/gm_1/video-1.mp4", kind: "video", mimeType: "video/mp4", bytes: 100, sha256: "c", assetId: null, note: null }],
    error: null,
    errorCode: null,
    attempts: 1,
    createdBy: "factory",
    createdAt: "2026-10-14T09:00:00.000Z",
    submittedAt: "2026-10-14T09:00:01.000Z",
    finishedAt: "2026-10-14T09:03:00.000Z",
    storyboard: { storyboardId: "sb1", versionNumber: 2, segmentId: "seg3" },
    ...extra,
  };
}

function shared(extra: Partial<SharedMediaJob> = {}): SharedMediaJob {
  return {
    jobId: "j",
    source: "runpod",
    channelId: "UC1",
    mediaKind: "image",
    status: "done",
    createdBy: "factory",
    label: "x v1",
    sessionId: "s1",
    progress: null,
    plan: null,
    storyboard: null,
    costUsd: null,
    costIsEstimate: false,
    errorCode: null,
    createdAt: "2026-10-14T10:00:00.000Z",
    submittedAt: null,
    finishedAt: "2026-10-14T10:01:00.000Z",
    outputs: [],
    ...extra,
  };
}

test("a RunPod job crosses without its parameters, prompt id, inputs, ComfyUI detail or error text", () => {
  const failed = runpodJob({ status: "failed", error: SECRETS[3], progress });
  const out = toSharedRunpodJob(failed, shareProgress, errorCode);
  const text = JSON.stringify(out);
  for (const secret of [...SECRETS, "prompt-123", "/Users/owner"]) assert.equal(text.includes(secret), false, `${secret} must not cross`);
  assert.equal(out.errorCode, "media_gpu_host_incompatible");
  assert.equal(out.label, "FLUX v2");
  assert.deepEqual(out.plan, { planId: "plan-a", itemKey: "track-01", seed: 42 });
  assert.equal(out.progress?.percent, 40);
  assert.ok(mediaJobsReportSchema.shape.jobs.element.safeParse(out).success);
});

test("a Gemini job crosses without its prompt, inputs or Google's text; the cost is the charge, else the estimate", () => {
  const out = toSharedGeminiJob(geminiJob({ status: "failed", error: SECRETS[4], errorCode: "gemini_blocked", costUsd: null }));
  const text = JSON.stringify(out);
  for (const secret of [...SECRETS, "/Users/owner", "req-1"]) assert.equal(text.includes(secret), false, `${secret} must not cross`);
  assert.equal(out.errorCode, "gemini_blocked");
  assert.equal(out.costUsd, 3.2);
  assert.equal(out.costIsEstimate, true);
  assert.equal(out.mediaKind, "video");
  assert.equal(out.label, "veo-3.1-generate-001");
  assert.equal(toSharedGeminiJob(geminiJob()).costIsEstimate, false);
});

test("output paths are relative to 99 Data Exchange, from either computer's separators; anything else is dropped", () => {
  assert.equal(runpodOutputPath("/Users/owner/Channel/99 Data Exchange/From YTM/media/rp1/sub/a.png", "rp1"), "From YTM/media/rp1/sub/a.png");
  assert.equal(runpodOutputPath("D:\\Channels\\Tropico\\99 Data Exchange\\From YTM\\media\\rp1\\a.png", "rp1"), "From YTM/media/rp1/a.png");
  assert.equal(runpodOutputPath("/elsewhere/a.png", "rp1"), null);
  assert.equal(runpodOutputPath("/x/From YTM/media/other/a.png", "rp1"), null);
  assert.equal(geminiOutputPath("gemini/gm_1/video-1.mp4"), "From YTM/gemini/gm_1/video-1.mp4");
  assert.equal(geminiOutputPath("../gemini/x.mp4"), null);
  // A RunPod output not pulled yet has no path to share.
  assert.deepEqual(toSharedRunpodJob(runpodJob({ outputs: [{ ...runpodJob().outputs[0], localPath: null }] }), shareProgress, errorCode).outputs, []);
});

test("the report keeps every unfinished job and finished ones of the last 7 days (owner msg 2806), newest first", () => {
  const day = 24 * 60 * 60_000;
  const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const jobs = [
    shared({ jobId: "old-done", status: "done", createdAt: at(9 * day), finishedAt: at(8 * day) }),
    shared({ jobId: "edge-in", status: "failed", createdAt: at(8 * day), finishedAt: at(7 * day) }),
    shared({ jobId: "edge-out", status: "cancelled", createdAt: at(8 * day), finishedAt: at(7 * day + 1) }),
    shared({ jobId: "old-queued", status: "queued", createdAt: at(30 * day), finishedAt: null }),
    shared({ jobId: "gem-running", source: "gemini", status: "running", createdAt: at(20 * day), finishedAt: null }),
    shared({ jobId: "recent", status: "done", createdAt: at(day), finishedAt: at(day - 60_000) }),
  ];
  assert.deepEqual(
    selectReportJobs(jobs, NOW).map((j) => j.jobId),
    ["recent", "edge-in", "gem-running", "old-queued"]
  );
});

test("at most 1000 jobs: unfinished ones are kept before finished ones", () => {
  const at = (i: number) => new Date(NOW.getTime() - i * 1000).toISOString();
  const finished = Array.from({ length: 1000 }, (_, i) => shared({ jobId: `done${i}`, createdAt: at(i), finishedAt: at(i) }));
  const open = Array.from({ length: 5 }, (_, i) => shared({ jobId: `open${i}`, status: "generating", createdAt: at(5000 + i), finishedAt: null }));
  const kept = selectReportJobs([...finished, ...open], NOW);
  assert.equal(kept.length, 1000);
  for (let i = 0; i < 5; i++) assert.ok(kept.some((j) => j.jobId === `open${i}`), `open${i} kept`);
  assert.equal(kept.some((j) => j.jobId === "done999"), false);
  assert.equal(kept[0].jobId, "done0");
});

test("a job that would break the report is left out, not the whole report", () => {
  const report = buildMediaJobsReport({ deviceId: "mac", hostName: "Mac", now: NOW, jobs: [shared({ jobId: "ok" }), shared({ jobId: "bad id with spaces" })] });
  assert.deepEqual(report.jobs.map((j) => j.jobId), ["ok"]);
  assert.equal(report.format, MEDIA_JOBS_REPORT_FORMAT);
  assert.ok(mediaJobsReportSchema.safeParse(report).success);
});

const peerReport = (deviceId: string, updatedAt: string, jobs: SharedMediaJob[]): MediaJobsReport => ({ format: MEDIA_JOBS_REPORT_FORMAT, version: 1, deviceId, hostName: deviceId === "win" ? "Windows PC" : deviceId, updatedAt, jobs });

function mergeInput(extra: Partial<MergeInput> = {}): MergeInput {
  return {
    own: { deviceId: "mac", hostName: "Mac", runpod: [runpodJob({ progress })], gemini: [geminiJob()] },
    peers: [peerReport("win", "2026-10-14T11:59:00.000Z", [shared({ jobId: "w1", createdAt: "2026-10-14T11:00:00.000Z", outputs: ["From YTM/media/w1/a.png", "From YTM/media/w1/b.png"] })])],
    now: NOW,
    channelId: "UC1",
    kind: null,
    shareProgress,
    errorCode,
    hasLocalFile: async (p) => p.endsWith("/a.png"),
    limit: 50,
    ...extra,
  };
}

test("one list: this computer's RunPod and Gemini jobs and the peer's, newest first, each with its computer", async () => {
  const view = await mergePool(mergeInput());
  assert.deepEqual(view.jobs.map((j) => [j.jobId, j.hostName, j.own]), [["w1", "Windows PC", false], ["rp1", "Mac", true], ["gm_1", "Mac", true]]);
  assert.deepEqual(view.devices.map((d) => [d.deviceId, d.own, d.stale]), [["mac", true, false], ["win", false, false]]);
  // Own jobs keep their full detail here; a peer's job has none to show.
  const own = view.jobs.find((j) => j.jobId === "rp1");
  assert.equal(own?.liveProgress?.detail, progress.detail);
  assert.equal(view.jobs.find((j) => j.jobId === "w1")?.error, null);
});

test("a peer's file is 'here' only when this computer's copy of the workspace has it", async () => {
  const peer = (await mergePool(mergeInput())).jobs.find((j) => j.jobId === "w1");
  assert.deepEqual(peer?.outputs.map((o) => [o.name, o.available]), [["a.png", true], ["b.png", false]]);
});

test("a peer silent for more than 5 minutes is stale; its jobs are still listed", async () => {
  const view = await mergePool(mergeInput({ peers: [peerReport("win", "2026-10-14T11:54:59.000Z", [shared({ jobId: "w1" })])] }));
  assert.equal(view.devices.find((d) => d.deviceId === "win")?.stale, true);
  assert.equal(view.jobs.find((j) => j.jobId === "w1")?.stale, true);
  const fresh = await mergePool(mergeInput({ peers: [peerReport("win", "2026-10-14T11:55:01.000Z", [shared({ jobId: "w1" })])] }));
  assert.equal(fresh.devices.find((d) => d.deviceId === "win")?.stale, false);
});

test("only the active channel's jobs and the tab's kind; a job of no known kind shows under every kind", async () => {
  const peers = [
    peerReport("win", "2026-10-14T11:59:00.000Z", [
      shared({ jobId: "other-channel", channelId: "UC2" }),
      shared({ jobId: "audio", mediaKind: "audio" }),
      shared({ jobId: "unknown", mediaKind: null }),
    ]),
  ];
  const images = await mergePool(mergeInput({ peers, kind: "image" }));
  assert.deepEqual(images.jobs.map((j) => j.jobId).sort(), ["rp1", "unknown"]);
  const videos = await mergePool(mergeInput({ peers, kind: "video" }));
  assert.deepEqual(videos.jobs.map((j) => j.jobId).sort(), ["gm_1", "unknown"]);
});

test("a peer report naming this computer is ignored, and a job id already listed is not listed twice", async () => {
  const view = await mergePool(
    mergeInput({ peers: [peerReport("mac", "2026-10-14T11:59:00.000Z", [shared({ jobId: "ghost" })]), peerReport("win", "2026-10-14T11:59:00.000Z", [shared({ jobId: "rp1", status: "queued" })])] })
  );
  assert.deepEqual(view.jobs.map((j) => j.jobId).sort(), ["gm_1", "rp1"]);
  assert.equal(view.jobs.find((j) => j.jobId === "rp1")?.own, true);
});

test("the newest `limit` rows are returned, and a peer's files are looked up only for those", async () => {
  const looked: string[] = [];
  const peers = [peerReport("win", "2026-10-14T11:59:00.000Z", [shared({ jobId: "new", createdAt: "2026-10-14T11:50:00.000Z", outputs: ["From YTM/media/new/a.png"] }), shared({ jobId: "older", createdAt: "2026-10-01T00:00:00.000Z", outputs: ["From YTM/media/older/a.png"] })])];
  const view = await mergePool(mergeInput({ peers, limit: 2, hasLocalFile: async (p) => (looked.push(p), true) }));
  assert.deepEqual(view.jobs.map((j) => j.jobId), ["new", "rp1"]);
  assert.deepEqual(looked, ["From YTM/media/new/a.png"]);
});

test("the shared-list module is one-way: media-generation and gemini-media never import it (AGENTS.md §M)", async () => {
  const lib = path.join(process.cwd(), "src", "lib");
  const walk = async (d: string): Promise<string[]> =>
    (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : Promise.resolve([path.join(d, e.name)]))))).flat();
  const offenders: string[] = [];
  for (const name of ["media-generation", "gemini-media"]) {
    for (const file of (await walk(path.join(lib, name))).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
      if (/from\s+["']@\/lib\/media-jobs-pool/.test(await readFile(file, "utf8"))) offenders.push(path.relative(lib, file));
    }
  }
  assert.deepEqual(offenders, []);
});
