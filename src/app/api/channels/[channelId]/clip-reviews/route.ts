import { createClipReviewRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-241: the active channel's clips for review and how many wait for the owner (Контент → «Клипы»).
export const GET = createClipReviewRouteHandlers().list;
