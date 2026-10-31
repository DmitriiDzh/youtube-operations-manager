import { createDiskGuardHandlers, defaultDiskGuardRouteDeps } from "../shared";

// BL-237: the header bell's low-disk notice (this computer's stored alert; no disk read).
const handlers = createDiskGuardHandlers(defaultDiskGuardRouteDeps());
export const GET = handlers.GET_NOTICE;
