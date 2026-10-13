import { createStoryboardRouteHandlers } from "../../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184 stage 3 (B5): one take's video, with HTTP Range.
export const GET = createStoryboardRouteHandlers().takeVideo;
