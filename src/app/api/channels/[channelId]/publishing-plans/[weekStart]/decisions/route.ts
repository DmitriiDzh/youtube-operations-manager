import { createPublishingPlanRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-225: the owner's decisions on a plan's slots (approve one or the week, revoke, veto, restore).
export const POST = createPublishingPlanRouteHandlers().decide;
