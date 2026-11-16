import { createPublishingPlanRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-267 (ADR 0073 §5): the owner moves a slot anywhere; a dated video moves on YouTube at once.
export const POST = createPublishingPlanRouteHandlers().move;
