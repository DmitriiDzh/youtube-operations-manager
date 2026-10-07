import { defaultPlanRouteDeps, planHandler } from "../../shared";

/** BL-143: the owner asks the factory to generate an item again: { itemKey, attemptRef?, note? }. Nothing is started here. */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) => core.requestRerun({ ...body, planId }));
