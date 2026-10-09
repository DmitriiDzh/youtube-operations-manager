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

export function createAgentTokenStore(): AgentTokenStore {
  return {
    async replace(input) {
      await replaceAgentChannelToken(input);
      shareAgentTokenChangeSoon();
    },
    async revokeForChannel(channelId) {
      const revoked = await revokeAgentChannelTokens(channelId);
      if (revoked > 0) shareAgentTokenChangeSoon();
      return revoked;
    },
    findActiveByHash: (tokenHash) => findActiveAgentChannelTokenByHash(tokenHash),
    findByHash: (tokenHash) => findAgentChannelTokenByHash(tokenHash),
    listActive: () => listActiveAgentChannelTokens(),
  };
}
