import {
  findActiveProducerAgentTokenByHash,
  findProducerAgentTokenByHash,
  listActiveProducerAgentTokens,
  replaceProducerAgentToken,
  revokeProducerAgentTokens,
} from "@/lib/db";
import type { RoleTokenStore } from "@/lib/role-agent-tokens";

export function createProducerTokenStore(): RoleTokenStore {
  return {
    replace: (input) => replaceProducerAgentToken(input),
    revoke: () => revokeProducerAgentTokens(),
    findActiveByHash: (tokenHash) => findActiveProducerAgentTokenByHash(tokenHash),
    findByHash: (tokenHash) => findProducerAgentTokenByHash(tokenHash),
    listActive: () => listActiveProducerAgentTokens(),
  };
}
