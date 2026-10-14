import { createStoryboardRouteHandlers } from "../../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-189 (FO-REQ-0025 B): the attached final file, with HTTP Range.
export const GET = createStoryboardRouteHandlers().renderVideo;
