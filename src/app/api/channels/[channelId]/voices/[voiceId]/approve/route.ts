import { createVoicesRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-236 (ADR 0057): the owner approves one preview of a draft voice.
export const POST = createVoicesRouteHandlers().approve;
