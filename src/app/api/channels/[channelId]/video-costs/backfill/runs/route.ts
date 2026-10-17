import { createVideoCostsRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 4 (ADR 0041): links this computer's runs of a storyboard or plan to the video it already has (the owner's click).
export const POST = createVideoCostsRouteHandlers().linkRuns;
