import {
  findActiveAgentChannelTokenByHash,
  findAgentChannelTokenByHash,
  listActiveAgentChannelTokens,
  replaceAgentChannelToken,
  revokeAgentChannelTokens,
} from "@/lib/db";
import type { AgentTokenStore } from "../services";

export function createAgentTokenStore(): AgentTokenStore {
  return {
    replace: (input) => replaceAgentChannelToken(input),
    revokeForChannel: (channelId) => revokeAgentChannelTokens(channelId),
    findActiveByHash: (tokenHash) => findActiveAgentChannelTokenByHash(tokenHash),
    findByHash: (tokenHash) => findAgentChannelTokenByHash(tokenHash),
    listActive: () => listActiveAgentChannelTokens(),
  };
}
