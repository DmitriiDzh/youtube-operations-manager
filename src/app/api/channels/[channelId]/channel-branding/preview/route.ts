import { createChannelBrandingHandlers, defaultChannelBrandingRouteDeps } from "../shared";

// BL-223: what «Применить» would do now -- reads the channel on YouTube (1 unit), writes nothing. GET (like BL-210): a read must not
// be refused by `src/proxy.ts`'s mutation gate (operation lock, recovery mode) the way a POST would be.
const handlers = createChannelBrandingHandlers(defaultChannelBrandingRouteDeps());
export const GET = handlers.PREVIEW;
