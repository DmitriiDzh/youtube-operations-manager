import { createSystemTopicHandlers, defaultSystemTopicRouteDeps } from "../shared";

// BL-228: the System topic bot's token -- saved (PUT) or removed (DELETE) in this computer's device secrets; never sent back.
const handlers = createSystemTopicHandlers(defaultSystemTopicRouteDeps);
export const PUT = handlers.PUT_TOKEN;
export const DELETE = handlers.DELETE_TOKEN;
