import { createRestartHandlers, defaultRestartRouteDeps } from "../../shared";

// BL-220: the owner ends a hold («Снять»). Local only.
const handlers = createRestartHandlers(defaultRestartRouteDeps());
export const DELETE = handlers.DELETE_HOLD;
