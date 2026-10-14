import { createStoryboardRouteHandlers } from "../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-189 (FO-REQ-0025 B): this computer's copy of an attached final file -- ok, missing or differs.
export const GET = createStoryboardRouteHandlers().renderStatus;
