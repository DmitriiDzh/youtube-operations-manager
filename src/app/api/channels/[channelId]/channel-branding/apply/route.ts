import { createChannelBrandingHandlers, defaultChannelBrandingRouteDeps } from "../shared";

// BL-223 (ADR 0050): the owner's «Применить» -- the only path to a channel's branding on YouTube (AC-CB-09).
const handlers = createChannelBrandingHandlers(defaultChannelBrandingRouteDeps());
export const POST = handlers.APPLY;
