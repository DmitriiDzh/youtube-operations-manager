import { useEffect, useState } from "react";

export type VideoLabel = { title: string; thumbnail: string | null };

/** Video id -> title/thumbnail of the channel's synced videos, so tables show names instead of raw ids (BL-120). Empty until loaded or on failure. */
export function useVideoTitles(channelId: string | null): Map<string, VideoLabel> {
  const [labels, setLabels] = useState<Map<string, VideoLabel>>(new Map());

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/videos`);
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { videos?: Array<{ videoId: string; title: string; thumbnails?: Record<string, { url: string }> }> };
        if (cancelled || !Array.isArray(body.videos)) return;
        setLabels(
          new Map(body.videos.map((v) => [v.videoId, { title: v.title, thumbnail: Object.values(v.thumbnails ?? {})[0]?.url ?? null }]))
        );
      } catch {
        // names are a nicety: the table falls back to the video id
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  return labels;
}
