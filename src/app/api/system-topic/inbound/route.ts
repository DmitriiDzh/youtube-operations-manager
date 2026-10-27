import { createSystemTopicHandlers, defaultSystemTopicRouteDeps } from "../shared";

// BL-228 (FO-RESP-0043 H1): the hub relays one System topic message. Loopback + `Authorization: Bearer <relay secret>`.
export const POST = createSystemTopicHandlers(defaultSystemTopicRouteDeps).POST_INBOUND;
