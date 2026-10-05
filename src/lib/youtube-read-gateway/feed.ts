// ---------------------------------------------------------------------------
// Phase 13 slice 13.5 (docs/roadmap/plans/PHASE_13_PLAN.md) -- the YouTube RSS/Atom feed of a
// channel's uploads (https://www.youtube.com/feeds/videos.xml?channel_id=...). Free: no quota, no
// key, no OAuth. A YouTube-family read, so it lives in this gateway like every other one (AGENTS.md
// §G), with its own "reads enabled" toggle and traffic counter, checked here, the single choke point.
// Its data is YouTube data like any other: other people's channels' entries fall under the same
// 30-day retention (`src/lib/youtube-data-policy`).
// ---------------------------------------------------------------------------

import { DomainError } from "@/lib/shared-domain";
import { getYoutubeFeedReadsEnabled, recordGatewayCallOutcome } from "@/lib/db";

export type ChannelFeedVideo = {
  videoId: string;
  title: string;
  publishedAt: string | null;
  /** `media:statistics views` -- `null` when absent, never fabricated. */
  viewCount: number | null;
  /** `media:starRating count` (likes) -- `null` when absent. */
  likeCount: number | null;
};

export async function assertYoutubeFeedReadsAuthorized(): Promise<void> {
  if (await getYoutubeFeedReadsEnabled()) {
    await recordGatewayCallOutcome("youtube_feed_reads", "allowed");
    return;
  }
  await recordGatewayCallOutcome("youtube_feed_reads", "blocked");
  throw new DomainError({
    code: "youtube_feed_reads_disabled",
    message: 'YouTube RSS feed reads are disabled -- the Settings tab\'s "RSS feed reads" toggle is off.',
  });
}

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Pure parser of the feed's Atom XML -- exported for tests. Entries without a video id are skipped. */
export function parseChannelFeed(xml: string): ChannelFeedVideo[] {
  const videos: ChannelFeedVideo[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry)?.[1]?.trim();
    if (!videoId) continue;
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? "";
    videos.push({
      videoId,
      title: decodeXmlEntities(title.trim()),
      publishedAt: /<published>([^<]+)<\/published>/.exec(entry)?.[1]?.trim() ?? null,
      viewCount: parseCount(/<media:statistics[^>]*\sviews="(\d+)"/.exec(entry)?.[1]),
      likeCount: parseCount(/<media:starRating[^>]*\scount="(\d+)"/.exec(entry)?.[1]),
    });
  }
  return videos;
}

/**
 * The newest uploads of a public channel (YouTube serves the latest 15), at zero quota. Throws on a
 * malformed channel id, a disabled toggle, or a non-OK HTTP response -- the caller decides whether
 * to fall back to the quota-spending uploads-playlist path.
 */
export async function listChannelFeedVideos(
  channelId: string,
  fetchImpl: typeof fetch = fetch
): Promise<ChannelFeedVideo[]> {
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new DomainError({ code: "youtube_feed_invalid_channel", message: `Not a YouTube channel id: ${channelId}` });
  }
  await assertYoutubeFeedReadsAuthorized();
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new DomainError({
      code: "youtube_feed_unavailable",
      message: `The channel's RSS feed returned HTTP ${response.status}.`,
    });
  }
  return parseChannelFeed(await response.text());
}
