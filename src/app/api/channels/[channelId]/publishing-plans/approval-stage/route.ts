import { createPublishingPlanRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-242 (ADR 0062 §1): the owner's approval stage of the active channel's weekly plans (packaged | slot).
export const POST = createPublishingPlanRouteHandlers().setApprovalStage;
