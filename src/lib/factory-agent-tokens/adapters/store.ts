import {
  findActiveFactoryAgentTokenByHash,
  findFactoryAgentTokenByHash,
  listActiveFactoryAgentTokens,
  replaceFactoryAgentToken,
  revokeFactoryAgentTokens,
} from "@/lib/db";
import { shareAgentTokenChangeSoon } from "@/lib/agent-token-sync";
import type { FactoryTokenStore } from "../services";

// BL-160: a token issued, imported or revoked here is published to the other devices at once (best effort, never awaited).

export function createFactoryTokenStore(): FactoryTokenStore {
  return {
    async replace(input) {
      await replaceFactoryAgentToken(input);
      shareAgentTokenChangeSoon();
    },
    async revoke() {
      const revoked = await revokeFactoryAgentTokens();
      if (revoked > 0) shareAgentTokenChangeSoon();
      return revoked;
    },
    findActiveByHash: (tokenHash) => findActiveFactoryAgentTokenByHash(tokenHash),
    findByHash: (tokenHash) => findFactoryAgentTokenByHash(tokenHash),
    listActive: () => listActiveFactoryAgentTokens(),
  };
}
