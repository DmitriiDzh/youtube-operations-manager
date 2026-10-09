import { createRoleTokenServices, hashRoleToken, type RoleTokenStore, type StoredRoleTokenRow } from "@/lib/role-agent-tokens";
import { FACTORY_AGENT_TOKEN_PREFIX } from "./contracts";

// The token logic is shared with the Producer role (`src/lib/role-agent-tokens`, BL-161); this module keeps the Factory
// Operator's own prefix, name, table and public API unchanged.

export type StoredFactoryTokenRow = StoredRoleTokenRow;
export type FactoryTokenStore = RoleTokenStore;

export type ServiceDependencies = {
  store: FactoryTokenStore;
  /** Injectable for tests; defaults to 32 random bytes. */
  generateSecret?: () => string;
};

/** SHA-256 hex of the full token string. Exported so tests can state expected hashes independently. */
export function hashFactoryToken(token: string): string {
  return hashRoleToken(token);
}

export function createFactoryTokenServices(deps: ServiceDependencies) {
  return createRoleTokenServices({
    kind: { prefix: FACTORY_AGENT_TOKEN_PREFIX, name: "Factory Operator" },
    store: deps.store,
    generateSecret: deps.generateSecret,
  });
}

export type FactoryTokenServices = ReturnType<typeof createFactoryTokenServices>;
