import { createStoryboardRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184 stage 3 (B5): the storyboard's takes -- the video jobs that rendered its segments.
export const GET = createStoryboardRouteHandlers().takes;
