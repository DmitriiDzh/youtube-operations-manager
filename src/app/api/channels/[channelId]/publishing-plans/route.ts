import { createPublishingPlanRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-225: the active channel's weekly publishing plans and how many slots wait for the owner (Контент → «План недели»).
export const GET = createPublishingPlanRouteHandlers().list;
