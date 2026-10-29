import { createVoicesRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-236 (ADR 0057): rename or archive one of the channel's voices.
export const PATCH = createVoicesRouteHandlers().update;
