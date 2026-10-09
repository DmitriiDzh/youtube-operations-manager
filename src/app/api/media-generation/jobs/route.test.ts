import assert from "node:assert/strict";
import test from "node:test";
import type { MediaGenerationCore } from "@/lib/media-generation";
import type { MediaRouteDeps } from "../shared";
import { createJobsGetHandler, createJobsPostHandler } from "./route";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-03, ADR 0004 (b)): Media → Jobs lists only the session's active channel's jobs. The
// channel is resolved on the server; a channel named in the request never widens what `scope=active` returns.

function setup(active: string | null) {
  const asked: Array<Record<string, unknown>> = [];
  const deps: MediaRouteDeps = {
    getSession: async () => ({ user: { id: "u1" } }),
    core: {
      async listJobs(input: Record<string, unknown>) {
        asked.push(input);
        return [];
      },
    } as unknown as MediaGenerationCore,
    isConnectedChannel: async () => true,
  };
  const users: string[] = [];
  const handler = createJobsGetHandler(deps, async (userId) => (users.push(userId), active));
  return { handler, asked, users };
}

test("AC-SM-03: scope=active lists the session's active channel's jobs, whatever channelId the request names", async () => {
  const s = setup("UC_japan");
  const res = await s.handler(new Request("http://127.0.0.1/api/media-generation/jobs?scope=active&channelId=UC_tropico"));
  assert.equal(res.status, 200);
  assert.deepEqual(s.asked, [{ channelId: "UC_japan" }]);
  assert.deepEqual(s.users, ["u1"]);
});

test("AC-SM-03: scope=active with no active channel lists nothing and asks the core nothing (fail-closed)", async () => {
  const s = setup(null);
  const res = await s.handler(new Request("http://127.0.0.1/api/media-generation/jobs?scope=active"));
  assert.deepEqual(await res.json(), { jobs: [] });
  assert.deepEqual(s.asked, []);
});

// BL-157 (review round 3): only the factory links a job to a plan -- the operator's own job never carries a plan link.
test("the operator's job is created without any plan link the request names", async () => {
  const created: Array<Record<string, unknown>> = [];
  const deps: MediaRouteDeps = {
    getSession: async () => ({ user: { id: "u1" } }),
    core: { createJob: async (input: Record<string, unknown>) => (created.push(input), { jobId: "j1" }) } as unknown as MediaGenerationCore,
    isConnectedChannel: async () => true,
  };
  const res = await createJobsPostHandler(deps)(
    new Request("http://127.0.0.1/api/media-generation/jobs", { method: "POST", body: JSON.stringify({ sessionId: "s1", channelId: "UC_japan", templateId: "t1", params: {}, plan: { planId: "R-1", stageId: "generate", itemKey: "A/1" } }) })
  );
  assert.equal(res.status, 201);
  assert.deepEqual(created, [{ sessionId: "s1", channelId: "UC_japan", templateId: "t1", params: {}, createdBy: "operator" }]);
});
