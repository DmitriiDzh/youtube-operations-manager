import { createChannelBrandingHandlers, defaultChannelBrandingRouteDeps } from "../shared";

// BL-223: what «Применить» would do now -- reads the channel on YouTube (1 unit), writes nothing.
const handlers = createChannelBrandingHandlers(defaultChannelBrandingRouteDeps());
export const POST = handlers.PREVIEW;
