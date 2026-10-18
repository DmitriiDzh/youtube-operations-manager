import { createUserTtlMemo } from "@/lib/user-ttl-memo";

/**
 * BL-197 (owner, Telegram 2026-10-18, msg 2984): the header's channel (`GET /api/youtube/channel-info`) is read live from
 * YouTube (`channels.list mine`) once per signed-in identity, then answered from this memo for `LIVE_CHANNEL_MEMO_TTL_MS`, instead of on
 * every page load. Only a live answer is ever stored, so the channel it names is still one the identity's own OAuth grant resolved
 * (ADR 0004); a new Google sign-in, a disconnect or a server restart forgets it, and the next call reads live again. Whether the grant
 * still works is checked separately and without YouTube quota (`/api/channel-connections/health`).
 */

export const LIVE_CHANNEL_MEMO_TTL_MS = 6 * 3_600_000;

export type LiveChannelInfo = {
  id: string;
  title: string | null;
  thumbnail: string | null;
  videoCount: string | null;
  subscriberCount: string | null;
};

const memo = createUserTtlMemo<LiveChannelInfo>("youtube-operations-manager.live-channel-memo", LIVE_CHANNEL_MEMO_TTL_MS);

/** The identity's live-read channel while it is younger than the TTL, or null (read live then). */
export function recallLiveChannel(userId: string, now: Date = new Date()): LiveChannelInfo | null {
  return memo.recall(userId, now);
}

/** Taken before a live read; `rememberLiveChannel` drops the answer if the identity was forgotten meanwhile. */
export function liveChannelEpoch(userId: string): number {
  return memo.epoch(userId);
}

export function rememberLiveChannel(userId: string, channel: LiveChannelInfo, epoch: number, now: Date = new Date()): void {
  memo.remember(userId, channel, epoch, now);
}

export function forgetLiveChannel(userId: string): void {
  memo.forget(userId);
}
