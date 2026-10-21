import { createChannelLocalizationsHandlers, defaultChannelLocalizationsRouteDeps } from "./shared";

// BL-210: the channel's stored translations -- GET (view) and PUT (replace the set). Local only, never a YouTube call.
const handlers = createChannelLocalizationsHandlers(defaultChannelLocalizationsRouteDeps());
export const GET = handlers.GET;
export const PUT = handlers.PUT;
