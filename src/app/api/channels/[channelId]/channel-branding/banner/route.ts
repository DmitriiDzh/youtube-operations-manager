import { createChannelBrandingHandlers, defaultChannelBrandingRouteDeps } from "../shared";

// BL-223: the draft's banner image as stored on this computer (local only).
const handlers = createChannelBrandingHandlers(defaultChannelBrandingRouteDeps());
export const GET = handlers.BANNER;
