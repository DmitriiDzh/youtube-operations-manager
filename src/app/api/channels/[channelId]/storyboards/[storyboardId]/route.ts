import { createStoryboardRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184: one storyboard (`?version=N`), with this computer's copy of the version's keyframes and its diff to the version before.
export const GET = createStoryboardRouteHandlers().detail;
