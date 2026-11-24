import assert from "node:assert/strict";
import test from "node:test";
import { createCrossPostRunner, jobIdOf, ownerRetryPending, slotsBeyondLookback, type PlannedCrossPost, type SocialJob } from "@/lib/cross-posting/runner";
import { stillApprovedVia, type PlanRead } from "./cross-posting-approval";

// Owner TG 4780, fix f90c4761 (review 23.11 item 8): an Instagram post the owner retried days late is published on a LATER pass, when
// its container is FINISHED -- the approval re-check right before that publish must read the slot past the plan's 36 h look-back.
// The plan read here behaves as publishing-plans' social read does (by hand): it shows an approved slot only when its time is at most
// 36 h past, or when its id is passed in `alsoSlotIds`. Expected: the container is published (`ig.publish`), not failed as
// `social_approval_stale`.

const LOOKBACK_MS = 36 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const T0 = Date.parse("2026-11-20T12:00:00Z");

const slot: PlannedCrossPost = {
  channelId: "UC1",
  slotId: "s6",
  video: "S6",
  manifestSha256: "m-s6",
  publishAt: T0,
  slotDate: "2026-11-20",
  timeZone: "UTC",
  crossPost: { instagram: { caption: "IG" } },
  videoFile: { path: "/w/s6.mp4", sizeBytes: 1000, durationSeconds: 30, width: 1080, height: 1920 },
  videoSha256: "a".repeat(64),
  isAiGenerated: false,
};

function world(read: PlanRead) {
  let now = T0 + 3 * DAY;
  const jobs = new Map<string, SocialJob>();
  const calls: string[] = [];
  const runner = createCrossPostRunner({
    plan: {
      entries: () => read("UC1", { alsoSlotIds: slotsBeyondLookback([...jobs.values()], "UC1") }),
      stillApproved: stillApprovedVia(read),
    },
    jobs: {
      get: async (id) => (jobs.has(id) ? { ...jobs.get(id)! } : null),
      listActive: async () => [...jobs.values()].filter((j) => j.status === "uploading" || j.status === "processing").map((j) => ({ ...j })),
      listRetries: async () => [...jobs.values()].filter(ownerRetryPending).map((j) => ({ ...j })),
      insert: async (job) => (jobs.has(job.jobId) ? false : (jobs.set(job.jobId, { ...job }), true)),
      update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }),
    },
    postingTarget: async (_c, network) => ({ network, token: "PT", pageId: "111", accountId: "1784" }),
    meta: {
      igCreateReelContainer: async () => (calls.push("ig.container"), { containerId: "C1" }),
      igUploadReel: async () => void calls.push("ig.upload"),
      igContainerStatus: async () => (calls.push("ig.status"), "FINISHED"),
      igPublish: async () => (calls.push("ig.publish"), { mediaId: "M1" }),
      igPermalink: async () => null,
      fbReelStart: async () => ({ videoId: "V1", uploadUrl: "https://rupload.facebook.com/x" }),
      fbUploadReel: async () => undefined,
      fbReelFinish: async () => undefined,
      fbVideoStatus: async () => ({ videoStatus: null, publishStatus: null, permalink: null }),
    },
    files: { body: (_p, size) => ({ stream: () => new Blob(["x"]).stream(), sizeBytes: size }), sha256: async () => "a".repeat(64) },
    enabled: async () => true,
    now: () => now,
    quotaOk: async () => true,
  });
  return { runner, jobs, calls, at: (ms: number) => (now = ms), nowMs: () => now };
}

/** As publishing-plans' social read: the slot when its time is at most 36 h past, or when it is named in `alsoSlotIds`. */
const lookbackRead = (clock: () => number): PlanRead => async (_channelId, opts) => (clock() - slot.publishAt <= LOOKBACK_MS || (opts.alsoSlotIds ?? []).includes(slot.slotId) ? [slot] : []);

test("an in-flight retried Instagram job 3 days after its slot: the approval re-check reads the slot past the look-back and publishes", async () => {
  let clock = () => 0;
  const w = world(lookbackRead(() => clock()));
  clock = w.nowMs;
  const id = jobIdOf("UC1", "s6", "instagram");
  w.jobs.set(id, { jobId: id, channelId: "UC1", slotId: "s6", video: "S6", network: "instagram", manifestSha256: "m-s6", plannedAt: T0, status: "processing", remoteId: "C1", uploadUrl: null, remotePostId: null, permalink: null, publishAttempted: false, errorCode: null, errorMessage: null, createdAt: T0 + 3 * DAY, updatedAt: T0 + 3 * DAY, ownerRetryAt: null });
  await w.runner.tick();
  const job = w.jobs.get(id)!;
  assert.equal(job.errorCode, null);
  assert.equal(job.status, "published");
  assert.equal(job.remotePostId, "M1");
  assert.deepEqual(w.calls, ["ig.status", "ig.publish"]);
});

test("the re-check still refuses a slot the plan no longer approves (any age): nothing published", async () => {
  const w = world(async () => []);
  const id = jobIdOf("UC1", "s6", "instagram");
  w.jobs.set(id, { jobId: id, channelId: "UC1", slotId: "s6", video: "S6", network: "instagram", manifestSha256: "m-s6", plannedAt: T0, status: "processing", remoteId: "C1", uploadUrl: null, remotePostId: null, permalink: null, publishAttempted: false, errorCode: null, errorMessage: null, createdAt: T0 + 3 * DAY, updatedAt: T0 + 3 * DAY, ownerRetryAt: null });
  await w.runner.tick();
  assert.equal(w.jobs.get(id)!.errorCode, "social_approval_stale");
  assert.ok(!w.calls.includes("ig.publish"));
});

// The owner may click «Повторить» while a pass is reading the plan: that pass could not list the old slot yet, so it must not drop the
// fresh mark as `retry_slot_not_approved` -- the next pass lists the slot and posts it.
test("a retry marked while the pass reads the plan is kept for the next pass, then posted", async () => {
  let clock = () => 0;
  let onRead: (() => void) | null = null;
  const base = lookbackRead(() => clock());
  const w = world(async (c, o) => {
    const out = await base(c, o);
    onRead?.();
    onRead = null;
    return out;
  });
  clock = w.nowMs;
  const id = jobIdOf("UC1", "s6", "instagram");
  w.jobs.set(id, { jobId: id, channelId: "UC1", slotId: "s6", video: "S6", network: "instagram", manifestSha256: "m-s6", plannedAt: T0, status: "failed", remoteId: null, uploadUrl: null, remotePostId: null, permalink: null, publishAttempted: false, errorCode: "missed_window", errorMessage: "late", createdAt: T0, updatedAt: T0, ownerRetryAt: null });
  onRead = () => w.jobs.set(id, { ...w.jobs.get(id)!, ownerRetryAt: w.nowMs() });
  await w.runner.tick();
  assert.equal(w.jobs.get(id)!.ownerRetryAt, T0 + 3 * DAY, "the fresh mark is not dropped");
  assert.equal(w.jobs.get(id)!.errorCode, "missed_window");
  w.at(T0 + 3 * DAY + 60_000);
  await w.runner.tick(); // the slot is listed now: container + upload
  await w.runner.tick(); // FINISHED -> publish
  assert.equal(w.jobs.get(id)!.status, "published");
});
