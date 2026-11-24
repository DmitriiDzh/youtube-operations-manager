import assert from "node:assert/strict";
import test from "node:test";
import type { CrossPostingCore, SocialJob } from "@/lib/cross-posting";
import { createJobsGetHandler } from "./route";

// Owner TG 4780 (review 23.11): the jobs list must carry the owner's pending retry, so the screen shows «Повтор запрошен» instead of
// offering Retry again. A job without a retry answers null (never undefined, never dropped).

const job = (over: Partial<SocialJob>): SocialJob => ({ jobId: "UC1|s6|facebook", channelId: "UC1", slotId: "s6", video: "S6", network: "facebook", manifestSha256: "m", plannedAt: 1000, status: "failed", remoteId: null, uploadUrl: null, remotePostId: null, permalink: null, publishAttempted: false, errorCode: "missed_window", errorMessage: "late", createdAt: 1000, updatedAt: 2000, ...over });

test("GET /api/social/jobs: ownerRetryAt is passed through (the pending retry's time, else null); no token-like field", async () => {
  const jobs = [job({ ownerRetryAt: 5000 }), job({ jobId: "UC1|s7|facebook", slotId: "s7" }), job({ jobId: "UC1|s8|instagram", slotId: "s8", network: "instagram", ownerRetryAt: null })];
  const handler = createJobsGetHandler({ getSession: async () => ({ user: { id: "u1" } }), core: { listJobs: async () => jobs } as unknown as CrossPostingCore });
  const res = await handler(new Request("http://localhost/api/social/jobs"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };
  assert.deepEqual(body.jobs.map((j) => [j.jobId, j.ownerRetryAt]), [["UC1|s6|facebook", 5000], ["UC1|s7|facebook", null], ["UC1|s8|instagram", null]]);
  assert.equal(body.jobs[0].errorCode, "missed_window");
  assert.ok(!("uploadUrl" in body.jobs[0]));
});

test("GET /api/social/jobs: without a web session 401", async () => {
  const handler = createJobsGetHandler({ getSession: async () => null, core: { listJobs: async () => [job({ ownerRetryAt: 5000 })] } as unknown as CrossPostingCore });
  assert.equal((await handler(new Request("http://localhost/api/social/jobs"))).status, 401);
});
