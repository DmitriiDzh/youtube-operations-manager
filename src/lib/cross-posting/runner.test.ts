import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createCrossPostRunner, jobIdOf, MAX_LATE_MS, ownerRetryPending, type PlannedCrossPost, type RunnerDeps, type SocialJob } from "./runner";

// BL-252 stage 2 (ADR 0068 amendment 1; CROSS_POSTING_PLAN.md AC-XP-2/6/8/10/15) -- expectations from the plan, not the code:
//  - nothing happens while the switch is off; nothing before the planned time; a network's own "at" moves only that network;
//  - an approval that no longer covers the manifest stops a post before any publishing call;
//  - Instagram is published only after its container is FINISHED; Facebook's finish happens right after the upload;
//  - a job is never started twice; a restart mid-upload fails it without publishing; Instagram already PUBLISHED is not re-published;
//  - one network failing leaves the other untouched; a post more than 12 h late is not sent.

const T0 = Date.parse("2026-11-16T15:00:00Z"); // the slot's publishAt
const entry = (over: Partial<PlannedCrossPost> = {}): PlannedCrossPost => ({
  channelId: "UC1",
  slotId: "s1",
  video: "V70",
  manifestSha256: "m1",
  publishAt: T0,
  slotDate: "2026-11-16",
  timeZone: "UTC",
  crossPost: { instagram: { caption: "IG #x" }, facebook: { title: "T", description: "FB" } },
  videoFile: { path: "/w/V70.mp4", sizeBytes: 10_000, durationSeconds: 60, width: 1080, height: 1920 },
  isAiGenerated: true,
  videoSha256: "f".repeat(64),
  ...over,
});

function harness(opts: { entries?: PlannedCrossPost[]; enabled?: boolean; approved?: () => boolean; igStatus?: string[]; fbStatus?: string } = {}) {
  let now = T0;
  const jobs = new Map<string, SocialJob>();
  const calls: string[] = [];
  const igStatuses = [...(opts.igStatus ?? ["FINISHED"])];
  let approved = opts.approved ?? (() => true);
  let failNext: Record<string, DomainError | undefined> = {};
  const deps: RunnerDeps = {
    plan: { entries: async () => opts.entries ?? [entry()], stillApproved: async () => approved() },
    jobs: {
      get: async (id) => (jobs.has(id) ? { ...jobs.get(id)! } : null),
      listActive: async () => [...jobs.values()].filter((j) => j.status === "uploading" || j.status === "processing").map((j) => ({ ...j })),
      listRetries: async () => [...jobs.values()].filter(ownerRetryPending).map((j) => ({ ...j })),
      insert: async (job) => (jobs.has(job.jobId) ? false : (jobs.set(job.jobId, { ...job }), true)),
      update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }),
    },
    postingTarget: async (_c, network) => ({ network, token: "PT", pageId: "P1", accountId: network === "instagram" ? "IG1" : "P1" }),
    meta: {
      igCreateReelContainer: async (i) => (calls.push(`ig.container ai=${i.isAiGenerated} caption=${i.caption}`), { containerId: "C1" }),
      igUploadReel: async () => {
        calls.push("ig.upload");
        if (failNext["ig.upload"]) throw failNext["ig.upload"];
      },
      igContainerStatus: async () => (calls.push("ig.status"), igStatuses.shift() ?? "FINISHED"),
      igPublish: async () => {
        calls.push("ig.publish");
        const e = failNext["ig.publish"];
        failNext = {};
        if (e) throw e;
        return { mediaId: "M1" };
      },
      igPermalink: async () => "https://instagram.com/reel/x",
      fbReelStart: async () => (calls.push("fb.start"), { videoId: "V1", uploadUrl: "https://rupload.facebook.com/video-upload/v23.0/V1" }),
      fbUploadReel: async () => void calls.push("fb.upload"),
      fbReelFinish: async (i) => {
        calls.push(`fb.finish ai=${i.isAiGenerated} title=${i.title}`);
        const e = failNext["fb.finish"];
        failNext = {};
        if (e) throw e;
      },
      fbVideoStatus: async () => (calls.push("fb.status"), { videoStatus: opts.fbStatus ?? "ready", publishStatus: opts.fbStatus === "processing" ? "not_published" : "published", permalink: "https://facebook.com/reel/1" }),
    },
    files: { body: (_p, size) => ({ stream: () => new Blob(["x"]).stream(), sizeBytes: size }), sha256: async () => "f".repeat(64) },
    enabled: async () => opts.enabled ?? true,
    now: () => now,
  };
  return {
    runner: createCrossPostRunner(deps),
    jobs,
    calls,
    at: (ms: number) => (now = ms),
    setApproved: (f: () => boolean) => (approved = f),
    failOn: (call: string, e: DomainError) => (failNext = { [call]: e }),
  };
}

