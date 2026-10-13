import { createStoryboardRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184: the owner's comment on the latest version (the storyboard, a keyframe with a pin, a segment or a prop cell).
export const POST = createStoryboardRouteHandlers().comment;
