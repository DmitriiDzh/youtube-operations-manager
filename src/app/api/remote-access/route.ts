import { createRemoteAccessHandlers, defaultRemoteAccessRouteDeps } from "./shared";

// BL-251: access from the owner's other devices over Tailscale -- status (GET) and the Mac-only settings (PUT).
const handlers = createRemoteAccessHandlers(defaultRemoteAccessRouteDeps());
export const GET = handlers.GET;
export const PUT = handlers.PUT;
