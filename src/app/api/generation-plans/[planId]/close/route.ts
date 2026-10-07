import { defaultPlanRouteDeps, planHandler } from "../../shared";

/** BL-143: the owner closes a plan: { status: completed | cancelled, note? }. Only the status changes. */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) => core.closePlan({ ...body, planId }, "owner"));
