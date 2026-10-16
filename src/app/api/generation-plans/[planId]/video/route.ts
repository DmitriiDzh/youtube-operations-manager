import { defaultPlanRouteDeps, planHandler } from "../../shared";

/**
 * BL-194 (ADR 0040): the owner links a plan of the active channel to a video of that channel ({ videoNumber: "V49" }) or to none
 * (null). Recorded as a `plan_updated` event by the owner; checked by the video-projects module; nothing else of the plan changes.
 */
export const POST = planHandler(defaultPlanRouteDeps(), ({ core, planId, body }) => core.updatePlan({ planId, videoNumber: body.videoNumber ?? null }, "owner"));
