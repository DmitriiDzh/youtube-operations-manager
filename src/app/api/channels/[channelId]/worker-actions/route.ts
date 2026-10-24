import { createWorkerActionsGetHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-215 (ADR 0048): one channel's worker log on this computer, for Settings → Channels.
export const GET = createWorkerActionsGetHandler();
