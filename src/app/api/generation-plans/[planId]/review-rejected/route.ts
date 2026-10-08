import { defaultPlanRouteDeps, planHandler } from "../../shared";

/**
 * BL-153 (FO-REQ-0008): the owner switches whether validator-rejected tracks that can be played also wait for review:
 * { reviewRejected: boolean }. Recorded as a `plan_updated` event by the owner; nothing else of the plan changes.
 */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) =>
  core.updatePlan({ planId, reviewRejected: body.reviewRejected }, "owner")
);
