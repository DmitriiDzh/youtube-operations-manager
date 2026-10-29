import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createPublishingPlanRouteHandlers, type PublishingPlanRouteDeps } from "./handlers";

// BL-225 AC-WP-12 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 4; AGENTS.md §F): the owner's plan routes need a Web session (401) and the
// ACTIVE channel (403, another channel reaches nothing); a decision goes to the module with the session's user; the module's
// refusals keep their codes and statuses (a stale hash 409, an unknown plan 404).

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const post = (body: unknown) => new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function make(options: { session?: { user: { id: string } } | null; refuse?: DomainError } = {}) {
  const calls: unknown[][] = [];
  const deps: PublishingPlanRouteDeps = {
    getSession: async () => (options.session === undefined ? { user: { id: "u1" } } : options.session),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not the active channel" });
    },
    service: () => ({
      ownerList: async (...args) => (calls.push(["list", ...args]), { plans: [], waiting: 0 }),
      ownerGet: async (...args) => {
        calls.push(["get", ...args]);
        if (options.refuse) throw options.refuse;
        return { plan: {} as never };
      },
      decide: async (...args) => {
        calls.push(["decide", ...args]);
        if (options.refuse) throw options.refuse;
        return { plan: {} as never, decided: ["s1"] };
      },
    }),
  };
  return { handlers: createPublishingPlanRouteHandlers(deps), calls };
}

test("AC-WP-12: no session -> 401, another channel -> 403; neither reaches the module", async () => {
  const anonymous = make({ session: null });
  assert.equal((await anonymous.handlers.list(new Request("http://x/"), ctx({ channelId: "UC_active" }))).status, 401);
  const other = make();
  assert.equal((await other.handlers.decide(post({ action: "veto", slots: [{ slotId: "s1" }] }), ctx({ channelId: "UC_other", weekStart: "2026-10-26" }))).status, 403);
  assert.equal((await other.handlers.detail(new Request("http://x/"), ctx({ channelId: "UC_other", weekStart: "2026-10-26" }))).status, 403);
  assert.deepEqual([...anonymous.calls, ...other.calls], []);
});

test("AC-WP-12: a decision reaches the module with the channel, the week, the body and the session's user", async () => {
  const { handlers, calls } = make();
  const body = { action: "approve", slots: [{ slotId: "s1", contentHash: "a".repeat(64) }] };
  const res = await handlers.decide(post(body), ctx({ channelId: "UC_active", weekStart: "2026-10-26" }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [["decide", "UC_active", "2026-10-26", body, "u1"]]);
});

test("AC-WP-12: the module's refusals keep their codes: a stale hash is 409, an unknown plan 404", async () => {
  const stale = make({ refuse: new DomainError({ code: "publishing_plan_changed", message: "changed" }) });
  const res = await stale.handlers.decide(post({ action: "approve", slots: [] }), ctx({ channelId: "UC_active", weekStart: "2026-10-26" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "publishing_plan_changed");
  const missing = make({ refuse: new DomainError({ code: "publishing_plan_not_found", message: "none" }) });
  assert.equal((await missing.handlers.detail(new Request("http://x/"), ctx({ channelId: "UC_active", weekStart: "2026-11-02" }))).status, 404);
});

// BL-235 (owner msgs 3806/3807): one plan comes with its week's coverage on YouTube (the plan's week and zone); the plan's own
// answer is unchanged, and a failing coverage read leaves `coverage: null` instead of failing the plan.
test("BL-235: the plan's week coverage is read for weekStart in the plan's zone and returned next to the plan", async () => {
  const asked: unknown[] = [];
  const deps: PublishingPlanRouteDeps = {
    getSession: async () => ({ user: { id: "u1" } }),
    assertActiveChannel: async () => undefined,
    service: () => ({
      ownerList: async () => ({ plans: [], waiting: 0 }),
      ownerGet: async () => ({ plan: { weekStart: "2026-11-02", timeZone: "Asia/Tokyo" } as never }),
      decide: async () => ({ plan: {} as never, decided: [] }),
    }),
    coverage: async (...args) => {
      asked.push(args);
      return { summary: { covered: 4 } } as never;
    },
  };
  const res = await createPublishingPlanRouteHandlers(deps).detail(new Request("http://x/"), ctx({ channelId: "UC_active", weekStart: "2026-11-02" }));
  assert.deepEqual(await res.json(), { plan: { weekStart: "2026-11-02", timeZone: "Asia/Tokyo" }, coverage: { summary: { covered: 4 } } });
  assert.deepEqual(asked, [["UC_active", "2026-11-02", "Asia/Tokyo"]]);
  const failing = await createPublishingPlanRouteHandlers({ ...deps, coverage: async () => Promise.reject(new Error("down")) }).detail(new Request("http://x/"), ctx({ channelId: "UC_active", weekStart: "2026-11-02" }));
  assert.equal(failing.status, 200);
  assert.equal((await failing.json()).coverage, null);
});
