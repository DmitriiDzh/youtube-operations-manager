import { createPackageReviewRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-257 (ADR 0070): the package's default thumbnail.
export const GET = createPackageReviewRouteHandlers().thumbnail;
