import { defaultPlanRouteDeps, planHandler } from "../../shared";

/**
 * BL-175 (FO-REQ-0018 §B, VISUAL_REVIEW_PLAN.md §2.2): the owner picks an attempt of an item, withdraws a pick, or says none of
 * its attempts fits: { itemKey, attemptRef?, action: pick | unpick | none_fits | clear_none_fits, note? }.
 */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) => core.recordOwnerPick({ ...body, planId }));
