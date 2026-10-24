import { createRestartHandlers, defaultRestartRouteDeps } from "./shared";

// BL-220: the restart-when-idle status (GET), the owner's request (POST) and its cancel (DELETE). Local only.
const handlers = createRestartHandlers(defaultRestartRouteDeps());
export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
