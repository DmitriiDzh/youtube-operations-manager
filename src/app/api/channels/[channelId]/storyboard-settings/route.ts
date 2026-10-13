import { createStoryboardRouteHandlers } from "../storyboards/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184 stage 2 (FO-REQ-0024 B4, owner 1183): the channel's setting "a first/last-frame video from two different images needs an
// approved storyboard" -- synced between the computers with the storyboards; on unless the owner turns it off.
const handlers = createStoryboardRouteHandlers();
export const GET = handlers.gate;
export const PUT = handlers.setGate;
