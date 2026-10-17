import { createStoryboardRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 (ADR 0040): the owner links the storyboard to a video of its channel (`{ videoNumber: "V49" }`) or to none (null).
export const PUT = createStoryboardRouteHandlers().setVideo;
