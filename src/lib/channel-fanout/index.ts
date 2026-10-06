import { listStoredChannels } from "@/lib/db";
import type { ChannelConnection } from "./policy";

export {
  BACKGROUND_FAILURE_BACKOFF_HOURS,
  createBackgroundFailureBackoff,
  credentialUserIdFor,
  errorCodeOf,
  type BackgroundFailureBackoff,
  type ChannelConnection,
} from "./policy";

/** Every stored channel and the Google user whose token belongs to it (`channels.connected_user_id`). */
export async function listChannelConnections(): Promise<ChannelConnection[]> {
  return (await listStoredChannels()).map((channel) => ({ channelId: channel.channelId, connectedUserId: channel.connectedUserId }));
}
