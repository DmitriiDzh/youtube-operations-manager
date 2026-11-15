import { createPackageReviewRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-257 (ADR 0070): the package's own video from this computer's copy, with HTTP Range.
export const GET = createPackageReviewRouteHandlers().video;
