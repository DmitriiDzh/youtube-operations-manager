import { YOUTUBE_READ_SCOPE } from "@/lib/auth";
import { getStoredChannel } from "@/lib/db";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createWriteContextCore } from "@/lib/write-context";
import { createAgentTokenStore } from "./adapters/store";
import { createAgentTokenServices } from "./services";

/**
 * Phase 12 slice 12.1. The live ownership check reuses `write-context`'s own `channels.list mine`
 * adapter (the same identity check every YouTube write already relies on, `AGENTS.md` §G) rather
 * than a second read path.
 */
export function createAgentTokenCore() {
  const writeContext = createWriteContextCore();
  return createAgentTokenServices({
    store: createAgentTokenStore(),
    getChannelConnectedUserId: async (channelId) => (await getStoredChannel(channelId))?.connectedUserId ?? null,
    getLiveChannelIdForUser: async (userId) => {
      const credentials = await resolveGoogleCredentials({ credentialRef: { userId }, requiredScopes: [YOUTUBE_READ_SCOPE] });
      return (await writeContext.getActiveWriteChannel({ credentials }))?.id ?? null;
    },
  });
}

export type AgentTokenCore = ReturnType<typeof createAgentTokenCore>;
export type { AgentTokenBinding, AgentTokenSummary, IssuedAgentToken } from "./contracts";
export { AGENT_TOKEN_PREFIX } from "./contracts";
export { hashAgentToken } from "./services";
