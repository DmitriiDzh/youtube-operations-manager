import { createClipReviewRouteHandlers } from "../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-246 (ADR 0065): PUT the next piece of a staged attachment (at most 4 MiB: every /api body passes the proxy, which keeps only
// its first 40 MB); DELETE drops it.
const handlers = createClipReviewRouteHandlers();
export const PUT = handlers.attachmentPiece;
export const DELETE = handlers.discardAttachment;