const IG = jobIdOf("UC1", "s1", "instagram");
const FB = jobIdOf("UC1", "s1", "facebook");

test("AC-XP-2: switch off -> no job, no call", async () => {
  const h = harness({ enabled: false });
  assert.equal((await h.runner.tick()).skipped, "disabled");
  assert.equal(h.jobs.size, 0);
  assert.deepEqual(h.calls, []);
});

test("AC-XP-15: nothing before the planned time; at the time both networks start; Instagram publishes on FINISHED", async () => {
  const h = harness({ igStatus: ["IN_PROGRESS", "FINISHED"] });
  h.at(T0 - 1);
  await h.runner.tick();
  assert.equal(h.jobs.size, 0);
  h.at(T0);
  await h.runner.tick();
  // 2026-11-23 (owner TG 4779: one network never waits for another): the networks run concurrently, so only each network's own
  // order is required -- the earlier "Instagram first, then Facebook" sequence was that coupling.
  assert.deepEqual(h.calls.filter((c) => c.startsWith("ig.")), ["ig.container ai=true caption=IG #x", "ig.upload"]);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("fb.")), ["fb.start", "fb.upload", "fb.finish ai=true title=T"]);
  assert.equal(h.jobs.get(IG)!.status, "processing");
  assert.equal(h.jobs.get(FB)!.status, "processing");
  h.calls.length = 0;
  await h.runner.tick(); // IG still IN_PROGRESS; FB ready -> published
  assert.deepEqual([...h.calls].sort(), ["fb.status", "ig.status"]); // concurrent networks: the set matters, not the order
  assert.equal(h.jobs.get(FB)!.status, "published");
  assert.equal(h.jobs.get(FB)!.permalink, "https://facebook.com/reel/1");
  assert.equal(h.jobs.get(IG)!.status, "processing");
  h.calls.length = 0;
  await h.runner.tick(); // IG FINISHED -> publish
  assert.deepEqual(h.calls, ["ig.status", "ig.publish"]);
  assert.equal(h.jobs.get(IG)!.status, "published");
  assert.equal(h.jobs.get(IG)!.remotePostId, "M1");
  h.calls.length = 0;
  await h.runner.tick(); // nothing left to do, nothing posted twice
  assert.deepEqual(h.calls, []);
});

test("AC-XP-15: a network's own `at` moves only that network (in the plan's time zone)", async () => {
  const e = entry({ timeZone: "Europe/Moscow", crossPost: { instagram: { caption: "c", at: "20:00" }, facebook: { description: "d" } } }); // 20:00 MSK = 17:00Z
  const h = harness({ entries: [e] });
  await h.runner.tick();
  assert.deepEqual([...h.jobs.keys()], [FB]);
  h.at(Date.parse("2026-11-16T17:00:00Z"));
  await h.runner.tick();
  assert.ok(h.jobs.has(IG));
});

test("AC-XP-10: an approval that no longer covers the manifest starts nothing; one lost after the upload stops Facebook's finish and Instagram's publish", async () => {
  const off = harness({ approved: () => false });
  await off.runner.tick();
  assert.equal(off.jobs.size, 0);
  assert.deepEqual(off.calls, []);

  let checks = 0;
  const h = harness({ approved: () => ++checks <= 2 }); // true for both starts, false at FB's pre-finish check
  await h.runner.tick();
  assert.ok(!h.calls.some((c) => c.startsWith("fb.finish")));
  assert.equal(h.jobs.get(FB)!.status, "failed");
  assert.equal(h.jobs.get(FB)!.errorCode, "social_approval_stale");
  h.calls.length = 0;
  await h.runner.tick();
  assert.ok(!h.calls.includes("ig.publish"));
  assert.equal(h.jobs.get(IG)!.errorCode, "social_approval_stale");
});

test("AC-XP-6: a restart mid-upload fails the job without publishing; an Instagram container already PUBLISHED is not published again", async () => {
  const h = harness({ igStatus: ["PUBLISHED"] });
  const now = T0;
  h.jobs.set(FB, { jobId: FB, channelId: "UC1", slotId: "s1", video: "V70", network: "facebook", manifestSha256: "m1", plannedAt: T0, status: "uploading", remoteId: "V1", uploadUrl: "u", remotePostId: null, permalink: null, publishAttempted: false, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now });
  h.jobs.set(IG, { ...h.jobs.get(FB)!, jobId: IG, network: "instagram", status: "processing", remoteId: "C1" });
  await h.runner.tick();
  assert.equal(h.jobs.get(FB)!.status, "failed");
  assert.equal(h.jobs.get(FB)!.errorCode, "interrupted");
  assert.equal(h.jobs.get(IG)!.status, "published");
  assert.ok(!h.calls.includes("ig.publish") && !h.calls.includes("fb.start") && !h.calls.some((c) => c.startsWith("fb.finish")));
});

