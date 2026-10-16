import { createVideoProjectsRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 1 (ADR 0040): this computer lost a duplicate number and takes the next free one (the owner's choice in a dialog).
export const POST = createVideoProjectsRouteHandlers().renumber;
