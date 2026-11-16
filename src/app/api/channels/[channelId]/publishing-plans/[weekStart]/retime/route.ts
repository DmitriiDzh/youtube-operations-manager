import { createPublishingPlanRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-256 (owner msgs 4380/4383): the owner moves a slot's day and/or time (optionally approving the new time).
export const POST = createPublishingPlanRouteHandlers().retime;
