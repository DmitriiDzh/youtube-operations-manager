import { createSystemTopicHandlers, defaultSystemTopicRouteDeps } from "../shared";

// BL-228 (FO-RESP-0043 H1): the hub takes the queued messages (each once) and posts them. Loopback + the relay secret.
export const GET = createSystemTopicHandlers(defaultSystemTopicRouteDeps).GET_OUTBOX;
export const dynamic = "force-dynamic";
