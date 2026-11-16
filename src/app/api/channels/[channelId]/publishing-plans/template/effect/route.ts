import { createPublishingPlanRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-267 (AC-WT-28): which slots a template would start or stop dating -- read-only, for the owner's apply dialog.
export const POST = createPublishingPlanRouteHandlers().templateEffect;
