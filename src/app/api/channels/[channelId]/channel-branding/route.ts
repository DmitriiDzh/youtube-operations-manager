import { createChannelBrandingHandlers, defaultChannelBrandingRouteDeps } from "./shared";

// BL-223: the channel's branding draft -- GET (the draft, the last apply and the channel on YouTube: 1 unit) and PUT (replace the
// draft, local only).
const handlers = createChannelBrandingHandlers(defaultChannelBrandingRouteDeps());
export const GET = handlers.GET;
export const PUT = handlers.PUT;
