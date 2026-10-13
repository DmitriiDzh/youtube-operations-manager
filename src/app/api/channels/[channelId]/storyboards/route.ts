import { createStoryboardRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184: the active channel's storyboards (the «Раскадровка» list).
export const GET = createStoryboardRouteHandlers().list;
