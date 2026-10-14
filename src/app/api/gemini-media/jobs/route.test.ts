import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/gemini-media";
import { createGeminiJobsPostHandler, type GeminiJobsRouteDeps } from "./route";

// BL-188 stage 4 (SHARED_MEDIA_JOBS_PLAN.md §5 item 4, owner msg 2806 Q3): the owner's own Gemini job from Media, on this
// computer. Expected from the plan and ADR 0004 (b): a Web session is required; the channel is the session's ACTIVE channel and
// never one from the request; the job is the owner's; the Gemini module's own refusals (switch, key, limits) come back with
// their code and status; a dry run only answers the estimate.

type Call = { input: Record<string, unknown>; actor: string };

function deps(opts: { session?: boolean; active?: string | null; refuse?: string } = {}) {
  const calls: Call[] = [];
  const d: GeminiJobsRouteDeps = {
    getSession: async () => (opts.session === false ? null : { user: { id: "owner-1" } }),
    activeChannelOf: async (userId) => (userId === "owner-1" ? (opts.active === undefined ? "UC_ACTIVE" : opts.active) : null),
    core: {
      async createJob(raw: unknown, actor: string) {
        calls.push({ input: raw as Record<string, unknown>, actor });
        if (opts.refuse) throw new DomainError({ code: opts.refuse as never, message: `refused: ${opts.refuse}` });
        if ((raw as { dryRun?: boolean }).dryRun) return { dryRun: true, estimateUsd: 0.04, allowed: true, refusal: null, spend: {} };
        return { job: { jobId: "gm_1" } };
      },
    } as never,
  };
  return { d, calls };
}

const post = (body: unknown) => new Request("http://localhost/api/gemini-media/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const request = { kind: "image", model: "gemini-nano-banana-2.1", prompt: "a tea house", image: { size: "1K", aspectRatio: "16:9" } };

test("401 without a Web session; nothing reaches Gemini", async () => {
  const { d, calls } = deps({ session: false });
  assert.equal((await createGeminiJobsPostHandler(d)(post(request))).status, 401);
  assert.equal(calls.length, 0);
});

test("the job is the owner's, for the ACTIVE channel (201)", async () => {
  const { d, calls } = deps();
  const res = await createGeminiJobsPostHandler(d)(post(request));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { job: { jobId: "gm_1" } });
  assert.deepEqual(calls, [{ input: { ...request, channelId: "UC_ACTIVE" }, actor: "owner" }]);
});

test("a body naming a channel is refused (the channel is never taken from the request); so is a non-object or bad JSON", async () => {
  const { d, calls } = deps();
  for (const body of [{ ...request, channelId: "UC_OTHER" }, [request], "{not json", "null"]) {
    const res = await createGeminiJobsPostHandler(d)(post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, "validation_failed");
  }
  assert.equal(calls.length, 0);
});

test("no active channel: refused before Gemini", async () => {
  const { d, calls } = deps({ active: null });
  const res = await createGeminiJobsPostHandler(d)(post(request));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("a dry run answers the estimate (200) and is still the owner's, for the active channel", async () => {
  const { d, calls } = deps();
  const res = await createGeminiJobsPostHandler(d)(post({ ...request, dryRun: true }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).estimateUsd, 0.04);
  assert.equal(calls[0].input.channelId, "UC_ACTIVE");
});

test("the Gemini module's own refusals come back with their code (limits, switch, key)", async () => {
  for (const [code, status] of [["gemini_limit_exceeded", 409], ["gemini_disabled", 409], ["gemini_key_missing", 409], ["gemini_invalid_params", 422]] as const) {
    const { d } = deps({ refuse: code });
    const res = await createGeminiJobsPostHandler(d)(post(request));
    const body = await res.json();
    assert.equal(body.error, code);
    if (code !== "gemini_invalid_params") assert.equal(res.status, status, code);
    else assert.ok(res.status >= 400 && res.status < 500, code);
  }
});
