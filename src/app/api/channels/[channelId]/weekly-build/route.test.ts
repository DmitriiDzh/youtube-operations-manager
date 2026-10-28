import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createWeeklyBuildStartHandler } from "./start/route";
import { createWeeklyBuildStopHandler } from "./stop/route";
import { createWeeklyBuildGetHandler } from "./route";
import type { WeeklyBuildRouteDeps } from "./shared";

// BL-231 acceptance 10 (WEEKLY_BUILD_BUTTON_PLAN.md): no session -> 401, not the active channel -> 403, nothing reaches the core.

const context = { params: Promise.resolve({ channelId: "UC1" }) };

function deps(options: { session?: boolean; active?: boolean } = {}) {
  const calls: string[] = [];
  const d: WeeklyBuildRouteDeps = {
    getSession: async () => (options.session === false ? null : { user: { id: "u1" } }),
    assertActiveChannel: async () => {
      if (options.active === false) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    core: {
      view: async () => (calls.push("view"), { readiness: { ready: true, bundle: "2.5.42", python: "/p" }, status: null, statusError: null, running: false }),
      dryRun: async () => (calls.push("dryRun"), { days: 7, dates: null, wake: false, steps: [], plan: null, stopped: false }),
      start: async (_id, input) => (calls.push(`start:${JSON.stringify(input)}`), { jobId: "J", log: "", pid: 1, clearedStop: false }),
      stop: async () => (calls.push("stop"), { stopped: true as const }),
    },
  };
  return { d, calls };
}

const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("AC 10: no session -> 401, nothing runs", async () => {
  const { d, calls } = deps({ session: false });
  assert.equal((await createWeeklyBuildGetHandler(d)(new Request("http://x"), context)).status, 401);
  assert.equal((await createWeeklyBuildStartHandler(d)(post({ days: 7 }), context)).status, 401);
  assert.equal((await createWeeklyBuildStopHandler(d)(post({}), context)).status, 401);
  assert.deepEqual(calls, []);
});

test("AC 10: not the active channel -> 403, nothing runs", async () => {
  const { d, calls } = deps({ active: false });
  assert.equal((await createWeeklyBuildStartHandler(d)(post({ days: 7 }), context)).status, 403);
  assert.deepEqual(calls, []);
});

test("start passes days and wake through; a module error keeps its status", async () => {
  const { d, calls } = deps();
  const response = await createWeeklyBuildStartHandler(d)(post({ days: 5, wake: true }), context);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['start:{"days":5,"wake":true}']);
  d.core.start = async () => {
    throw new DomainError({ code: "weekly_build_job_running", message: "runs" });
  };
  assert.equal((await createWeeklyBuildStartHandler(d)(post({ days: 7 }), context)).status, 409);
});
