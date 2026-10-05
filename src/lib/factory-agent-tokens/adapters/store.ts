import {
  findActiveFactoryAgentTokenByHash,
  findFactoryAgentTokenByHash,
  listActiveFactoryAgentTokens,
  replaceFactoryAgentToken,
  revokeFactoryAgentTokens,
} from "@/lib/db";
import type { FactoryTokenStore } from "../services";

export function createFactoryTokenStore(): FactoryTokenStore {
  return {
    replace: (input) => replaceFactoryAgentToken(input),
    revoke: () => revokeFactoryAgentTokens(),
    findActiveByHash: (tokenHash) => findActiveFactoryAgentTokenByHash(tokenHash),
    findByHash: (tokenHash) => findFactoryAgentTokenByHash(tokenHash),
    listActive: () => listActiveFactoryAgentTokens(),
  };
}
