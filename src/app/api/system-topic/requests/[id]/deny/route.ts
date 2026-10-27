import { createSystemTopicHandlers, defaultSystemTopicRouteDeps } from "../../../shared";

// BL-228: the owner's Deny of a request not yet confirmed. Web session only.
export const POST = createSystemTopicHandlers(defaultSystemTopicRouteDeps).POST_DENY;
