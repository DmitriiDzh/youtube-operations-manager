import assert from "node:assert/strict";
import test from "node:test";
import { createSystemApprovalActions, type SystemApprovalServices } from "./system-topic-approvals";

// BL-228 (SYSTEM_TOPIC_PLAN.md §5 as amended; FO-RESP-0043 Q5; AC-SYS-11): the two allowlisted actions on injected services (no
// media or Gemini call). factory_media_start_session: the tool's own schema plus maxMinutes, maxUsd and releaseWhenDone: true;
// estimate = the saved GPU rate × maxMinutes / 60 (worked out by hand), refused over $2 (estimate or maxUsd) or over the factory
// limits. factory_gemini_create_job: the Gemini module's schema, its dry-run estimate and limits, refused over $1.

const CHANNEL = "UCa2amtpeOmgP-HkiLKPm1gg";
const okSettings = (overrides: Partial<{ price: number | null; enabled: boolean; today: number; month: number }> = {}) => ({
  factorySessionsEnabled: overrides.enabled ?? true,
  limits: { maxUsdPerSession: 5, maxMinutesPerSession: 120, maxUsdPerDay: 10, maxUsdPerMonth: 50 },
  spentOrReservedUsd: { today: overrides.today ?? 0, thisMonth: overrides.month ?? 0 },
  gpu: { onDemandPricePerHr: overrides.price === undefined ? 1.2 : overrides.price },
});

function services(overrides: Partial<SystemApprovalServices> = {}) {
  const calls: unknown[] = [];
  const base: SystemApprovalServices = {
    mediaSettings: async () => okSettings(),
    startSession: async (args) => (calls.push(["start", args]), { session: { sessionId: "s1" }, approved: true, heldBy: null }),
    geminiCreateJob: async (args, actor) => (calls.push(["gemini", args, actor]), args.dryRun ? { dryRun: true, estimateUsd: 0.39, allowed: true, refusal: null } : { job: { jobId: "g1" } }),
    ...overrides,
  };
  return { actions: createSystemApprovalActions(base), calls };
}
const media = (extra: Record<string, unknown> = {}) => ({ channelId: CHANNEL, maxMinutes: 60, maxUsd: 2, releaseWhenDone: true, ...extra });

test("media: maxMinutes, maxUsd and releaseWhenDone: true are required; maxUsd over $2 and unknown fields are refused", () => {
  const { actions } = services();
  const start = actions.factory_media_start_session;
  assert.deepEqual(start.parse(media()), { ok: true, args: media() });
  const error = (args: Record<string, unknown>) => {
    const r = start.parse(args);
    return r.ok ? null : r.error;
  };
  assert.equal(error({ channelId: CHANNEL, maxUsd: 2, releaseWhenDone: true }), "maxMinutes is required");
  assert.equal(error({ channelId: CHANNEL, maxMinutes: 60, releaseWhenDone: true }), "maxUsd is required");
  assert.equal(error(media({ releaseWhenDone: false })), "releaseWhenDone must be true");
  assert.equal(error({ channelId: CHANNEL, maxMinutes: 60, maxUsd: 2 }), "releaseWhenDone must be true");
  assert.equal(error(media({ maxUsd: 2.01 })), "maxUsd $2.01 is over the $2 cap");
  assert.match(error(media({ maxHours: 1 })) ?? "", /maxHours|Unrecognized/i);
});

test("AC-SYS-11 (media): $2.00/h × 60 min = $2.00 is within the $2 cap; $2.01/h × 60 min = $2.01 is over it", async () => {
  const at = services({ mediaSettings: async () => okSettings({ price: 2 }) }).actions.factory_media_start_session;
  assert.deepEqual(await at.check(media()), { estimateUsd: 2, refusal: null });
  assert.equal(at.capUsd, 2);
  const over = services({ mediaSettings: async () => okSettings({ price: 2.01 }) }).actions.factory_media_start_session;
  const checked = await over.check(media());
  assert.equal(checked.estimateUsd, 2.01);
  assert.ok(checked.estimateUsd! > over.capUsd);
  // $1.20/h × 30 min = $0.60.
  assert.deepEqual(await services().actions.factory_media_start_session.check(media({ maxMinutes: 30 })), { estimateUsd: 0.6, refusal: null });
});

test("media: the factory switch and limits stay the ceiling; an unknown GPU price is refused", async () => {
  const check = (s: ReturnType<typeof okSettings>, args = media()) => services({ mediaSettings: async () => s }).actions.factory_media_start_session.check(args);
  assert.match((await check(okSettings({ enabled: false }))).refusal ?? "", /switched off/);
  assert.match((await check(okSettings(), media({ maxMinutes: 121 }))).refusal ?? "", /121 min is over the factory's 120 min/);
  assert.match((await check(okSettings({ today: 8.5 }))).refusal ?? "", /day would reach \$10\.5 \(limit \$10\)/);
  assert.equal((await check(okSettings({ today: 8 }))).refusal, null, "$8 + $2 = $10 is at the day limit, not over it");
  assert.match((await check(okSettings({ month: 48.01 }))).refusal ?? "", /month would reach \$50\.01 \(limit \$50\)/);
  assert.match((await check(okSettings({ price: null }))).refusal ?? "", /price is unknown/);
});

test("media: run calls the factory start once; a start held for the owner is a failure, not done", async () => {
  const { actions, calls } = services();
  assert.deepEqual(await actions.factory_media_start_session.run(media(), "owner (System)"), { ok: true, result: { session: { sessionId: "s1" }, approved: true, heldBy: null } });
  assert.deepEqual(calls, [["start", media()]]);
  const held = services({ startSession: async () => ({ approved: false, heldBy: "the device's daily limit" }) }).actions.factory_media_start_session;
  assert.deepEqual(await held.run(media(), "owner (System)"), { ok: false, error: "held for the owner in Servers: the device's daily limit" });
});

const gemini = { channelId: CHANNEL, kind: "image", model: "gemini-nano-banana-2.1", prompt: "a rainy street", image: { size: "1K", aspectRatio: "16:9" } };

test("gemini: the module's schema; dryRun cannot be approved; the estimate is the module's dry-run; the actor is passed on", async () => {
  const { actions, calls } = services();
  const create = actions.factory_gemini_create_job;
  assert.equal(create.capUsd, 1);
  assert.equal(create.parse(gemini).ok, true);
  assert.deepEqual(create.parse({ ...gemini, dryRun: true }), { ok: false, error: "dryRun cannot be approved" });
  assert.equal(create.parse({ ...gemini, kind: "audio" }).ok, false);
  assert.deepEqual(await create.check(gemini), { estimateUsd: 0.39, refusal: null });
  assert.deepEqual(await create.run(gemini, "owner (System)"), { ok: true, result: { job: { jobId: "g1" } } });
  assert.deepEqual(calls, [
    ["gemini", { ...gemini, dryRun: true }, "owner (System)"],
    ["gemini", gemini, "owner (System)"],
  ]);
});

test("gemini: a dry-run refusal (its own limits) refuses the request", async () => {
  const create = services({
    geminiCreateJob: async () => ({ dryRun: true, estimateUsd: 0.4, allowed: false, refusal: { code: "gemini_limit_exceeded", message: "over the per-day limit" } }),
  }).actions.factory_gemini_create_job;
  assert.deepEqual(await create.check(gemini), { estimateUsd: 0.4, refusal: "over the per-day limit" });
});

test("only the two actions are allowlisted", () => {
  assert.deepEqual(Object.keys(services().actions).sort(), ["factory_gemini_create_job", "factory_media_start_session"]);
});
