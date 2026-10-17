import { createVideoCostsRouteHandlers } from "../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 4 (ADR 0041): the owner confirms a storyboard's video (a proposal, or picked by hand); its runs here follow.
export const POST = createVideoCostsRouteHandlers().confirmStoryboard;
