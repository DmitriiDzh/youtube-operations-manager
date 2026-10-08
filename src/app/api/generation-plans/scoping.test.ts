import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationPlanServices } from "@/lib/generation-plans";
import { DomainError } from "@/lib/shared-domain";
import { createPeersGetHandler } from "./peers/route";
import { planHandler, type PlanRouteDeps } from "./shared";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-03, ADR 0004 (b), review round 1): the owner's plan routes answer only for the session's
// ACTIVE channel -- resolved on the server, never taken from the request -- and the peers list carries nothing of another
// channel (plans, verdicts sent from here, claims).

const PLAN_CHANNEL: Record<string, string> = { "R-japan": "UC_japan", "T-tropico": "UC_tropico" };

function planDeps(active: string | null) {
  const core = {
    async assertPlanOfChannel(planId: string, channelId: string | null) {
      if (!channelId || PLAN_CHANNEL[planId] !== channelId) throw new DomainError({ code: "plan_not_found", message: `Plan ${planId} not found` });
    },
  } as unknown as GenerationPlanServices;
  const deps: PlanRouteDeps = { getSession: async () => ({ user: { id: "u1" } }), core, activeChannelId: async () => active };
  return deps;
}

test("AC-SM-03: a plan route runs for the active channel's plan, and answers another channel's plan -- or any plan with no active channel -- 404 without running", async () => {
  let ran = 0;
  const call = (active: string | null, planId: string) =>
    planHandler(planDeps(active), async () => (ran++, { ok: true }))(new Request(`http://127.0.0.1/api/generation-plans/${planId}/verdict`, { method: "POST", body: JSON.stringify({ planId: "R-japan" }) }), { params: Promise.resolve({ planId }) });
  assert.equal((await call("UC_japan", "R-japan")).status, 200);
  assert.equal(ran, 1);
  const foreign = await call("UC_japan", "T-tropico");
  assert.equal(foreign.status, 404);
  assert.equal(((await foreign.json()) as { error: string }).error, "plan_not_found");
  assert.equal((await call(null, "R-japan")).status, 404);
  assert.equal(ran, 1, "the route body never ran for a plan of another channel");
});

test("AC-SM-03: the peers list carries only the active channel's plans, the verdicts sent on them and the claims on them", async () => {
  const plan = (planId: string, channelId: string) => ({ planId, channelId }) as never;
  const verdict = (planId: string) => ({ verdictId: `v-${planId}`, planId, ownerDeviceId: "win", itemKey: "A/1", attemptRef: "job:1", result: "accepted", rating: 8, reasons: [], markers: [], note: "private note", at: "2026-10-08T10:00:00Z" });
  const claim = (planId: string) => ({ ownerDeviceId: "win", planId, scope: "attempt", itemKey: "A/1", attemptRef: "job:1", groupId: null, device: "win-pc", since: "", until: "" });
  const handler = (active: string | null) =>
    createPeersGetHandler({
      getSession: async () => ({ user: { id: "u1" } }),
      core: {
        peerPlans: async () => [{ deviceId: "win", hostname: "win-pc", updatedAt: "", stale: false, plans: [plan("R-japan", "UC_japan"), plan("T-tropico", "UC_tropico")] }],
        outgoingVerdicts: async () => [verdict("R-japan"), verdict("T-tropico")] as never,
        peerClaims: async () => [claim("R-japan"), claim("T-tropico")] as never,
      },
      activeChannelId: async () => active,
    });
  const body = (await (await handler("UC_japan")()).json()) as { devices: Array<{ plans: Array<{ planId: string }> }>; outgoing: Array<{ planId: string }>; claims: Array<{ planId: string }> };
  assert.deepEqual(body.devices[0].plans.map((p) => p.planId), ["R-japan"]);
  assert.deepEqual(body.outgoing.map((v) => v.planId), ["R-japan"], "a verdict on a Tropico plan is not shown while Japan is active");
  assert.deepEqual(body.claims.map((c) => c.planId), ["R-japan"]);
  const none = (await (await handler(null)()).json()) as { devices: Array<{ plans: unknown[] }>; outgoing: unknown[]; claims: unknown[] };
  assert.deepEqual([none.devices[0].plans, none.outgoing, none.claims], [[], [], []]);
});
