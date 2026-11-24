import { createImageReviewRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-272: the active channel's master still images for review and how many wait for the owner (Медиа → «Кадры»).
export const GET = createImageReviewRouteHandlers().list;
