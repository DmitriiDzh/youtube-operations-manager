import { defaultPlanRouteDeps, planHandler } from "../shared";

/** BL-143: one plan with its derived progress and events (`?since=<ISO>`). */
export const GET = planHandler(defaultPlanRouteDeps(), ({ core, planId, request }) => {
  const since = new URL(request.url).searchParams.get("since");
  // BL-157 (AC-TC-03): the owner's view -- a verdict on its way from another device no longer waits here either.
  return core.getPlan({ planId, ...(since ? { since } : {}) }, { ownerView: true });
});
