import {
  findActiveAgentChannelTokenByHash,
  findAgentChannelTokenByHash,
  listActiveAgentChannelTokens,
  replaceAgentChannelToken,
  revokeAgentChannelTokens,
} from "@/lib/db";
import { shareAgentTokenChangeSoon } from "@/lib/agent-token-sync";
import type { AgentTokenStore } from "../services";

// BL-160: a token issued, imported or revoked here is published to the other devices at once (best effort, never awaited).

/** `onChanged` defaults to publishing the change to the other devices; injectable for tests. */
export function createAgentTokenStore(onChanged: () => void = shareAgentTokenChangeSoon): AgentTokenStore {
  return {
    async replace(input) {
      await replaceAgentChannelToken(input);
      onChanged();
    },
    async revokeForChannel(channelId) {
      const revoked = await revokeAgentChannelTokens(channelId);
      if (revoked > 0) onChanged();
      return revoked;
    },
    findActiveByHash: (tokenHash) => findActiveAgentChannelTokenByHash(tokenHash),
    findByHash: (tokenHash) => findAgentChannelTokenByHash(tokenHash),
    listActive: () => listActiveAgentChannelTokens(),
  };
}
