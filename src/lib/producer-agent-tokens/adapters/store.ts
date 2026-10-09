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

/** `onChanged` defaults to publishing the change to the other devices; injectable for tests. */
export function createProducerTokenStore(onChanged: () => void = shareAgentTokenChangeSoon): RoleTokenStore {
  return {
    async replace(input) {
      await replaceProducerAgentToken(input);
      onChanged();
    },
    async revoke() {
      const revoked = await revokeProducerAgentTokens();
      if (revoked > 0) onChanged();
      return revoked;
    },
    findActiveByHash: (tokenHash) => findActiveProducerAgentTokenByHash(tokenHash),
    findByHash: (tokenHash) => findProducerAgentTokenByHash(tokenHash),
    listActive: () => listActiveProducerAgentTokens(),
  };
}
