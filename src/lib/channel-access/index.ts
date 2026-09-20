import { getSelectedChannelId, setSelectedChannelId } from "@/lib/db";
import { createChannelAccessService } from "./service";

export function createChannelAccessCore() {
  return createChannelAccessService({ getSelectedChannelId, setSelectedChannelId });
}

export type ChannelAccessCore = ReturnType<typeof createChannelAccessCore>;
export { createChannelAccessService } from "./service";
export type { ChannelAccessService } from "./service";
