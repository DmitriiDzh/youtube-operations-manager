import { createProducerTokenStore } from "./adapters/store";
import { createProducerTokenServices } from "./services";

/** BL-161 -- the Producer role's token; see `./contracts.ts`. */
export function createProducerTokenCore() {
  return createProducerTokenServices({ store: createProducerTokenStore() });
}

export type ProducerTokenCore = ReturnType<typeof createProducerTokenCore>;
export type { ProducerTokenBinding, ProducerTokenSummary, IssuedProducerToken } from "./contracts";
export { PRODUCER_AGENT_TOKEN_PREFIX } from "./contracts";
