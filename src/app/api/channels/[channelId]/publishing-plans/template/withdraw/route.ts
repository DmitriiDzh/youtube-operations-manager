import { createPublishingPlanRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-267: «Даты по шаблону» off -- nothing is dated by the template until the owner approves one again.
export const POST = createPublishingPlanRouteHandlers().templateWithdraw;
