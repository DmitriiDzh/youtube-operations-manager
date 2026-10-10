import { defaultPlanRouteDeps, planHandler } from "../../shared";

/**
 * BL-173 (PLAN_RECHECKS_PLAN.md §2.3): the owner's answer to an open re-check of this device's plan:
 * { recheckId, result, rating?, reasons?, markers?, note? } or { recheckId, kept: true, note? }.
 */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) => core.answerRecheck({ ...body, planId }));
