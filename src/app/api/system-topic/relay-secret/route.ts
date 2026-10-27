import { createSystemTopicHandlers, defaultSystemTopicRouteDeps } from "../shared";

// BL-228: a new relay secret for the hub, shown once (only its SHA-256 is stored). Web session only.
export const POST = createSystemTopicHandlers(defaultSystemTopicRouteDeps).POST_RELAY_SECRET;
