import { createChannelLocalizationsHandlers, defaultChannelLocalizationsRouteDeps } from "../shared";

// BL-210: what «Применить» would do now -- reads the channel on YouTube (1 unit), writes nothing.
const handlers = createChannelLocalizationsHandlers(defaultChannelLocalizationsRouteDeps());
export const GET = handlers.PREVIEW;
