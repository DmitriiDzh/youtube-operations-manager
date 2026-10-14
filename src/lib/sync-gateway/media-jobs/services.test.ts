import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MEDIA_JOBS_REPORT_FORMAT, MEDIA_JOBS_REPORT_MAX, mediaJobsReportSchema, type MediaJobsReport, type SharedMediaJob } from "./contracts";
import { createMediaJobsShareCore, type MediaJobsReportStore } from "./services";

// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.1, §3, acceptance §4.1 items 1 and 7): the media jobs report carries ids, status, progress,
// links, cost, times and output paths -- never a URL, token, prompt or a provider's error text; it is strict, bounded, and the
// family imports nothing from the modules whose jobs it carries.

function memoryStore(): MediaJobsReportStore & { peers: Record<string, string> } {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    peers,
    readLocal: async () => local,
    writeLocal: async (json) => {
      local = json;
    },
    readPeers: async () => ({ ...peers }),
    writePeer: async (id, json) => {
      peers[id] = json;
    },
  };
}

const job = (extra: Partial<SharedMediaJob> = {}): SharedMediaJob => ({
  jobId: "job1",
  source: "runpod",
  channelId: "UC1",
  mediaKind: "image",
  status: "done",
  createdBy: "factory",
  label: "flux v2",
  sessionId: "s1",
  progress: null,
  plan: null,
  storyboard: null,
  costUsd: null,
  costIsEstimate: false,
  errorCode: null,
  createdAt: "2026-10-14T10:00:00.000Z",
  submittedAt: "2026-10-14T10:00:05.000Z",
  finishedAt: "2026-10-14T10:02:00.000Z",
  outputs: ["From YTM/media/job1/flux_00001_.png"],
  ...extra,
});

const report = (deviceId: string, updatedAt: string, jobs: SharedMediaJob[] = [job()]): MediaJobsReport => ({
  format: MEDIA_JOBS_REPORT_FORMAT,
  version: 1,
  deviceId,
  hostName: "Windows PC",
  updatedAt,
  jobs,
});

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const core = (store: MediaJobsReportStore, own = "mac") =>
  createMediaJobsShareCore({ store, ownDeviceId: async () => own, clock: { now: () => new Date("2026-10-14T12:00:00.000Z") } });

test("a valid peer report is kept and listed; this computer's own report never comes back as a peer", async () => {
  const store = memoryStore();
  const share = core(store);
  assert.deepEqual(await share.mergeIncoming(encode(report("win", "2026-10-14T11:59:00.000Z")), "win"), { accepted: true });
  assert.deepEqual(await share.mergeIncoming(encode(report("mac", "2026-10-14T11:59:00.000Z")), "mac"), { accepted: false });
  const peers = await share.listPeerReports();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].deviceId, "win");
  assert.equal(peers[0].jobs[0].jobId, "job1");
});

test("a report in one computer's file that claims to be another's is refused", async () => {
  await assert.rejects(core(memoryStore()).mergeIncoming(encode(report("other", "2026-10-14T11:59:00.000Z")), "win"));
});

test("no field outside the allowlist crosses: a URL, a token, a prompt or an error text makes the report invalid", () => {
  for (const extra of [{ comfyUrl: "https://abc-8188.proxy.runpod.net/?token=s3cr3t" }, { prompt: "a secret prompt" }, { error: "CUDA error: out of memory at /root/ComfyUI" }, { params: { seed: 1 } }]) {
    const parsed = mediaJobsReportSchema.safeParse(report("win", "2026-10-14T11:59:00.000Z", [{ ...job(), ...extra } as SharedMediaJob]));
    assert.equal(parsed.success, false, `${Object.keys(extra)[0]} must not be accepted`);
  }
  // The report itself is strict too.
  assert.equal(mediaJobsReportSchema.safeParse({ ...report("win", "2026-10-14T11:59:00.000Z"), apiKey: "AIza..." }).success, false);
});

test("an error crosses as a code only: provider text in the code field is refused", () => {
  assert.equal(mediaJobsReportSchema.safeParse(report("win", "2026-10-14T11:59:00.000Z", [job({ status: "failed", errorCode: "gemini_blocked" })])).success, true);
  assert.equal(mediaJobsReportSchema.safeParse(report("win", "2026-10-14T11:59:00.000Z", [job({ status: "failed", errorCode: "Error: the request was blocked by safety filters" })])).success, false);
});

test("an output path must be relative with / separators and no . or .. segment", () => {
  for (const bad of ["/Users/me/ch/99 Data Exchange/From YTM/media/job1/a.png", "C:/ch/a.png", "From YTM\\media\\job1\\a.png", "From YTM/media/../../secrets.txt", "From YTM//a.png"]) {
    assert.equal(mediaJobsReportSchema.safeParse(report("win", "2026-10-14T11:59:00.000Z", [job({ outputs: [bad] })])).success, false, bad);
  }
});

test("a report is bounded: at most 1000 jobs", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => job({ jobId: `job${i}` }));
  assert.equal(mediaJobsReportSchema.safeParse(report("win", "2026-10-14T11:59:00.000Z", many(MEDIA_JOBS_REPORT_MAX))).success, true);
  assert.equal(mediaJobsReportSchema.safeParse(report("win", "2026-10-14T11:59:00.000Z", many(MEDIA_JOBS_REPORT_MAX + 1))).success, false);
});

test("an older report never replaces a newer one", async () => {
  const share = core(memoryStore());
  await share.mergeIncoming(encode(report("win", "2026-10-14T11:59:00.000Z", [job({ status: "done" })])), "win");
  assert.deepEqual(await share.mergeIncoming(encode(report("win", "2026-10-14T11:00:00.000Z", [job({ status: "queued" })])), "win"), { accepted: false });
  assert.equal((await share.listPeerReports())[0].jobs[0].status, "done");
});

test("the media-jobs family imports nothing from media-generation, gemini-media or the shared-list module (AGENTS.md §M)", async () => {
  const offenders: string[] = [];
  for (const dir of ["media-jobs", "media-jobs-sync"]) {
    const root = path.join(process.cwd(), "src", "lib", "sync-gateway", dir);
    const walk = async (d: string): Promise<string[]> =>
      (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : Promise.resolve([path.join(d, e.name)]))))).flat();
    for (const file of (await walk(root)).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
      if (/from\s+["']@\/lib\/(media-generation|gemini-media|media-jobs-pool)(\/|["'])/.test(await readFile(file, "utf8"))) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