test("AC-XP-6: one network failing leaves the other intact; the failure keeps Meta's code", async () => {
  const h = harness();
  h.failOn("ig.upload", new DomainError({ code: "social_request_rejected", message: "Meta refused ig.upload: bad video" }));
  await h.runner.tick();
  assert.equal(h.jobs.get(IG)!.status, "failed");
  assert.equal(h.jobs.get(IG)!.errorCode, "social_request_rejected");
  assert.equal(h.jobs.get(FB)!.status, "processing");
});

test("a post more than 12 h late is recorded as missed, not sent; a block with an unknown network posts nothing; a 91 s video skips only Facebook", async () => {
  const late = harness();
  late.at(T0 + MAX_LATE_MS + 1);
  await late.runner.tick();
  assert.equal(late.jobs.get(IG)!.errorCode, "missed_window");
  assert.deepEqual(late.calls, []);

  const broken = harness({ entries: [entry({ crossPost: { instagram: { caption: "c" }, tiktok: { caption: "c" } } })] });
  await broken.runner.tick();
  assert.equal(broken.jobs.size, 0);

  const long = harness({ entries: [entry({ videoFile: { path: "/w/v.mp4", sizeBytes: 10, durationSeconds: 91, width: 1080, height: 1920 } })] });
  await long.runner.tick();
  assert.deepEqual([...long.jobs.keys()], [IG]);
});

test("AC-XP-8: a failed identity read fails the job before any publishing call", async () => {
  const jobs = new Map<string, SocialJob>();
  const calls: string[] = [];
  const runner = createCrossPostRunner({
    plan: { entries: async () => [entry()], stillApproved: async () => true },
    jobs: {
      get: async (id) => jobs.get(id) ?? null,
      listActive: async () => [],
      listRetries: async () => [],
      insert: async (job) => (jobs.has(job.jobId) ? false : (jobs.set(job.jobId, job), true)),
      update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }),
    },
    postingTarget: async () => {
      throw new DomainError({ code: "social_account_mismatch", message: "The token reaches another Page." });
    },
    meta: new Proxy({}, { get: (_t, name) => async () => void calls.push(String(name)) }) as RunnerDeps["meta"],
    files: { body: (_p, size) => ({ stream: () => new Blob(["x"]).stream(), sizeBytes: size }), sha256: async () => "f".repeat(64) },
    enabled: async () => true,
    now: () => T0,
  });
  await runner.tick();
  assert.deepEqual(calls, []);
  assert.equal(jobs.get(IG)!.errorCode, "social_account_mismatch");
  assert.equal(jobs.get(FB)!.errorCode, "social_account_mismatch");
});

test("AC-XP-10: a package without the video's sha256 posts nothing; a file that no longer matches it fails before any upload", async () => {
  const noHash = harness({ entries: [entry({ videoSha256: null })] });
  await noHash.runner.tick();
  assert.equal(noHash.jobs.size, 0);

  const jobs = new Map<string, SocialJob>();
  const calls: string[] = [];
  const runner = createCrossPostRunner({
    plan: { entries: async () => [entry()], stillApproved: async () => true },
    jobs: { get: async (id) => jobs.get(id) ?? null, listActive: async () => [], listRetries: async () => [], insert: async (j) => (jobs.has(j.jobId) ? false : (jobs.set(j.jobId, j), true)), update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }) },
    postingTarget: async (_c, network) => ({ network, token: "PT", pageId: "P1", accountId: network === "instagram" ? "IG1" : "P1" }),
    meta: new Proxy({}, { get: (_t, name) => async () => void calls.push(String(name)) }) as RunnerDeps["meta"],
    files: { body: (_p, size) => ({ stream: () => new Blob(["x"]).stream(), sizeBytes: size }), sha256: async () => "0".repeat(64) },
    enabled: async () => true,
    now: () => T0,
  });
  await runner.tick();
  assert.deepEqual(calls, []);
  assert.equal(jobs.get(IG)!.errorCode, "social_approval_stale");
});

