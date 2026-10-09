import {
  findActiveProducerAgentTokenByHash,
  findProducerAgentTokenByHash,
  listActiveProducerAgentTokens,
  replaceProducerAgentToken,
  revokeProducerAgentTokens,
} from "@/lib/db";
import { shareAgentTokenChangeSoon } from "@/lib/agent-token-sync";
import type { RoleTokenStore } from "@/lib/role-agent-tokens";

// BL-160: a token issued, imported or revoked here is published to the other devices at once (best effort, never awaited).

export function createProducerTokenStore(): RoleTokenStore {
  return {
    async replace(input) {
      await replaceProducerAgentToken(input);
      shareAgentTokenChangeSoon();
    },
    async revoke() {
      const revoked = await revokeProducerAgentTokens();
      if (revoked > 0) shareAgentTokenChangeSoon();
      return revoked;
    },
    findActiveByHash: (tokenHash) => findActiveProducerAgentTokenByHash(tokenHash),
    findByHash: (tokenHash) => findProducerAgentTokenByHash(tokenHash),
    listActive: () => listActiveProducerAgentTokens(),
  };
}
