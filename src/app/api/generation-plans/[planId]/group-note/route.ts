import { defaultPlanRouteDeps, planHandler } from "../../shared";

/** BL-143: the owner's note on a whole wave: { groupId, note }. */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) => core.setGroupNote({ ...body, planId }, "owner"));
