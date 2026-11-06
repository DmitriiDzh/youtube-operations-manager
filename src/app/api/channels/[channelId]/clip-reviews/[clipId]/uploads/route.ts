import { createClipReviewRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-246 (ADR 0065): the owner stages one file for his comment on this clip; its pieces follow on ./[uploadId].
export const POST = createClipReviewRouteHandlers().stageAttachment;
