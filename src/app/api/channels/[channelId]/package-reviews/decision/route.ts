import { createPackageReviewRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-257 (ADR 0070): the owner's decision on one package (approve, or return with a comment).
export const POST = createPackageReviewRouteHandlers().decide;
