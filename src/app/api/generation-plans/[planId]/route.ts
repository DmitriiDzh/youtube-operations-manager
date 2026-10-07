import { defaultPlanRouteDeps, planHandler } from "../shared";

/** BL-143: one plan with its derived progress and events (`?since=<ISO>`). */
export const GET = planHandler(defaultPlanRouteDeps(), ({ core, planId, request }) => {
  const since = new URL(request.url).searchParams.get("since");
  return core.getPlan({ planId, ...(since ? { since } : {}) });
});
