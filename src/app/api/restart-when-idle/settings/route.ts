import { createRestartHandlers, defaultRestartRouteDeps } from "../shared";

// BL-220: «Тишина MCP перед перезапуском, мин» (1-30). Local only.
const handlers = createRestartHandlers(defaultRestartRouteDeps());
export const PUT = handlers.PUT_SETTINGS;
