import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/gemini-media";
import { createGeminiJobCancelHandler, type GeminiJobCancelRouteDeps } from "./route";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.5) with ADR 0004 (b) (independent review): the owner cancels a Gemini job of
// THIS computer from Media, whose list is the session's ACTIVE channel. Expected: a Web session is required (401); a job of
// another channel -- or any job while no channel is active -- is refused 403 `CHANNEL_NOT_AUTHORIZED` and never cancelled; an
// unknown job is 404; a job of the active channel reaches the Gemini module's own cancel.

const JOBS: Record<string, { jobId: string; channelId: string; status: string }> = {
  gm_mine: { jobId: "gm_mine", channelId: "UC_ACTIVE", status: "queued" },
  gm_other: { jobId: "gm_other", channelId: "UC_OTHER", status: "queued" },
};

function deps(opts: { session?: boolean; active?: string | null } = {}) {
  const cancelled: string[] = [];
  const d: GeminiJobCancelRouteDeps = {
    getSession: async () => (opts.session === false ? null : { user: { id: "owner-1" } }),
    activeChannelOf: async (userId) => (userId === "owner-1" ? (opts.active === undefined ? "UC_ACTIVE" : opts.active) : null),
    core: {
      async getJobs(raw: unknown) {
        const jobId = (raw as { jobId: string }).jobId;
        const job = JOBS[jobId];
        if (!job) throw new DomainError({ code: "gemini_job_not_found", message: `No Gemini job ${jobId}` });
        return { job };
      },
      async cancelJob(jobId: string) {
        cancelled.push(jobId);
        return { job: { ...JOBS[jobId], status: "failed" } };
      },
    } as never,
  };
  return { d, cancelled };
}

const call = (d: GeminiJobCancelRouteDeps, jobId: string) =>
  createGeminiJobCancelHandler(d)(new Request(`http://localhost/api/gemini-media/jobs/${jobId}/cancel`, { method: "POST" }), { params: Promise.resolve({ jobId }) });

test("401 without a Web session; nothing is cancelled", async () => {
  const { d, cancelled } = deps({ session: false });
  assert.equal((await call(d, "gm_mine")).status, 401);
  assert.deepEqual(cancelled, []);
});

test("a job of the active channel is cancelled through the Gemini module's own cancel", async () => {
  const { d, cancelled } = deps();
  const res = await call(d, "gm_mine");
  assert.equal(res.status, 200);
  assert.deepEqual(cancelled, ["gm_mine"]);
});

test("a job of another channel, or any job while no channel is active, is refused 403 and left as it is", async () => {
  for (const active of ["UC_ACTIVE", null] as const) {
    const { d, cancelled } = deps({ active });
    const res = await call(d, active === null ? "gm_mine" : "gm_other");
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "CHANNEL_NOT_AUTHORIZED");
    assert.deepEqual(cancelled, []);
  }
});

test("an unknown job is 404", async () => {
  const { d, cancelled } = deps();
  assert.equal((await call(d, "gm_missing")).status, 404);
  assert.deepEqual(cancelled, []);
});
