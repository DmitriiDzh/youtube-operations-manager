import { createVoicesRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-236 (ADR 0057): the active channel's designed voices (`?archived=1` includes the archived ones).
export const GET = createVoicesRouteHandlers().list;
