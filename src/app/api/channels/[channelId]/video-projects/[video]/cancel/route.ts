import { createVideoProjectsRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 1 (ADR 0040): gives up a video reserved on this computer (its number is never given again).
export const POST = createVideoProjectsRouteHandlers().cancel;
