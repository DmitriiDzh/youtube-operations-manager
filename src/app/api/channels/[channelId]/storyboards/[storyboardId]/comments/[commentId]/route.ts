import { createStoryboardRouteHandlers } from "../../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184: POST a reply in the comment's thread; PATCH its state (open / resolved).
const handlers = createStoryboardRouteHandlers();
export const POST = handlers.reply;
export const PATCH = handlers.setState;
