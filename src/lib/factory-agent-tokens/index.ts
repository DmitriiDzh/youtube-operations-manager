import { createFactoryTokenStore } from "./adapters/store";
import { createFactoryTokenServices } from "./services";

/** Factory Operator access, slice F2 -- see `./contracts.ts`. */
export function createFactoryTokenCore() {
  return createFactoryTokenServices({ store: createFactoryTokenStore() });
}

export type FactoryTokenCore = ReturnType<typeof createFactoryTokenCore>;
export type { FactoryTokenBinding, FactoryTokenSummary, IssuedFactoryToken } from "./contracts";
export { FACTORY_AGENT_TOKEN_PREFIX } from "./contracts";
export { hashFactoryToken } from "./services";
