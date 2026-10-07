import { defaultPlanRouteDeps, planHandler } from "../../shared";

/** BL-143 (AC-GP-13): the owner's verdict on one attempt: { itemKey, attemptRef, result, rating?, reasons?, markers?, note? }. */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) => core.recordOwnerVerdict({ ...body, planId }));
