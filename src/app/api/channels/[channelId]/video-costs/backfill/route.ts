import { createVideoCostsRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 4 (ADR 0041): older runs of this computer -- proposed storyboard→video matches and runs not linked yet.
export const GET = createVideoCostsRouteHandlers().backfillProposals;
