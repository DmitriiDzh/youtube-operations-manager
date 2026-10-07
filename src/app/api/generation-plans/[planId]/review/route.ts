import { defaultPlanRouteDeps, planHandler } from "../../shared";

/** BL-143: the attempts the owner reviews, waiting first, with the earlier stages' rows and the verdicts given. */
export const GET = planHandler(defaultPlanRouteDeps(), ({ core, planId }) => core.reviewQueue({ planId }));
