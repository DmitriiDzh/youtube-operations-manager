import { createSystemTopicHandlers, defaultSystemTopicRouteDeps } from "../../../shared";

// BL-228: the owner's Confirm of a request approved in the topic -- the only way a paid call through System runs. Web session only.
export const POST = createSystemTopicHandlers(defaultSystemTopicRouteDeps).POST_CONFIRM;
