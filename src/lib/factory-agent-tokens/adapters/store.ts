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

/** `onChanged` defaults to publishing the change to the other devices; injectable for tests. */
export function createFactoryTokenStore(onChanged: () => void = shareAgentTokenChangeSoon): FactoryTokenStore {
  return {
    async replace(input) {
      await replaceFactoryAgentToken(input);
      onChanged();
    },
    async revoke() {
      const revoked = await revokeFactoryAgentTokens();
      if (revoked > 0) onChanged();
      return revoked;
    },
    findActiveByHash: (tokenHash) => findActiveFactoryAgentTokenByHash(tokenHash),
    findByHash: (tokenHash) => findFactoryAgentTokenByHash(tokenHash),
    listActive: () => listActiveFactoryAgentTokens(),
  };
}
