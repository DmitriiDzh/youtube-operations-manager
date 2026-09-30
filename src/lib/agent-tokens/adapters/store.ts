import {
  findActiveAgentChannelTokenByHash,
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
    listActive: () => listActiveAgentChannelTokens(),
  };
}
