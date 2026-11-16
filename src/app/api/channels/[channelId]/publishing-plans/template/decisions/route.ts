import { createPublishingPlanRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-267: the owner accepts or rejects a template version (a proposal of the Producer).
export const POST = createPublishingPlanRouteHandlers().templateDecide;
