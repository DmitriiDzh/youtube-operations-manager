import { createStoryboardRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184 stage 3 (B5): the owner's take for a segment of a version.
export const POST = createStoryboardRouteHandlers().pick;
