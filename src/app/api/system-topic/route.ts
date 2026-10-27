import { createSystemTopicHandlers, defaultSystemTopicRouteDeps } from "./shared";

// BL-228: Settings → «System (Telegram)» -- the view (GET) and the owner's settings (PUT). Web session only.
const handlers = createSystemTopicHandlers(defaultSystemTopicRouteDeps);
export const GET = handlers.GET;
export const PUT = handlers.PUT;
