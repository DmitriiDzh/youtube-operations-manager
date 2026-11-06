import { createClipReviewRouteHandlers } from "../../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-246 (ADR 0065): one attachment of a decision on this clip, from this computer's copy of the channel folder (loopback only).
export const GET = createClipReviewRouteHandlers().attachment;
