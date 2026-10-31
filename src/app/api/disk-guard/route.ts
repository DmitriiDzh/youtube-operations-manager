import { createDiskGuardHandlers, defaultDiskGuardRouteDeps } from "./shared";

// BL-237: Servers → «Диск». Local reads only.
const handlers = createDiskGuardHandlers(defaultDiskGuardRouteDeps());
export const GET = handlers.GET;
