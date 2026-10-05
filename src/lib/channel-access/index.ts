import { getSelectedChannelId, setSelectedChannelId } from "@/lib/db";
import { createChannelAccessService } from "./services";

export function createChannelAccessCore() {
  return createChannelAccessService({ getSelectedChannelId, setSelectedChannelId });
}

export { assertAgentScopeChannel, assertAgentScopeVideo, readStringField } from "./agent-scope";
export type ChannelAccessCore = ReturnType<typeof createChannelAccessCore>;
export { createChannelAccessService } from "./services";
export type { ChannelAccessService } from "./services";
