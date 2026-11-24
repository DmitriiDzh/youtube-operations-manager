import { createImageReviewRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-272: the image at full size from this computer's copy of the channel folder.
export const GET = createImageReviewRouteHandlers().image;
