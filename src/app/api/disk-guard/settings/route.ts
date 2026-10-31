import { createDiskGuardHandlers, defaultDiskGuardRouteDeps } from "../shared";

// BL-237: the free-space threshold of this computer (GB). Local only.
const handlers = createDiskGuardHandlers(defaultDiskGuardRouteDeps());
export const PUT = handlers.PUT_SETTINGS;
