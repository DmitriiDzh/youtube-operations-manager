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
