import { createImageReviewRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-272: the owner's answer on one image -- approve, approve with a note, or return with a comment.
export const POST = createImageReviewRouteHandlers().decide;
