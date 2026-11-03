import { createClipReviewRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-241: the clip's video from this computer's copy of the channel folder, with HTTP Range.
export const GET = createClipReviewRouteHandlers().video;
