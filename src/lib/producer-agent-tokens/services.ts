import { createRoleTokenServices, type RoleTokenStore } from "@/lib/role-agent-tokens";
import { PRODUCER_AGENT_TOKEN_PREFIX } from "./contracts";

export function createProducerTokenServices(deps: { store: RoleTokenStore; generateSecret?: () => string }) {
  return createRoleTokenServices({
    kind: { prefix: PRODUCER_AGENT_TOKEN_PREFIX, name: "Producer" },
    store: deps.store,
    generateSecret: deps.generateSecret,
  });
}

export type ProducerTokenServices = ReturnType<typeof createProducerTokenServices>;
