import { createChannelLocalizationsHandlers, defaultChannelLocalizationsRouteDeps } from "../shared";

// BL-210 (ADR 0047): the owner's «Применить» -- the only path to a channel's translations on YouTube (AC-CL-10).
const handlers = createChannelLocalizationsHandlers(defaultChannelLocalizationsRouteDeps());
export const POST = handlers.APPLY;
