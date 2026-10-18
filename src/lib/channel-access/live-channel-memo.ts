/**
 * BL-197 (owner, Telegram 2026-10-18, msg 2984): the header's channel (`GET /api/youtube/channel-info`) is read live from
 * YouTube (`channels.list mine`) once per signed-in identity, then answered from this memo for `LIVE_CHANNEL_MEMO_TTL_MS`, instead of on
 * every page load. Only a live answer is ever stored, so the channel it names is still one the identity's own OAuth grant resolved
 * (ADR 0004); a new Google sign-in, a disconnect or a server restart forgets it, and the next call reads live again. Whether the grant
 * still works is checked separately and without YouTube quota (`/api/channel-connections/health`).
 *
 * Kept on `globalThis` under a `Symbol.for` key: Next.js bundles route handlers and the auth callbacks separately, and every copy must
 * see the same memo (the BL-116 lesson).
 */

export const LIVE_CHANNEL_MEMO_TTL_MS = 6 * 3_600_000;

export type LiveChannelInfo = {
  id: string;
  title: string | null;
  thumbnail: string | null;
  videoCount: string | null;
  subscriberCount: string | null;
};

type Entry = { channel: LiveChannelInfo; readAt: number };

const KEY = Symbol.for("youtube-operations-manager.live-channel-memo");
type GlobalWithMemo = typeof globalThis & { [KEY]?: Map<string, Entry> };

function entries(): Map<string, Entry> {
  const g = globalThis as GlobalWithMemo;
  return (g[KEY] ??= new Map<string, Entry>());
}

/** The identity's live-read channel while it is younger than the TTL, or null (read live then). */
export function recallLiveChannel(userId: string, now: Date = new Date()): LiveChannelInfo | null {
  const entry = entries().get(userId);
  if (!entry) return null;
  if (now.getTime() - entry.readAt >= LIVE_CHANNEL_MEMO_TTL_MS) {
    entries().delete(userId);
    return null;
  }
  return entry.channel;
}

export function rememberLiveChannel(userId: string, channel: LiveChannelInfo, now: Date = new Date()): void {
  entries().set(userId, { channel, readAt: now.getTime() });
}

export function forgetLiveChannel(userId: string): void {
  entries().delete(userId);
}
