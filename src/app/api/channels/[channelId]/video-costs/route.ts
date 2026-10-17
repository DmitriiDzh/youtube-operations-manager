import { createVideoCostsRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 3 (ADR 0041): the visual cost of each video of the active channel (RunPod, Gemini, all), and «не привязано».
export const GET = createVideoCostsRouteHandlers().summary;