test("AC-XP-6: a lost answer to Facebook's finish or Instagram's publish keeps the job processing; neither is sent twice", async () => {
  const fb = harness({ fbStatus: "processing" });
  fb.failOn("fb.finish", new DomainError({ code: "social_unavailable", message: "Meta could not be reached (fb.reels_finish): timeout" }));
  await fb.runner.tick();
  assert.equal(fb.jobs.get(FB)!.status, "processing");
  fb.calls.length = 0;
  await fb.runner.tick();
  assert.deepEqual(fb.calls.filter((c) => c.startsWith("fb.")), ["fb.status"]);
  assert.equal(fb.jobs.get(FB)!.status, "processing", "not published until publish_status says so");

  const ig = harness({ igStatus: ["FINISHED", "PUBLISHED"] });
  await ig.runner.tick();
  ig.failOn("ig.publish", new DomainError({ code: "social_unavailable", message: "Meta could not be reached (ig.media_publish): timeout" }));
  await ig.runner.tick();
  assert.equal(ig.jobs.get(IG)!.status, "processing");
  ig.calls.length = 0;
  await ig.runner.tick();
  assert.deepEqual(ig.calls.filter((c) => c.startsWith("ig.")), ["ig.status"]);
  assert.equal(ig.jobs.get(IG)!.status, "published");
});

test("AC-XP-16: a network at its 24 h limit waits -- no job, nothing sent -- while the other posts", async () => {
  const jobs = new Map<string, SocialJob>();
  const calls: string[] = [];
  const runner = createCrossPostRunner({
    plan: { entries: async () => [entry()], stillApproved: async () => true },
    jobs: { get: async (id) => jobs.get(id) ?? null, listActive: async () => [], listRetries: async () => [], insert: async (j) => (jobs.has(j.jobId) ? false : (jobs.set(j.jobId, j), true)), update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }) },
    postingTarget: async (_c, network) => ({ network, token: "PT", pageId: "P1", accountId: network === "instagram" ? "IG1" : "P1" }),
    meta: new Proxy({}, { get: (_t, name) => async () => (calls.push(String(name)), { containerId: "C", videoId: "V", uploadUrl: "https://rupload.facebook.com/x" }) }) as RunnerDeps["meta"],
    files: { body: (_p, size) => ({ stream: () => new Blob(["x"]).stream(), sizeBytes: size }), sha256: async () => "f".repeat(64) },
    enabled: async () => true,
    now: () => T0,
    quotaOk: async (_c, network) => network === "facebook",
  });
  await runner.tick();
  assert.deepEqual([...jobs.keys()], [FB]);
  assert.ok(!calls.some((c) => c.startsWith("ig")));
});

test("review 14.11: a transient read failure after a publishing call keeps the job processing (no false 'failed', so no retry repost)", async () => {
  const jobs = new Map<string, SocialJob>();
  const base: SocialJob = { jobId: FB, channelId: "UC1", slotId: "s1", video: "V70", network: "facebook", manifestSha256: "m1", plannedAt: T0, status: "processing", remoteId: "V1", uploadUrl: "u", remotePostId: null, permalink: null, publishAttempted: true, errorCode: null, errorMessage: null, createdAt: T0, updatedAt: T0 };
  jobs.set(FB, base);
  let now = T0 + 60_000;
  const runner = createCrossPostRunner({
    plan: { entries: async () => [], stillApproved: async () => true },
    jobs: { get: async (id) => jobs.get(id) ?? null, listActive: async () => [...jobs.values()].filter((j) => j.status === "processing"), listRetries: async () => [], insert: async () => false, update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }) },
    postingTarget: async () => {
      throw new DomainError({ code: "social_unavailable", message: "Meta could not be reached (debug_token): timeout" });
    },
    meta: new Proxy({}, { get: () => async () => undefined }) as RunnerDeps["meta"],
    files: { body: (_p, size) => ({ stream: () => new Blob(["x"]).stream(), sizeBytes: size }), sha256: async () => "f".repeat(64) },
    enabled: async () => true,
    now: () => now,
  });
  await runner.tick();
  assert.equal(jobs.get(FB)!.status, "processing");
  now = T0 + 61 * 60_000; // past the processing timeout: then it fails (and publishAttempted forbids a retry)
  await runner.tick();
  assert.equal(jobs.get(FB)!.status, "failed");
  assert.equal(jobs.get(FB)!.publishAttempted, true);
});

test("review 14.11: Meta's 5xx on Facebook's finish keeps the job processing and marks the publish as attempted", async () => {
  const h = harness({ fbStatus: "processing" });
  h.failOn("fb.finish", new DomainError({ code: "social_request_rejected", message: "Meta refused fb.reels_finish: HTTP 502", details: { status: 502 } }));
  await h.runner.tick();
  assert.equal(h.jobs.get(FB)!.status, "processing");
  assert.equal(h.jobs.get(FB)!.publishAttempted, true);
});
