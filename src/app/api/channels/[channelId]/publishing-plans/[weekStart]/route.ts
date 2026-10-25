import { createPublishingPlanRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-225: one weekly publishing plan with every slot.
export const GET = createPublishingPlanRouteHandlers().detail;
