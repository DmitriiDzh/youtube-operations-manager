import { createVoicesRouteHandlers } from "../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-236 (ADR 0057): a preview's audio for the owner's player.
export const GET = createVoicesRouteHandlers().preview;
