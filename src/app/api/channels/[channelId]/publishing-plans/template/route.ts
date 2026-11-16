import { createPublishingPlanRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-267 (ADR 0073 §1): the week template -- read, and the owner's edit (a new version approved at once).
const handlers = createPublishingPlanRouteHandlers();
export const GET = handlers.templateGet;
export const POST = handlers.templateSave;
