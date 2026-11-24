import { createPackageReviewRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-03/04): the owner's draft of timed comments on one package (kept on this computer until
// he sends them with his decision).
const handlers = createPackageReviewRouteHandlers();
export const GET = handlers.draft;
export const PUT = handlers.saveDraft;
