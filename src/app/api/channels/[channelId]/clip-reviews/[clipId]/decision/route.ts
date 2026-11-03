import { createClipReviewRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-241: the owner's decision on a clip (approve, or return with a comment).
export const POST = createClipReviewRouteHandlers().decide;
