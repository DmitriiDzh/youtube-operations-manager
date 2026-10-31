import { createLocalVideoCleanupHandlers } from "./handlers";

// BL-238 (ADR 0058): the channel's local video cleanup on this computer.
const handlers = createLocalVideoCleanupHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
