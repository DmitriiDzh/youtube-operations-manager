import { createImageReviewRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-272: the image's large grid thumbnail (a JPEG made here; the original when none can be made).
export const GET = createImageReviewRouteHandlers().preview;
