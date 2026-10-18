/**
 * BL-197 (owner, Telegram 2026-10-18, msg 2988): a channel's stored copy (the `channels` row and its videos) younger than this is used
 * as it is by the automatic syncs -- the dashboard's own channel on every load (`POST /api/channels/sync` with `onlyIfStale`) and the
 * other connected channels (`/api/publishing/refresh-stale`). A sync the operator asks for always runs.
 */
export const CHANNEL_COPY_FRESH_MS = 6 * 3_600_000;

/**
 * Whether the automatic "my channel" sync may skip: the session's active channel has a stored copy owned by this same identity
 * (`connected_user_id`, set only by a "mine" sync) and synced at most `CHANNEL_COPY_FRESH_MS` ago. No row, a row owned by nobody or
 * by another identity (a just-connected channel), or no sync time yet -- the sync runs.
 */
export function isOwnedChannelCopyFresh(args: {
  channel: { connectedUserId: string | null; lastSyncedAt: Date | null } | null;
  userId: string;
  now: Date;
}): boolean {
  const { channel } = args;
  if (!channel || channel.connectedUserId !== args.userId || !channel.lastSyncedAt) return false;
  const age = args.now.getTime() - channel.lastSyncedAt.getTime();
  // Exactly 6 h is still fresh, as `refresh-stale` has always counted it (its acceptance test).
  return age >= 0 && age <= CHANNEL_COPY_FRESH_MS;
}
